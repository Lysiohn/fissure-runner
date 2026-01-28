const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, dialog, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const { createWorker } = require('tesseract.js');

let win;
let osdWin;
let scannerWin;
let autoScanInterval = null;
let logCheckInterval = null;
const logPath = path.join(process.env.LOCALAPPDATA, "Warframe", "EE.log");
let lastLogSize = 0;
let pendingScanType = 'normal';
let isScanning = false;
let isScannerPaused = false;
let worker = null;
const MAX_READ_SIZE = 2 * 1024 * 1024; // 2MB
const sharedLogBuffer = Buffer.alloc(MAX_READ_SIZE);

const settingsPath = path.join(app.getPath("userData"), "settings.json");
let settings;

let settingsSaveTimeout;
function saveSettings() {
  if (settingsSaveTimeout) clearTimeout(settingsSaveTimeout);
  settingsSaveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log("Settings saved via debounce.");
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }, 1000);
}

try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch (e) {
  try {
    settings = JSON.parse(fs.readFileSync(path.join(__dirname, "settings.json"), "utf8"));
  } catch (e) {
    settings = {};
  }
}

// Ensure defaults exist
if (!settings.hiddenMissionTypes) settings.hiddenMissionTypes = [];
if (!settings.hiddenTiers) settings.hiddenTiers = [];
if (!settings.hiddenResetTiers) settings.hiddenResetTiers = [];
if (!settings.hiddenVariants) settings.hiddenVariants = [];
if (!settings.scanArea) settings.scanArea = null;
if (!settings.voidCascadeScanArea) settings.voidCascadeScanArea = null;
if (typeof settings.autoScanEnabled === 'undefined') settings.autoScanEnabled = false;
if (typeof settings.useLogScanner === 'undefined') settings.useLogScanner = true;
if (typeof settings.enableLegacyScreenScanner === 'undefined') settings.enableLegacyScreenScanner = false;
if (typeof settings.autoScanPause === 'undefined') settings.autoScanPause = 30;
if (typeof settings.scanIntervalNormal === 'undefined') settings.scanIntervalNormal = 10;
if (typeof settings.scanIntervalCascade === 'undefined') settings.scanIntervalCascade = 5;
if (typeof settings.osdEnabled === 'undefined') settings.osdEnabled = false;
if (!settings.osdPosition) settings.osdPosition = { x: 100, y: 100 };
if (typeof settings.osdOpacity === 'undefined') settings.osdOpacity = 1.0;
if (typeof settings.osdLocked === 'undefined') settings.osdLocked = false;
if (typeof settings.osdScale === 'undefined') settings.osdScale = 1.0;
if (typeof settings.hotkeyEnabled === 'undefined') settings.hotkeyEnabled = true;
if (typeof settings.voidCascadeMode === 'undefined') settings.voidCascadeMode = false;
if (typeof settings.relicName === 'undefined') settings.relicName = "";
if (typeof settings.rotationMode === 'undefined') settings.rotationMode = "4b4";
if (typeof settings.oneByOnePosition === 'undefined') settings.oneByOnePosition = 1;
if (typeof settings.hydrationReminderEnabled === 'undefined') settings.hydrationReminderEnabled = false;
if (typeof settings.hydrationSound === 'undefined') settings.hydrationSound = null;
if (typeof settings.hydrationIntervalMinutes === 'undefined') settings.hydrationIntervalMinutes = 60;
if (typeof settings.hydrationSoundVolume === 'undefined') settings.hydrationSoundVolume = 0.5;
if (!settings.windowBounds) settings.windowBounds = { width: 750, height: 1050 };
if (!settings.ui) settings.ui = {};
if (typeof settings.ui.hotkeySettingsCollapsed === 'undefined') settings.ui.hotkeySettingsCollapsed = false;
if (typeof settings.ui.autoScannerSettingsCollapsed === 'undefined') settings.ui.autoScannerSettingsCollapsed = false;
if (typeof settings.ui.osdSettingsCollapsed === 'undefined') settings.ui.osdSettingsCollapsed = false;
if (typeof settings.ui.generalSettingsCollapsed === 'undefined') settings.ui.generalSettingsCollapsed = false;
if (typeof settings.ui.showScannerPreview === 'undefined') settings.ui.showScannerPreview = true;
if (!settings.layout) settings.layout = null;

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.hotkey || !settings.hotkeyEnabled) return;
  const registered = globalShortcut.register(settings.hotkey, () => {
    win.webContents.send("hotkey-next");
  });

  if (registered) {
    console.log(`Hotkey "${settings.hotkey}" registered successfully.`);
  } else {
    console.error(`Failed to register hotkey "${settings.hotkey}". It might be in use by another application.`);
  }
}

function createWindow() {
  const { width, height, x, y } = settings.windowBounds;
  win = new BrowserWindow({
    width: width || 750,
    height: height || 1050,
    x: x,
    y: y,
    icon: path.join(__dirname, "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  win.loadFile("index.html");
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("load-hotkey", settings.hotkey);
    broadcastScannerStatus();
    // Check for updates after window is loaded to ensure UI listeners are ready
    autoUpdater.checkForUpdates();
  });

  win.on('closed', () => {
    win = null;
    if (osdWin && !osdWin.isDestroyed()) {
      osdWin.close();
    }
  });

  win.on('resized', saveWindowBounds);
  win.on('moved', saveWindowBounds);
}

function saveWindowBounds() {
  if (win) {
    settings.windowBounds = win.getBounds();
    saveSettings();
  }
}

app.whenReady().then(() => {
  createWindow();
  registerHotkey();
  if (settings.osdEnabled) {
    createOSDWindow();
  }

  // Check for updates on start, but don't download automatically
  autoUpdater.autoDownload = false;
  
  // --- Auto Updater Events ---
  autoUpdater.on('checking-for-update', () => {
    if (win) win.webContents.send('update-status', 'Checking for update...');
  });
  autoUpdater.on('update-available', (info) => {
    if (win) win.webContents.send('update-status', 'Update available.');
    if (win) win.webContents.send('update-available', info);
  });
  autoUpdater.on('update-not-available', (info) => {
    if (win) win.webContents.send('update-status', 'You are on the latest version.');
  });
  autoUpdater.on('error', (err) => {
    if (win) win.webContents.send('update-status', 'Error: ' + err.message);
  });
  autoUpdater.on('download-progress', (progressObj) => {
    let log_message = 'Downloading: ' + progressObj.percent.toFixed(0) + '%';
    if (win) win.webContents.send('update-status', log_message);
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (win) win.webContents.send('update-status', 'Update downloaded. Ready to install.');
    if (win) win.webContents.send('update-downloaded');
  });
});

ipcMain.on("set-hotkey", (event, newHotkey) => {
  settings.hotkey = newHotkey;
  saveSettings();
  registerHotkey();
});

ipcMain.on("set-hotkey-enabled", (event, enabled) => {
  settings.hotkeyEnabled = enabled;
  saveSettings();
  registerHotkey();
});

ipcMain.on("set-relic-name", (event, name) => {
  settings.relicName = name;
  saveSettings();
});

ipcMain.on("set-rotation-mode", (event, mode) => {
  settings.rotationMode = mode;
  saveSettings();
});

ipcMain.on("set-1b1-position", (event, pos) => {
  settings.oneByOnePosition = pos;
  saveSettings();
});

ipcMain.on("set-layout", (event, layout) => {
  settings.layout = layout;
  saveSettings();
});

ipcMain.on("set-hydration-reminder-enabled", (event, enabled) => {
  settings.hydrationReminderEnabled = enabled;
  saveSettings();
});

ipcMain.on('set-hydration-interval', (event, minutes) => {
  settings.hydrationIntervalMinutes = minutes;
  saveSettings();
});

ipcMain.handle('select-hydration-sound', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.on('set-hydration-sound', (event, path) => {
  settings.hydrationSound = path;
  saveSettings();
});

ipcMain.on('set-hydration-sound-volume', (event, volume) => {
  settings.hydrationSoundVolume = volume;
  saveSettings();
});

ipcMain.handle('read-hydration-sound', async () => {
  let soundPath = settings.hydrationSound;
  if (!soundPath) {
    soundPath = path.join(__dirname, 'QuackReverb.mp3');
  }

  try {
    if (fs.existsSync(soundPath)) {
      const buffer = fs.readFileSync(soundPath);
      const ext = path.extname(soundPath).toLowerCase().replace('.', '');
      const mime = ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
      return { data: buffer.toString('base64'), mime: mime };
    }
  } catch (e) { console.error(e); }
  return null;
});

ipcMain.handle("get-settings", () => settings);

ipcMain.on("set-filters", (event, data) => {
  settings.hiddenMissionTypes = data.hiddenMissionTypes;
  settings.hiddenTiers = data.hiddenTiers;
  settings.hiddenResetTiers = data.hiddenResetTiers;
  settings.hiddenVariants = data.hiddenVariants;
  saveSettings();
});

ipcMain.on('set-ui-settings', (event, uiSettings) => {
  settings.ui = { ...settings.ui, ...uiSettings };
  saveSettings();
});

ipcMain.on('open-scanner-window', (event, type) => {
  if (scannerWin) {
    scannerWin.focus();
    return;
  }
  pendingScanType = type || 'normal';
  const primaryDisplay = screen.getPrimaryDisplay();
  scannerWin = new BrowserWindow({
    x: primaryDisplay.bounds.x,
    y: primaryDisplay.bounds.y,
    width: primaryDisplay.bounds.width,
    height: primaryDisplay.bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'scanner_preload.js')
    }
  });
  scannerWin.loadFile('scanner.html');
  scannerWin.on('closed', () => {
    scannerWin = null;
  });
});

ipcMain.on('set-scan-area', (event, area) => {
  if (pendingScanType === 'voidCascade') {
    settings.voidCascadeScanArea = area;
  } else {
    settings.scanArea = area;
  }
  saveSettings();
  if (scannerWin) {
    scannerWin.close();
  }
  win.webContents.send('scan-area-updated', {
    normal: settings.scanArea,
    voidCascade: settings.voidCascadeScanArea
  });
  if (settings.autoScanEnabled) {
    startAutoScanner();
  }
});

ipcMain.on('toggle-auto-scan', (event, enabled) => {
  settings.autoScanEnabled = enabled;
  saveSettings();
  if (!enabled) {
    stopAutoScanner();
    isScannerPaused = false;
  }
  broadcastScannerStatus();
});

ipcMain.on('set-log-scanner-mode', (event, enabled) => {
  settings.useLogScanner = enabled;
  saveSettings();
  if (settings.autoScanEnabled) {
    startAutoScanner(); // Restart to switch modes
  }
});

ipcMain.on('set-legacy-screen-scanner', (event, enabled) => {
  settings.enableLegacyScreenScanner = enabled;
  saveSettings();
  // Restart scanner to apply mode change if active
  if (settings.autoScanEnabled) startAutoScanner();
});

ipcMain.on('set-auto-scan-pause', (event, seconds) => {
  settings.autoScanPause = seconds;
  saveSettings();
});

ipcMain.on('set-scan-interval', (event, { type, seconds }) => {
  if (type === 'normal') settings.scanIntervalNormal = seconds;
  if (type === 'cascade') settings.scanIntervalCascade = seconds;
  saveSettings();
  // Restart scanner if active to apply new interval
  if (settings.autoScanEnabled) {
    startAutoScanner();
  }
});

ipcMain.on('set-void-cascade-mode', (event, enabled) => {
  settings.voidCascadeMode = enabled;
  saveSettings();
  if (settings.autoScanEnabled) {
    startAutoScanner();
  }
});

ipcMain.on('set-osd-enabled', (event, enabled) => {
  settings.osdEnabled = enabled;
  saveSettings();
  if (enabled) {
    createOSDWindow();
  } else {
    if (osdWin) osdWin.close();
  }
});

ipcMain.on('set-osd-opacity', (event, opacity) => {
  settings.osdOpacity = opacity;
  saveSettings();
  if (osdWin) {
    osdWin.webContents.send('update-osd-style', { opacity: settings.osdOpacity });
  }
});

ipcMain.on('set-osd-scale', (event, scale) => {
  settings.osdScale = scale;
  saveSettings();
  if (osdWin) {
    const { x, y } = osdWin.getBounds();
    osdWin.webContents.setZoomFactor(scale);
    osdWin.setBounds({ x, y, width: Math.round(220 * scale), height: Math.round(140 * scale) });
    osdWin.setAlwaysOnTop(true, "screen-saver");
  }
});

ipcMain.on('set-osd-locked', (event, locked) => {
  settings.osdLocked = locked;
  saveSettings();
  if (osdWin && !osdWin.isDestroyed()) {
    osdWin.setIgnoreMouseEvents(locked);
  }
});

ipcMain.on('update-osd', (event, data) => {
  if (osdWin && !osdWin.isDestroyed()) {
    osdWin.webContents.send('update-osd-data', data);

    const hideWhenEmpty = settings.ui && settings.ui.hideOSDWhenEmpty;
    if (hideWhenEmpty) {
      const isEmpty = !data.now || data.now === '—' || data.now.trim() === '';
      if (isEmpty) {
        if (osdWin.isVisible()) osdWin.hide();
      } else {
        if (!osdWin.isVisible()) osdWin.showInactive();
      }
    } else {
      if (!osdWin.isVisible()) osdWin.showInactive();
    }
  }

  // Control auto-scanner based on runner state
  if (settings.autoScanEnabled) {
    if (isScannerPaused) {
      return; // Do nothing if in a forced pause
    }
    const isRunning = data.now && data.now !== '—' && data.now.trim() !== '';
    if (isRunning) {
      if (!autoScanInterval && !logCheckInterval) startAutoScanner();
    } else {
      stopAutoScanner();
    }
  }
});

ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});

ipcMain.on('check-for-update', () => {
  autoUpdater.checkForUpdates();
});

ipcMain.on('download-update', () => {
  autoUpdater.downloadUpdate();
});

ipcMain.on('quit-and-install', () => {
  autoUpdater.quitAndInstall();
});

function createOSDWindow() {
  if (osdWin) return;
  osdWin = new BrowserWindow({
    width: Math.round(220 * settings.osdScale),
    height: Math.round(140 * settings.osdScale),
    x: settings.osdPosition.x,
    y: settings.osdPosition.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: !(settings.ui && settings.ui.hideOSDWhenEmpty),
    webPreferences: {
      preload: path.join(__dirname, 'osd_preload.js')
    }
  });
  
  osdWin.setAlwaysOnTop(true, "screen-saver");

  osdWin.webContents.on('did-finish-load', () => {
    osdWin.webContents.setZoomFactor(settings.osdScale);
    osdWin.webContents.send('update-osd-style', { opacity: settings.osdOpacity });
  });

  if (settings.osdLocked) {
    osdWin.setIgnoreMouseEvents(true);
  }

  osdWin.loadFile('osd.html');
  osdWin.on('moved', () => {
    const [x, y] = osdWin.getPosition();
    settings.osdPosition = { x, y };
    saveSettings();
  });
  osdWin.on('closed', () => {
    osdWin = null;
  });
}

function broadcastScannerStatus() {
  if (!win) return;
  let status = 'disabled';
  if (settings.autoScanEnabled) {
    if (isScannerPaused) {
      status = 'paused';
    } else if (autoScanInterval || logCheckInterval) {
      status = 'active';
    } else {
      status = 'idle';
    }
  }
  win.webContents.send('scanner-status-update', status);
}

function stopAutoScanner() {
  if (autoScanInterval) clearInterval(autoScanInterval);
  autoScanInterval = null;

  if (logCheckInterval) clearInterval(logCheckInterval);
  logCheckInterval = null;

  broadcastScannerStatus();
}

async function getScreenCapture(area) {
  if (!area) return null;
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const scaleFactor = primaryDisplay.scaleFactor;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: width * scaleFactor, height: height * scaleFactor }
    });
    const primaryScreenSource = sources.find(source => source.display_id === primaryDisplay.id.toString());
    if (!primaryScreenSource) return null;
    
    const scaledArea = {
      x: Math.round(area.x * scaleFactor),
      y: Math.round(area.y * scaleFactor),
      width: Math.round(area.width * scaleFactor),
      height: Math.round(area.height * scaleFactor)
    };
    return primaryScreenSource.thumbnail.crop(scaledArea);
  } catch (e) {
    console.error("Capture error:", e);
    return null;
  }
}

async function scanScreen() {
  if (isScanning) return;
  isScanning = true;
  const currentArea = settings.voidCascadeMode ? settings.voidCascadeScanArea : settings.scanArea;
  if (!currentArea || !win) {
    isScanning = false;
    return;
  }
  try {
    let image = await getScreenCapture(currentArea);
    if (!image) return;
    
    // Upscale image to improve OCR accuracy
    const size = image.getSize();
    image = image.resize({ width: size.width * 2, height: size.height * 2 });

    if (!worker) {
      worker = await createWorker('eng');
      await worker.setParameters({
        tessedit_pageseg_mode: '7', // Treat image as a single text line
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ', // Only recognize uppercase letters and spaces
      });
    }

    const { data: { text } } = await worker.recognize(image.toPNG());
    const upperText = text.toUpperCase();
    console.log(`[Scanner] ${upperText.replace(/\s+/g, ' ')}`);

    let detected = false;
    const cleanText = upperText.replace(/\s+/g, '');

    if (settings.voidCascadeMode) {
      // Flexible regex to handle OCR errors like "RENE" and "RECHT"
      if (/SELECTA?RE[LCN][IHE][CTE]/.test(cleanText)) detected = true;
    } else if (upperText.includes("MISSION COMPLETE")) {
      detected = true;
    }

    if (detected) {      
      triggerDetection('Visual Scanner', true);
    }
  } catch (error) {
    console.error('Auto-scan error:', error);
  } finally {
    isScanning = false;
  }
}

ipcMain.handle('test-scanner', async () => {
  const currentArea = settings.voidCascadeMode ? settings.voidCascadeScanArea : settings.scanArea;
  console.log('[Test Scanner] Area:', currentArea);
  let image = await getScreenCapture(currentArea);
  if (!image) return { error: "Could not capture screen. Check scan area." };

  // Upscale image to improve OCR accuracy
  const size = image.getSize();
  image = image.resize({ width: size.width * 2, height: size.height * 2 });

  if (!worker) {
    worker = await createWorker('eng');
    await worker.setParameters({
      tessedit_pageseg_mode: '7',
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ',
    });
  }

  const { data: { text } } = await worker.recognize(image.toPNG());
  const upperText = text.toUpperCase();
  const cleanText = upperText.replace(/\s+/g, '');
  console.log('[Test Scanner] Raw:', text.trim(), '| Cleaned:', cleanText);

  let match = false;
  const currentModeIsCascade = settings.voidCascadeMode;
  if (currentModeIsCascade) {
    // Use the same flexible regex as the main scanner
    if (/SELECTA?RE[LCN][IHE][CTE]/.test(cleanText)) match = true;
  } else {
    if (upperText.includes("MISSION COMPLETE")) {
      match = true;
    }
  }

  return { 
    rawText: text.trim(),
    processedText: cleanText,
    match: match,
    mode: currentModeIsCascade ? 'Void Cascade' : 'Normal',
    image: image.toDataURL() 
  };
});

ipcMain.handle('test-log-reader', async () => {
  try {
    if (!fs.existsSync(logPath)) return { success: false, message: "EE.log not found at " + logPath };
    
    const stats = fs.statSync(logPath);
    const readSize = Math.min(stats.size, 1024 * 20); // Read last 20KB
    const buffer = Buffer.alloc(readSize);
    let fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
    fs.closeSync(fd);
    
    const content = buffer.toString('utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim() !== '').slice(-15);
    
    const found = [];
    // Check the whole content for matches to report "Found in last 20KB"
    const allLines = content.split(/\r?\n/);
    for (const line of allLines) {
        if (line.includes('Sys [Info]: Mission Success') || 
            line.includes('MissionSummary.swf') || 
            line.includes('LobbyMissionRewards') ||
            line.includes('OnMissionComplete') ||
            line.includes('EndOfMatch.lua: Mission Succeeded')) {
           if (!found.includes('Mission Success')) found.push('Mission Success');
        }

        if (line.includes('Script [Info]: ProjectionsCountdown.lua: Initialize timer')) {
           if (!found.includes('Relic Selection')) found.push('Relic Selection');
        }
    }
    
    if (found.length > 0) lines.unshift(`--- DEBUG: Found VALID triggers in last 20KB: ${found.join(', ')} ---`);
    else lines.unshift(`--- DEBUG: No VALID triggers found in last 20KB ---`);

    return { success: true, lines: lines, path: logPath };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

function checkLogUpdates() {
  if (isScannerPaused) return;
  
  try {
    if (!fs.existsSync(logPath)) return;

    const stats = fs.statSync(logPath);
    const currentSize = stats.size;

    if (currentSize > lastLogSize) {
      const diff = currentSize - lastLogSize;
      
      let startRead = lastLogSize;
      let bytesToRead = diff;
      
      if (diff > MAX_READ_SIZE) { 
        startRead = currentSize - MAX_READ_SIZE;
        bytesToRead = MAX_READ_SIZE;
      }

      let fd;
      let bytesRead = 0;
      try {
        fd = fs.openSync(logPath, 'r');
        bytesRead = fs.readSync(fd, sharedLogBuffer, 0, bytesToRead, startRead);
      } catch (err) {
        return; // File might be locked, try next tick
      } finally {
        if (fd) fs.closeSync(fd);
      }

      lastLogSize = currentSize;
      const content = sharedLogBuffer.toString('utf8', 0, bytesRead);

      // Optimization: Check content directly instead of splitting into lines
      
      // 1. Mission Failed (Check first for safety)
      if (content.includes('Sys [Info]: Mission Failed')) {
         triggerDetection('Log (Mission Failed)', false);
         return;
      }

      if (settings.voidCascadeMode) {
        if (content.includes('Script [Info]: ProjectionsCountdown.lua: Initialize timer')) {
          triggerDetection('Log (Relic Selection)', true);
          return;
        }
      } else {
        if (content.includes('Sys [Info]: Mission Success') || 
            content.includes('MissionSummary.swf') || 
            content.includes('LobbyMissionRewards') ||
            content.includes('OnMissionComplete') ||
            content.includes('EndOfMatch.lua: Mission Succeeded')) {
          triggerDetection('Log (Mission Success)', true);
          return;
        }
      }
    } else if (currentSize < lastLogSize) {
      // File truncated (game restart), reset pointer
      lastLogSize = currentSize;
    }
  } catch (e) { console.error("Log read error:", e); }
}

function triggerDetection(source, isSuccess = true) {
  stopAutoScanner();
  isScannerPaused = true;
  broadcastScannerStatus();
  console.log(`Target detected via ${source}. Pausing for ${settings.autoScanPause}s.`);
  if (isSuccess) {
    win.webContents.send('mission-complete-detected', settings.autoScanPause);
  }
  setTimeout(() => {
    isScannerPaused = false;
    console.log('Pause finished.');
    broadcastScannerStatus();
    if (win) win.webContents.send('resync-scanner-state');
  }, settings.autoScanPause * 1000);
}

function startAutoScanner() {
  stopAutoScanner();
  
  // Use Log Scanner if enabled OR if Legacy Screen Scanner is disabled (forcing standard mode)
  const useLog = settings.useLogScanner || !settings.enableLegacyScreenScanner;

  if (useLog) {
    // --- LOG MODE ---
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      lastLogSize = stats.size; // Start reading from NOW
      logCheckInterval = setInterval(checkLogUpdates, 1000); // Check every 1s
      broadcastScannerStatus();
      console.log("Started Log Scanner.");
    } else {
      console.error("EE.log not found at", logPath);
    }
  } else {
    // --- VISUAL MODE ---
    const currentArea = settings.voidCascadeMode ? settings.voidCascadeScanArea : settings.scanArea;
    if (currentArea) {
      const interval = settings.voidCascadeMode 
        ? (settings.scanIntervalCascade * 1000) 
        : (settings.scanIntervalNormal * 1000);
      autoScanInterval = setInterval(scanScreen, interval);
      broadcastScannerStatus();
    }
  }
}

let solNodeCache = null;
const TIER_MAPPING = {
  'VoidT1': 'Lith',
  'VoidT2': 'Meso',
  'VoidT3': 'Neo',
  'VoidT4': 'Axi',
  'VoidT5': 'Requiem',
  'VoidT6': 'Omnia'
};

async function getSolNodes() {
  if (solNodeCache) return solNodeCache;
  try {
    const res = await fetch('https://raw.githubusercontent.com/WFCD/warframe-worldstate-data/master/data/solNodes.json');
    if (res.ok) {
      solNodeCache = await res.json();
      return solNodeCache;
    }
  } catch (e) { console.error("Failed to fetch solNodes:", e); }
  return {};
}

ipcMain.handle("get-fissures", async () => {
  // Helper function for fetching
  const fetchData = async (url) => {
    // Add timestamp to prevent caching
    const separator = url.includes('?') ? '&' : '?';
    const bustedUrl = `${url}${separator}t=${Date.now()}`;

    const response = await fetch(bustedUrl, {
      headers: { 
        "User-Agent": "FissureRunner", 
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  };

  // 1. Try Official Raw Endpoint (api.warframe.com)
  try {
    console.log("[API] Attempting official raw endpoint (content.warframe.com)...");
    // Use content.warframe.com directly to avoid 409 errors from cache-busting params on the CDN
    const rawResponse = await fetch('https://content.warframe.com/dynamic/worldState.php', { 
      headers: { 
        "User-Agent": "FissureRunner",
        "Cache-Control": "no-cache"
      } 
    });
    if (!rawResponse.ok) throw new Error(`HTTP ${rawResponse.status}`);
    const rawData = await rawResponse.json();
    const solNodes = await getSolNodes();
    const fissures = [];

    // Parse ActiveMissions (Normal Fissures)
    if (rawData.ActiveMissions) {
      rawData.ActiveMissions.forEach(m => {
        const tier = TIER_MAPPING[m.Modifier];
        if (!tier) return;
        
        const nodeData = solNodes[m.Node] || { value: m.Node, type: 'Unknown', enemy: 'Unknown' };
        // Handle MongoDB extended JSON date format
        const expiryMs = m.Expiry && m.Expiry.$date ? (m.Expiry.$date.$numberLong || m.Expiry.$date) : Date.now();
        const expiry = new Date(parseInt(expiryMs)).toISOString();
        
        const fissure = {
          node: nodeData.value,
          missionType: nodeData.type,
          enemy: nodeData.enemy,
          tier: tier,
          tierNum: parseInt(m.Modifier.replace('VoidT', '')),
          expiry: expiry,
          isHard: m.Hard || false, // Use the 'Hard' property from the raw data
          isStorm: false
        };
        fissures.push(fissure);
      });
    }

    if (fissures.length > 0) return fissures;
    throw new Error("Raw endpoint returned no fissures.");
  } catch (e) {
    console.warn(`[API] Raw endpoint failed: ${e.message}. Trying fallbacks...`);
  }

  // 2. Try specific fissures endpoint (2 attempts)
  for (let i = 0; i < 2; i++) {
    try {
      return await fetchData('https://api.warframestat.us/pc/fissures');
    } catch (e) {
      console.warn(`[API] Official fissures endpoint failed (attempt ${i+1}): ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 3. Try fallback to full worldstate (1 attempt)
  try {
    console.log("[API] Primary endpoint failed (502/Network). Attempting fallback to worldstate...");
    const data = await fetchData('https://api.warframestat.us/pc');
    return data.fissures || [];
  } catch (e) {
    // Continue to proxy
  }

  // 4. Try Proxy Fallback 1 (allorigins)
  try {
    console.log("[API] Direct connection failed. Attempting via backup proxy 1 (allorigins)...");
    // Add timestamp to target URL to bust upstream cache
    const targetUrl = `https://api.warframestat.us/pc/fissures?t=${Date.now()}`;
    // Add timestamp to proxy URL to bust local/proxy cache
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}&rand=${Date.now()}`;
    const response = await fetch(proxyUrl, { headers: { "Cache-Control": "no-cache" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    // Sanity check: if data is old, throw error to try next proxy
    if (Array.isArray(data) && data.length > 0) {
      const maxExpiry = data.reduce((max, f) => {
        const fExpiry = new Date(f.expiry).getTime();
        return fExpiry > max ? fExpiry : max;
      }, 0);
      // If the latest fissure expired more than 1 hour ago, data is likely stale.
      if (Date.now() - maxExpiry > 3600000) { // 1 hour in ms
        throw new Error("Proxy 1 returned stale data (latest fissure expired >1hr ago).");
      }
    }
    return data;
  } catch (e) {
    console.warn(`[API] Proxy 1 failed: ${e.message}. Trying next proxy.`);
  }

  // 5. Try Proxy Fallback 2 (bridged.cc)
  try {
    console.log("[API] Attempting via backup proxy 2 (cors.bridged.cc)...");
    const proxyUrl = `https://cors.bridged.cc/https://api.warframestat.us/pc/fissures?t=${Date.now()}`;
    const response = await fetch(proxyUrl, { headers: { "Cache-Control": "no-cache" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (e) {
    console.warn(`[API] All fetch attempts failed. Last error: ${e.message}`);
    return null;
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
