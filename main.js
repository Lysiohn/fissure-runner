const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, dialog, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const { createWorker } = require('tesseract.js');

let win;
let osdWin;
let scannerWin;
let autoScanInterval = null;
let pendingScanType = 'normal';
let isScanning = false;
let worker = null;

const settingsPath = path.join(app.getPath("userData"), "settings.json");
let settings;

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
if (typeof settings.showRailjack === 'undefined') settings.showRailjack = false;
if (!settings.scanArea) settings.scanArea = null;
if (!settings.voidCascadeScanArea) settings.voidCascadeScanArea = null;
if (typeof settings.autoScanEnabled === 'undefined') settings.autoScanEnabled = false;
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
  win.webContents.on("did-finish-load", () => { win.webContents.send("load-hotkey", settings.hotkey); });

  win.on('closed', () => {
    win = null;
    if (osdWin && !osdWin.isDestroyed()) {
      osdWin.close();
    }
  });

  win.on('resized', saveWindowBounds);
  win.on('moved', saveWindowBounds);
}

let saveBoundsTimeout;
function saveWindowBounds() {
  if (saveBoundsTimeout) clearTimeout(saveBoundsTimeout);
  saveBoundsTimeout = setTimeout(() => {
    if (win) {
      settings.windowBounds = win.getBounds();
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  }, 1000);
}

app.whenReady().then(() => {
  createWindow();
  registerHotkey();
  if (settings.autoScanEnabled && settings.scanArea) {
    startAutoScanner();
  }
  if (settings.osdEnabled) {
    createOSDWindow();
  }

  // Check for updates on start, but don't download automatically
  autoUpdater.autoDownload = false;
  autoUpdater.checkForUpdates();
  
  // --- Auto Updater Events ---
  autoUpdater.on('checking-for-update', () => {
    if (win) win.webContents.send('update-status', 'Checking for update...');
  });
  autoUpdater.on('update-available', (info) => {
    if (win) win.webContents.send('update-status', 'Update available. Downloading...');
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
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  registerHotkey();
});

ipcMain.on("set-hotkey-enabled", (event, enabled) => {
  settings.hotkeyEnabled = enabled;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  registerHotkey();
});

ipcMain.on("set-relic-name", (event, name) => {
  settings.relicName = name;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.on("set-rotation-mode", (event, mode) => {
  settings.rotationMode = mode;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.on("set-layout", (event, layout) => {
  settings.layout = layout;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.on("set-hydration-reminder-enabled", (event, enabled) => {
  settings.hydrationReminderEnabled = enabled;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.on('set-hydration-interval', (event, minutes) => {
  settings.hydrationIntervalMinutes = minutes;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.on('set-hydration-sound-volume', (event, volume) => {
  settings.hydrationSoundVolume = volume;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
  settings.showRailjack = data.showRailjack;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.on('set-ui-settings', (event, uiSettings) => {
  settings.ui = { ...settings.ui, ...uiSettings };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  if (enabled) {
    startAutoScanner();
  } else {
    stopAutoScanner();
  }
});

ipcMain.on('set-auto-scan-pause', (event, seconds) => {
  settings.autoScanPause = seconds;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
});

ipcMain.on('set-scan-interval', (event, { type, seconds }) => {
  if (type === 'normal') settings.scanIntervalNormal = seconds;
  if (type === 'cascade') settings.scanIntervalCascade = seconds;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  // Restart scanner if active to apply new interval
  if (settings.autoScanEnabled) {
    startAutoScanner();
  }
});

ipcMain.on('set-void-cascade-mode', (event, enabled) => {
  settings.voidCascadeMode = enabled;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  if (settings.autoScanEnabled) {
    startAutoScanner();
  }
});

ipcMain.on('set-osd-enabled', (event, enabled) => {
  settings.osdEnabled = enabled;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  if (enabled) {
    createOSDWindow();
  } else {
    if (osdWin) osdWin.close();
  }
});

ipcMain.on('set-osd-opacity', (event, opacity) => {
  settings.osdOpacity = opacity;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  if (osdWin) {
    osdWin.webContents.send('update-osd-style', { opacity: settings.osdOpacity });
  }
});

ipcMain.on('set-osd-scale', (event, scale) => {
  settings.osdScale = scale;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  if (osdWin) {
    const { x, y } = osdWin.getBounds();
    osdWin.webContents.setZoomFactor(scale);
    osdWin.setBounds({ x, y, width: Math.round(220 * scale), height: Math.round(140 * scale) });
    osdWin.setAlwaysOnTop(true, "screen-saver");
  }
});

ipcMain.on('set-osd-locked', (event, locked) => {
  settings.osdLocked = locked;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  });
  osdWin.on('closed', () => {
    osdWin = null;
  });
}

function stopAutoScanner() {
  if (autoScanInterval) clearInterval(autoScanInterval);
  autoScanInterval = null;
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
      stopAutoScanner();
      console.log(`Target detected. Pausing scanner for ${settings.autoScanPause} seconds.`);
      win.webContents.send('mission-complete-detected');      
      setTimeout(() => {
        if (settings.autoScanEnabled) startAutoScanner();
      }, settings.autoScanPause * 1000);
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

function startAutoScanner() {
  stopAutoScanner();
  const currentArea = settings.voidCascadeMode ? settings.voidCascadeScanArea : settings.scanArea;
  if (currentArea) {
    const interval = settings.voidCascadeMode 
      ? (settings.scanIntervalCascade * 1000) 
      : (settings.scanIntervalNormal * 1000);
    autoScanInterval = setInterval(scanScreen, interval);
  }
}

ipcMain.handle("get-fissures", async () => {
  try {
    const response = await fetch(`https://api.warframestat.us/pc/fissures?t=${Date.now()}`, {
      headers: { "User-Agent": "FissureRunner" }
    });
    if (!response.ok) throw new Error("Network response was not ok");
    return await response.json();
  } catch (error) {
    console.error("Failed to fetch fissures:", error);
    throw error;
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
