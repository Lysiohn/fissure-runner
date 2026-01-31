const { app, BrowserWindow, ipcMain, screen, dialog, shell, Tray, Menu, globalShortcut } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");

// Linux Transparency Fixes
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-transparent-visuals");
  app.commandLine.appendSwitch("disable-gpu");
}

let win;
let osdWin;
let tray = null;
let isQuitting = false;
let autoScanInterval = null;
let logCheckInterval = null;
let hydrationTimer = null;

let logPath;
if (process.platform === "linux") {
  const home = process.env.HOME || "";
  const paths = [
    path.join(home, ".steam/steam/steamapps/compatdata/230410/pfx/drive_c/users/steamuser/AppData/Local/Warframe/EE.log"),
    path.join(home, ".local/share/Steam/steamapps/compatdata/230410/pfx/drive_c/users/steamuser/AppData/Local/Warframe/EE.log"),
    path.join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/compatdata/230410/pfx/drive_c/users/steamuser/AppData/Local/Warframe/EE.log")
  ];
  logPath = paths.find(p => fs.existsSync(p)) || paths[0];
} else {
  logPath = path.join(process.env.LOCALAPPDATA || "", "Warframe", "EE.log");
}

let lastLogSize = 0;
let isScannerPaused = false;
let localPlayerId = null;
const MAX_READ_SIZE = 2 * 1024 * 1024; // 2MB
const sharedLogBuffer = Buffer.alloc(MAX_READ_SIZE);
const OVERLAP_SIZE = 4096; // Increased overlap to catch split keywords

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
if (typeof settings.autoScanEnabled === 'undefined') settings.autoScanEnabled = false;
if (typeof settings.autoScanPause === 'undefined') settings.autoScanPause = 30;
if (typeof settings.osdEnabled === 'undefined') settings.osdEnabled = false;
if (!settings.osdPosition) settings.osdPosition = { x: 100, y: 100 };
if (typeof settings.osdOpacity === 'undefined') settings.osdOpacity = 1.0;
if (typeof settings.osdLocked === 'undefined') settings.osdLocked = false;
if (typeof settings.osdScale === 'undefined') settings.osdScale = 1.0;
if (typeof settings.hotkeyEnabled === 'undefined') settings.hotkeyEnabled = true;

// Initialize Keybinds
if (!settings.keybinds) settings.keybinds = {};
if (!settings.globalKeybinds) settings.globalKeybinds = {};
// Migrate legacy hotkey
if (settings.hotkey && settings.keybinds.next === undefined) {
  settings.keybinds.next = settings.hotkey;
  // Legacy hotkey was global, so preserve that behavior
  settings.globalKeybinds.next = true;
  delete settings.hotkey;
  saveSettings();
}
// Ensure defaults
if (typeof settings.keybinds.next === 'undefined') settings.keybinds.next = "Right";
const optionalKeybinds = ['start', 'reset', 'cascade', 'mode4b4', 'mode2b2', 'mode1b1'];
optionalKeybinds.forEach(k => { if (typeof settings.keybinds[k] === 'undefined') settings.keybinds[k] = ""; });

if (typeof settings.voidCascadeMode === 'undefined') settings.voidCascadeMode = false;
if (typeof settings.relicName === 'undefined') settings.relicName = "";
if (typeof settings.rotationMode === 'undefined') settings.rotationMode = "4b4";
if (typeof settings.oneByOnePosition === 'undefined') settings.oneByOnePosition = 1;
if (typeof settings.hydrationReminderEnabled === 'undefined') settings.hydrationReminderEnabled = false;
if (typeof settings.hydrationSound === 'undefined') settings.hydrationSound = null;
if (typeof settings.hydrationIntervalMinutes === 'undefined') settings.hydrationIntervalMinutes = 60;
if (typeof settings.hydrationSoundVolume === 'undefined') settings.hydrationSoundVolume = 0.5;
if (typeof settings.nextSoundEnabled === 'undefined') settings.nextSoundEnabled = false;
if (typeof settings.nextSound === 'undefined') settings.nextSound = null;
if (typeof settings.nextSoundVolume === 'undefined') settings.nextSoundVolume = 0.5;
if (typeof settings.fissureSoundEnabled === 'undefined') settings.fissureSoundEnabled = false;
if (typeof settings.fissureSound === 'undefined') settings.fissureSound = null;
if (typeof settings.fissureSoundVolume === 'undefined') settings.fissureSoundVolume = 0.5;
if (!settings.windowBounds) settings.windowBounds = { width: 750, height: 1050 };
if (!settings.ui) settings.ui = {};
if (typeof settings.ui.hotkeySettingsCollapsed === 'undefined') settings.ui.hotkeySettingsCollapsed = false;
if (typeof settings.ui.autoScannerSettingsCollapsed === 'undefined') settings.ui.autoScannerSettingsCollapsed = false;
if (typeof settings.ui.osdSettingsCollapsed === 'undefined') settings.ui.osdSettingsCollapsed = false;
if (typeof settings.ui.generalSettingsCollapsed === 'undefined') settings.ui.generalSettingsCollapsed = false;
if (typeof settings.ui.showScannerPreview === 'undefined') settings.ui.showScannerPreview = true;
if (typeof settings.autoRelicEnabled === 'undefined') settings.autoRelicEnabled = false;
if (!settings.layout) settings.layout = null;
if (typeof settings.closeToTray === 'undefined') settings.closeToTray = false;
if (typeof settings.alwaysOnTop === 'undefined') settings.alwaysOnTop = false;
if (typeof settings.osdShowClock === 'undefined') settings.osdShowClock = false;
if (typeof settings.osdHydrationNotify === 'undefined') settings.osdHydrationNotify = false;
if (typeof settings.osdHideBorder === 'undefined') settings.osdHideBorder = false;
if (typeof settings.hydrationTheme === 'undefined') settings.hydrationTheme = 'rainbow';
if (typeof settings.hydrationMessage === 'undefined') settings.hydrationMessage = "HYDRATE OR DIE STRAIGHT!";
if (typeof settings.flagTheme === 'undefined') settings.flagTheme = 'rainbow';
if (typeof settings.flagEnabled === 'undefined') settings.flagEnabled = false;
if (typeof settings.runAtStartup === 'undefined') settings.runAtStartup = false;
if (typeof settings.startMinimized === 'undefined') settings.startMinimized = false;
if (typeof settings.flagPosition === 'undefined') settings.flagPosition = 'left';

function updateHydrationTimer() {
  if (hydrationTimer) clearInterval(hydrationTimer);
  hydrationTimer = null;

  if (settings.hydrationReminderEnabled) {
    const minutes = settings.hydrationIntervalMinutes || 60;
    const intervalMs = minutes * 60 * 1000;
    if (intervalMs > 0) {
      hydrationTimer = setInterval(() => {
        if (win) win.webContents.send('trigger-hydration');
      }, intervalMs);
    }
  }
}

function registerGlobalHotkeys() {
  globalShortcut.unregisterAll();
  if (!settings.hotkeyEnabled) return;

  for (const [action, key] of Object.entries(settings.keybinds)) {
    if (key && settings.globalKeybinds && settings.globalKeybinds[action]) {
      try {
        globalShortcut.register(key, () => {
          if (win) win.webContents.send('trigger-action', action);
        });
      } catch (e) { console.error(`Failed to register global hotkey ${key}:`, e); }
    }
  }
}

function updateLoginSettings() {
  app.setLoginItemSettings({
    openAtLogin: settings.runAtStartup,
    args: settings.startMinimized ? ['--hidden'] : []
  });
}

function createWindow() {
  const { width, height, x, y } = settings.windowBounds;
  const startHidden = process.argv.includes('--hidden');

  win = new BrowserWindow({
    width: width || 750,
    height: height || 1050,
    x: x,
    y: y,
    icon: path.join(__dirname, "icon.ico"),
    alwaysOnTop: settings.alwaysOnTop,
    autoHideMenuBar: true,
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  win.loadFile("index.html");
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("load-keybinds", { keybinds: settings.keybinds, globalKeybinds: settings.globalKeybinds });
    broadcastScannerStatus();
    // Check for updates after window is loaded to ensure UI listeners are ready
    autoUpdater.checkForUpdates();
  });

  win.on('closed', () => {
    // If closeToTray is enabled and we are not quitting via context menu/app, hide instead
    if (settings.closeToTray && !isQuitting) {
       // This logic is actually handled in the 'close' event usually, but 'closed' is too late to prevent.
       // We need to listen to 'close' event on the window instance.
    }
    win = null;
    if (osdWin && !osdWin.isDestroyed()) {
      osdWin.close();
    }
  });

  win.on('resized', saveWindowBounds);
  win.on('moved', saveWindowBounds);
  
  win.on('close', (event) => {
    if (settings.closeToTray && !isQuitting) {
      event.preventDefault();
      win.hide();
      return false;
    }
  });
}

function saveWindowBounds() {
  if (win) {
    settings.windowBounds = win.getBounds();
    saveSettings();
  }
}

app.whenReady().then(() => {
  createWindow();
  registerGlobalHotkeys();
  updateHydrationTimer();
  
  // Sync startup setting
  updateLoginSettings();

  if (settings.osdEnabled) {
    createOSDWindow();
  }
  
  const startHidden = process.argv.includes('--hidden');
  if (settings.closeToTray || startHidden) createTray();

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

app.on('before-quit', () => {
  isQuitting = true;
});

ipcMain.on("set-keybind", (event, { action, key, isGlobal }) => {
  if (!settings.keybinds) settings.keybinds = {};
  if (!settings.globalKeybinds) settings.globalKeybinds = {};
  
  if (key !== undefined) settings.keybinds[action] = key;
  if (isGlobal !== undefined) settings.globalKeybinds[action] = isGlobal;
  
  saveSettings();
  registerGlobalHotkeys();
});

ipcMain.on("set-hotkey-enabled", (event, enabled) => {
  settings.hotkeyEnabled = enabled;
  saveSettings();
  registerGlobalHotkeys();
});

ipcMain.on("set-relic-name", (event, name) => {
  settings.relicName = name;
  saveSettings();
});

ipcMain.on("set-auto-relic-enabled", (event, enabled) => {
  settings.autoRelicEnabled = enabled;
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
  updateHydrationTimer();
});

ipcMain.on('set-hydration-interval', (event, minutes) => {
  settings.hydrationIntervalMinutes = minutes;
  saveSettings();
  updateHydrationTimer();
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

ipcMain.on('set-next-sound-enabled', (event, enabled) => {
  settings.nextSoundEnabled = enabled;
  saveSettings();
});

ipcMain.on('set-next-sound', (event, path) => {
  settings.nextSound = path;
  saveSettings();
});

ipcMain.on('set-next-sound-volume', (event, volume) => {
  settings.nextSoundVolume = volume;
  saveSettings();
});

ipcMain.handle('read-next-sound', async () => {
  if (settings.nextSound && fs.existsSync(settings.nextSound)) {
    try {
      const buffer = fs.readFileSync(settings.nextSound);
      const ext = path.extname(settings.nextSound).toLowerCase().replace('.', '');
      const mime = ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
      return { data: buffer.toString('base64'), mime: mime };
    } catch (e) { console.error(e); }
  }
  // Default: "Pling" - High pitch, short, soft decay
  const buffer = createWavBuffer([{ freq: 1046.5, duration: 150 }]);
  return { data: buffer.toString('base64'), mime: 'audio/wav' };
});

ipcMain.on('set-fissure-sound-enabled', (event, enabled) => {
  settings.fissureSoundEnabled = enabled;
  saveSettings();
});

ipcMain.on('set-fissure-sound', (event, path) => {
  settings.fissureSound = path;
  saveSettings();
});

ipcMain.on('set-fissure-sound-volume', (event, volume) => {
  settings.fissureSoundVolume = volume;
  saveSettings();
});

ipcMain.handle('read-fissure-sound', async () => {
  if (settings.fissureSound && fs.existsSync(settings.fissureSound)) {
    try {
      const buffer = fs.readFileSync(settings.fissureSound);
      const ext = path.extname(settings.fissureSound).toLowerCase().replace('.', '');
      const mime = ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
      return { data: buffer.toString('base64'), mime: mime };
    } catch (e) { console.error(e); }
  }
  // Default: "Badding" - Two tones rising (C5 -> G5)
  const buffer = createWavBuffer([
    { freq: 523.25, duration: 80 },
    { freq: 783.99, duration: 200 }
  ]);
  return { data: buffer.toString('base64'), mime: 'audio/wav' };
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

ipcMain.on('set-close-to-tray', (event, enabled) => {
  settings.closeToTray = enabled;
  saveSettings();
  if (enabled) {
    createTray();
  } else if (tray) {
    tray.destroy();
    tray = null;
  }
});

ipcMain.on('set-run-at-startup', (event, enabled) => {
  settings.runAtStartup = enabled;
  saveSettings();
  updateLoginSettings();
});

ipcMain.on('set-start-minimized', (event, enabled) => {
  settings.startMinimized = enabled;
  saveSettings();
  updateLoginSettings();
});

ipcMain.on('set-always-on-top', (event, enabled) => {
  settings.alwaysOnTop = enabled;
  saveSettings();
  if (win) win.setAlwaysOnTop(enabled, enabled ? 'screen-saver' : 'normal');
});

ipcMain.on('set-osd-show-clock', (event, enabled) => {
  settings.osdShowClock = enabled;
  saveSettings();
});

ipcMain.on('set-osd-hydration-notify', (event, enabled) => {
  settings.osdHydrationNotify = enabled;
  saveSettings();
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
  if (osdWin && !osdWin.isDestroyed()) {
    osdWin.webContents.send('update-osd-style', { 
      opacity: settings.osdOpacity,
      locked: settings.osdLocked,
      hideBorder: settings.osdHideBorder,
      hydrationTheme: settings.hydrationTheme,
      hydrationMessage: settings.hydrationMessage
    });
  }
});

ipcMain.on('set-osd-hide-border', (event, hide) => {
  settings.osdHideBorder = hide;
  saveSettings();
  if (osdWin && !osdWin.isDestroyed()) {
    osdWin.webContents.send('update-osd-style', { 
      opacity: settings.osdOpacity,
      locked: settings.osdLocked,
      hideBorder: settings.osdHideBorder,
      hydrationTheme: settings.hydrationTheme,
      hydrationMessage: settings.hydrationMessage
    });
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
    osdWin.webContents.send('update-osd-style', { 
      opacity: settings.osdOpacity,
      locked: settings.osdLocked,
      hideBorder: settings.osdHideBorder,
      hydrationTheme: settings.hydrationTheme,
      hydrationMessage: settings.hydrationMessage
    });
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

ipcMain.on('set-hydration-theme', (event, theme) => {
  settings.hydrationTheme = theme;
  saveSettings();
  if (osdWin && !osdWin.isDestroyed()) {
    osdWin.webContents.send('update-osd-style', { 
      hydrationTheme: settings.hydrationTheme
    });
  }
});

ipcMain.on('set-hydration-message', (event, message) => {
  settings.hydrationMessage = message;
  saveSettings();
  if (osdWin && !osdWin.isDestroyed()) {
    osdWin.webContents.send('update-osd-style', { 
      hydrationMessage: settings.hydrationMessage
    });
  }
});

ipcMain.on('set-flag-enabled', (event, enabled) => {
  settings.flagEnabled = enabled;
  saveSettings();
});

ipcMain.on('set-flag-theme', (event, theme) => {
  settings.flagTheme = theme;
  saveSettings();
});

ipcMain.on('set-flag-position', (event, position) => {
  settings.flagPosition = position;
  saveSettings();
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
    type: 'utility', // Helps Linux WMs treat this as a floating tool
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });
  
  osdWin.setAlwaysOnTop(true, "screen-saver");

  osdWin.webContents.on('did-finish-load', () => {
    osdWin.webContents.setZoomFactor(settings.osdScale);
    osdWin.webContents.send('update-osd-style', { 
      opacity: settings.osdOpacity,
      locked: settings.osdLocked,
      hideBorder: settings.osdHideBorder,
      hydrationTheme: settings.hydrationTheme,
      hydrationMessage: settings.hydrationMessage
    });
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

ipcMain.on('osd-drag', (event, { x, y }) => {
  if (osdWin && !osdWin.isDestroyed()) {
    osdWin.setPosition(Math.round(x), Math.round(y));
  }
});

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, "icon.ico");
  if (!fs.existsSync(iconPath)) return;
  
  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => win.show() },
    { type: 'separator' },
    { 
      label: 'Hydration Reminder',
      type: 'checkbox',
      checked: settings.hydrationReminderEnabled,
      click: (menuItem) => {
        settings.hydrationReminderEnabled = menuItem.checked;
        saveSettings();
        updateHydrationTimer();
        if (win) win.webContents.send('hydration-state-changed', menuItem.checked);
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => {
      isQuitting = true;
      app.quit();
    }}
  ]);
  tray.setToolTip('Fissure Runner');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (win.isVisible()) win.hide();
    else win.show();
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

// Pre-compile Regex to avoid recreation every tick
const RELIC_DIALOG_REGEX = /Dialog::CreateOkCancel\(description=Are you sure you want to equip (.+?) Relic(?: \[(.+?)\])?/gi;
const LOGIN_REGEX = /Logged in .* \((.+?)\)/;

function findLocalPlayerId() {
  try {
    if (!fs.existsSync(logPath)) return;
    const stats = fs.statSync(logPath);
    // Read last 2MB of the log to find the player ID. Should be more than enough and memory-efficient.
    const readSize = Math.min(stats.size, 2 * 1024 * 1024); 
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
    fs.closeSync(fd);

    const content = buffer.toString('utf8');
    const matches = [...content.matchAll(/Logged in .* \((.+?)\)/g)];
    if (matches.length > 0) {
      localPlayerId = matches[matches.length - 1][1];
      console.log("Found Local Player ID from existing log:", localPlayerId);
    }
  } catch (e) { console.error("Error finding player ID:", e); }
}

function findInitialState() {
  try {
    // This function is a stub now. It previously read the log for initial state (like traces).
    // It's kept in case we need to find other initial states from the log in the future.
  } catch (e) { console.error("Error finding initial state:", e); }
}

function checkLogUpdates() {
  if (isScannerPaused) return;
  
  try {
    if (!fs.existsSync(logPath)) return;

    const stats = fs.statSync(logPath);
    const currentSize = stats.size;

    if (currentSize > lastLogSize) {
      // Calculate read range with overlap to handle split lines
      let startRead = Math.max(0, lastLogSize - OVERLAP_SIZE);
      let bytesToRead = currentSize - startRead;
      
      // Cap at buffer size, prioritizing recent data
      if (bytesToRead > MAX_READ_SIZE) { 
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

      // Calculate the boundary index in the buffer where new data begins
      // Any match fully before this index is "old" data we re-read for context
      const newContentStartIndex = lastLogSize - startRead;
      lastLogSize = currentSize;
      
      const content = sharedLogBuffer.toString('utf8', 0, bytesRead);

      // Helper to check if a keyword exists in the NEW data (or crosses boundary)
      const hasNewMatch = (keyword) => {
        const lastIndex = content.lastIndexOf(keyword);
        if (lastIndex === -1) return false;
        // If the match ends after the new content started, it's valid
        return (lastIndex + keyword.length > newContentStartIndex);
      };

      // --- Run Summary: Detect Player ID & Rewards ---
      const loginMatch = LOGIN_REGEX.exec(content);
      if (loginMatch) {
        localPlayerId = loginMatch[1];
      }

      // --- Auto Relic Detection ---
      if (settings.autoRelicEnabled) {
        // Use the confirmation dialog to detect the active relic (Specific to local player)
        // Example: Dialog::CreateOkCancel(description=Are you sure you want to equip Lith C5 Relic [FLAWLESS]...
        let match;
        let lastFound = null;
        RELIC_DIALOG_REGEX.lastIndex = 0;
        while ((match = RELIC_DIALOG_REGEX.exec(content)) !== null) {
          lastFound = match;
        }
        if (lastFound && lastFound[1]) {
          // Only update if this match is new/crossing boundary
          if (lastFound.index + lastFound[0].length > newContentStartIndex) {
            let relicName = lastFound[1].trim();
            let rarity = lastFound[2] ? lastFound[2].trim() : 'INTACT';
            rarity = rarity.charAt(0).toUpperCase() + rarity.slice(1).toLowerCase();
            
            if (win) win.webContents.send('detected-relic', `${relicName} ${rarity}`);
          }
        }
      }

      // Optimization: Check content directly instead of splitting into lines
      
      // 1. Mission Failed (Check first for safety)
      if (hasNewMatch('Sys [Info]: Mission Failed')) {
         triggerDetection('Log (Mission Failed)', false);
         return;
      }

      if (settings.voidCascadeMode) {
        if (hasNewMatch('Script [Info]: ProjectionsCountdown.lua: Initialize timer')) {
          triggerDetection('Log (Relic Selection)', true);
          return;
        }
      } else {
        if (hasNewMatch('Sys [Info]: Mission Success') || 
            hasNewMatch('MissionSummary.swf') || 
            hasNewMatch('LobbyMissionRewards') ||
            hasNewMatch('OnMissionComplete') ||
            hasNewMatch('EndOfMatch.lua: Mission Succeeded') ||
            hasNewMatch('CGame::SetMissionState: STATE_COMPLETE') ||
            hasNewMatch('Distributor::CompleteMission')) {
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

function stopAutoScanner() {
  if (autoScanInterval) clearInterval(autoScanInterval);
  autoScanInterval = null;

  if (logCheckInterval) clearInterval(logCheckInterval);
  logCheckInterval = null;

  broadcastScannerStatus();
}

function startAutoScanner() {
  stopAutoScanner();
  
  // Auto-scanner now exclusively uses the log reader.
  if (fs.existsSync(logPath)) {
    const stats = fs.statSync(logPath);
    lastLogSize = stats.size; // Start reading from NOW
    logCheckInterval = setInterval(checkLogUpdates, 1000); // Check every 1s
    broadcastScannerStatus();
    console.log("Started Log Scanner.");

    // Attempt to find player ID if not already known
    if (!localPlayerId) findLocalPlayerId();
    findInitialState();
  } else {
    console.error("EE.log not found at", logPath);
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

// Helper to generate simple beep sounds (WAV format)
function createWavBuffer(notes) {
  if (!Array.isArray(notes)) notes = [notes];
  const sampleRate = 44100;
  let totalSamples = 0;
  for (const note of notes) {
    totalSamples += Math.floor((sampleRate * note.duration) / 1000);
  }

  const bytesPerSample = 2;
  const numChannels = 1;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = totalSamples * blockAlign;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF chunk
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;

  for (const note of notes) {
    const numSamples = Math.floor((sampleRate * note.duration) / 1000);
    const attackSamples = Math.min(numSamples * 0.1, 441); // 10ms attack max

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const angle = t * note.freq * 2 * Math.PI;
      
      // Soft Envelope (Attack -> Quadratic Decay)
      let vol = 1.0;
      if (i < attackSamples) {
        vol = i / attackSamples;
      } else {
        const progress = (i - attackSamples) / (numSamples - attackSamples);
        vol = Math.pow(1 - progress, 2);
      }
      
      const sample = Math.sin(angle);
      const val = Math.max(-32768, Math.min(32767, sample * vol * 32767));
      buffer.writeInt16LE(val, offset);
      offset += 2;
    }
  }
  return buffer;
}
