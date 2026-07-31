'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  shell
} = require('electron');
const { autoUpdater } = require('electron-updater');
const { SettingsStore } = require('./core/settings');
const { MicrosoftAuthManager } = require('./core/auth');
const { createOfflineSession } = require('./core/offline-profile');
const { syncPack } = require('./core/synchronizer');
const { ensureMinecraft, inspectRuntimeState, launchMinecraft } = require('./core/minecraft');

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) app.quit();

let mainWindow = null;
let settingsStore = null;
let authManager = null;
let busyOperation = null;
let currentRuntime = null;
let gameRunning = false;
let updateCheckTimer = null;
let updateCheckInitialTimer = null;
let updateCheckWasManual = false;

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function resourcePath(...parts) {
  return path.join(app.getAppPath(), ...parts);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function errorMessage(error) {
  return String(error?.message || error || 'Неизвестная ошибка');
}

async function appendLauncherLog(line) {
  const logDirectory = path.join(app.getPath('userData'), 'logs');
  await fs.mkdir(logDirectory, { recursive: true });
  const text = String(line || '');
  await fs.appendFile(path.join(logDirectory, 'launcher.log'), text, 'utf8').catch(() => {});
}

function progressSink(event) {
  send('launcher:progress', event);
}

function logSink(text) {
  appendLauncherLog(text);
  send('launcher:log', text);
}

async function runExclusive(name, operation) {
  if (busyOperation) throw new Error(`Сейчас уже выполняется операция «${busyOperation}».`);
  busyOperation = name;
  send('launcher:busy', { busy: true, operation: name });
  try {
    return await operation();
  } finally {
    busyOperation = null;
    send('launcher:busy', { busy: false, operation: '' });
  }
}

async function loadState() {
  const settings = settingsStore.get();
  return {
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    settings,
    auth: authManager.publicState(),
    runtime: await inspectRuntimeState(settings.gameDirectory),
    gameRunning
  };
}

async function openMicrosoftLogin() {
  const auth = await authManager.login((code) => {
    if (code.userCode) clipboard.writeText(code.userCode);
    send('auth:device-code', code);
    if (code.verificationUri) shell.openExternal(code.verificationUri).catch(() => {});
  });
  await settingsStore.update({
    authMode: 'microsoft',
    lastMicrosoftProfile: auth.profile
  });
  send('auth:state', auth);
  return auth;
}

async function preparePack(forcePackCheck) {
  const settings = settingsStore.get();
  if (!settings.manifestUrl) {
    throw new Error('Сначала укажи GitHub-ссылку на манифест сборки в настройках лаунчера.');
  }
  const syncResult = await syncPack({
    manifestUrl: settings.manifestUrl,
    gameDirectory: settings.gameDirectory,
    force: forcePackCheck,
    onProgress: progressSink
  });
  if (syncResult.warning) send('launcher:warning', { message: syncResult.warning });
  if (syncResult.manifest) {
    send('launcher:pack-info', {
      ...syncResult.manifest.pack,
      fileCount: syncResult.managedFileCount ?? syncResult.manifest.files.length
    });
  }

  const pack = syncResult.manifest?.pack;
  const effective = {
    ...settings,
    minecraftVersion: pack?.minecraftVersion || settings.minecraftVersion,
    neoForgeVersion: pack?.neoForgeVersion || settings.neoForgeVersion,
    serverAddress: pack?.serverAddress || settings.serverAddress
  };
  currentRuntime = await ensureMinecraft({
    gameDirectory: effective.gameDirectory,
    runtimeRoot: path.join(app.getPath('userData'), 'runtime'),
    minecraftVersion: effective.minecraftVersion,
    neoForgeVersion: effective.neoForgeVersion,
    customJavaPath: effective.customJavaPath,
    onProgress: progressSink
  });
  return { settings: effective, syncResult, runtime: currentRuntime };
}

async function performPlay() {
  return runExclusive('Подготовка игры', async () => {
    const prepared = await preparePack(false);
    const settings = prepared.settings;
    let session;
    if (settings.authMode === 'microsoft') {
      session = authManager.getSession();
      if (!session) {
        await openMicrosoftLogin();
        session = authManager.getSession();
      }
    } else {
      session = createOfflineSession(settings.offlineUsername);
    }

    progressSink({ phase: 'launch', message: `Запускаю игру как ${session.profile.name}…`, indeterminate: true });
    const result = await launchMinecraft({
      gameDirectory: settings.gameDirectory,
      runtime: prepared.runtime,
      session,
      minMemoryMb: settings.minMemoryMb,
      maxMemoryMb: settings.maxMemoryMb,
      serverAddress: settings.serverAddress,
      onLog: logSink,
      onState: (state) => {
        send('game:state', state);
        if (state.state === 'started') gameRunning = true;
        if (state.state === 'window-ready' && settings.closeLauncherOnGameStart) mainWindow?.hide();
        if (['closed', 'minecraft-exit', 'error'].includes(state.state)) {
          gameRunning = false;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            app.quit();
          }
        }
      }
    });
    return { ...result, profile: session.profile };
  });
}

function configureUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => {
    send('update:state', { type: 'checking', data: { manual: updateCheckWasManual } });
  });
  autoUpdater.on('update-available', (data) => {
    send('update:state', {
      type: 'available',
      data: { ...data, manual: updateCheckWasManual, autoDownloading: autoUpdater.autoDownload }
    });
    updateCheckWasManual = false;
  });
  autoUpdater.on('update-not-available', (data) => {
    send('update:state', { type: 'not-available', data: { ...data, manual: updateCheckWasManual } });
    updateCheckWasManual = false;
  });
  autoUpdater.on('download-progress', (data) => send('update:state', { type: 'progress', data }));
  autoUpdater.on('update-downloaded', (data) => send('update:state', { type: 'downloaded', data }));
  autoUpdater.on('error', (error) => {
    send('update:state', {
      type: 'error',
      data: { message: errorMessage(error), manual: updateCheckWasManual }
    });
    updateCheckWasManual = false;
  });
}

async function checkForLauncherUpdates(manual = false) {
  const settings = settingsStore.get();
  if (!app.isPackaged) {
    if (manual) send('update:state', { type: 'error', data: { message: 'Проверка обновлений доступна после сборки приложения.' } });
    return null;
  }
  if (!settings.updateRepository) {
    if (manual) send('update:state', { type: 'error', data: { message: 'Репозиторий обновлений не настроен.' } });
    return null;
  }
  const [owner, repo] = settings.updateRepository.split('/');
  autoUpdater.autoDownload = Boolean(settings.autoUpdateLauncher);
  autoUpdater.setFeedURL({ provider: 'github', owner, repo, private: false });
  updateCheckWasManual = manual;
  return autoUpdater.checkForUpdates();
}

function scheduleUpdateChecks() {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (updateCheckInitialTimer) clearTimeout(updateCheckInitialTimer);
  updateCheckTimer = null;
  updateCheckInitialTimer = null;
  if (!settingsStore?.get().autoUpdateLauncher) return;
  updateCheckInitialTimer = setTimeout(() => {
    updateCheckInitialTimer = null;
    checkForLauncherUpdates(false).catch(() => {});
  }, 2500);
  updateCheckInitialTimer.unref?.();
  updateCheckTimer = setInterval(() => {
    checkForLauncherUpdates(false).catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);
  updateCheckTimer.unref?.();
}

function registerIpc() {
  ipcMain.handle('launcher:get-state', () => loadState());
  ipcMain.handle('settings:save', async (_event, patch) => {
    const saved = await settingsStore.update(patch || {});
    currentRuntime = null;
    scheduleUpdateChecks();
    return saved;
  });
  ipcMain.handle('dialog:choose-game-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выбери папку сборки',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? '' : result.filePaths[0];
  });
  ipcMain.handle('dialog:choose-java', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выбери javaw.exe или java.exe',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Java', extensions: ['exe'] }]
        : [{ name: 'Java', extensions: ['*'] }]
    });
    return result.canceled ? '' : result.filePaths[0];
  });
  ipcMain.handle('auth:microsoft-login', () => openMicrosoftLogin());
  ipcMain.handle('auth:logout', async () => {
    const state = await authManager.logout();
    await settingsStore.update({ lastMicrosoftProfile: null });
    send('auth:state', state);
    return state;
  });
  ipcMain.handle('launcher:verify', () => runExclusive('Проверка файлов', async () => {
    const prepared = await preparePack(true);
    return {
      changed: prepared.syncResult.changed,
      moved: prepared.syncResult.moved,
      pack: prepared.syncResult.manifest?.pack || null
    };
  }));
  ipcMain.handle('launcher:play', () => performPlay());
  ipcMain.handle('launcher:open-game-directory', () => shell.openPath(settingsStore.get().gameDirectory));
  ipcMain.handle('launcher:open-logs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
  ipcMain.handle('external:open', (_event, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Разрешены только HTTPS-ссылки.');
    return shell.openExternal(parsed.toString());
  });
  ipcMain.handle('update:check', () => checkForLauncherUpdates(true));
  ipcMain.handle('update:download', () => autoUpdater.downloadUpdate());
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(false, true));
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:close', () => mainWindow?.close());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#0b1114',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  settingsStore = new SettingsStore({
    settingsPath: path.join(userData, 'settings.json'),
    defaultsPath: resourcePath('resources', 'launcher.defaults.json'),
    defaultGameDirectory: path.join(userData, 'game')
  });
  await settingsStore.load();
  authManager = new MicrosoftAuthManager({
    cacheDirectory: path.join(userData, 'auth'),
    safeStorage
  });
  configureUpdater();
  registerIpc();
  createWindow();
  scheduleUpdateChecks();
}).catch((error) => {
  dialog.showErrorBox('Tech Adventure Launcher', errorMessage(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (!gameRunning) app.quit();
});

app.on('before-quit', () => {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (updateCheckInitialTimer) clearTimeout(updateCheckInitialTimer);
});
