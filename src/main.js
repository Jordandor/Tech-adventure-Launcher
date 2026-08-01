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
const { ensureRuntimeBootstrap } = require('./core/runtime-bootstrap');
const { ensureMinecraft, inspectRuntimeState, launchMinecraft } = require('./core/minecraft');
const { loadPackRegistry, getPack, publicPack } = require('./core/pack-registry');
const {
  readCachedPackSummary,
  loadLatestPackSummary,
  writeCachedPackSummary
} = require('./core/pack-info');
const { pingMinecraftServer } = require('./core/server-status');

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) app.quit();

let mainWindow = null;
let settingsStore = null;
let authManager = null;
let packRegistry = null;
let busyOperation = null;
let currentRuntime = null;
let gameRunning = false;
let updateCheckTimer = null;
let updateCheckInitialTimer = null;
let packInfoTimer = null;
let packInfoInitialTimer = null;
let serverStatusTimer = null;
let serverStatusInitialTimer = null;
let updateCheckWasManual = false;
let lastProgressLogKey = '';
let lastProgressLogAt = 0;
let packInfoRefreshInFlight = null;
let serverStatusRefreshInFlight = null;
let lastPackInfo = null;
let lastServerStatus = null;

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const PACK_INFO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SERVER_STATUS_INTERVAL_MS = 10 * 1000;

async function countInstalledMods(gameDirectory) {
  try {
    const entries = await fs.readdir(path.join(gameDirectory, 'mods'), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    return null;
  }
}

function resourcePath(...parts) {
  return path.join(app.getAppPath(), ...parts);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function activePack(settings = settingsStore?.get()) {
  return getPack(packRegistry, settings?.activePackId);
}

function effectivePackSettings(settings = settingsStore.get()) {
  const pack = activePack(settings);
  if (!pack) return settings;
  return {
    ...settings,
    activePackId: pack.id,
    packName: pack.name || settings.packName,
    manifestUrl: settings.manifestUrl || pack.manifestUrl,
    runtimeManifestUrl: settings.runtimeManifestUrl || pack.runtimeManifestUrl,
    minecraftVersion: settings.minecraftVersion || pack.minecraftVersion,
    neoForgeVersion: settings.neoForgeVersion || pack.neoForgeVersion,
    serverAddress: settings.serverAddress || pack.serverAddress
  };
}

function packInfoCacheDirectory() {
  return path.join(app.getPath('userData'), 'pack-info');
}

function collectErrorMessages(error, result = [], seen = new Set()) {
  if (error == null) return result;
  if (typeof error !== 'object') {
    const text = String(error).trim();
    if (text) result.push(text);
    return result;
  }
  if (seen.has(error)) return result;
  seen.add(error);

  const message = String(error.message || error.name || '').trim();
  if (message && message !== 'AggregateError') result.push(message);

  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) collectErrorMessages(nested, result, seen);
  }
  if (error.cause) collectErrorMessages(error.cause, result, seen);
  return result;
}

function errorMessage(error) {
  const messages = [...new Set(collectErrorMessages(error))];
  if (messages.length === 0) return String(error || 'Неизвестная ошибка');
  if (messages.length === 1) return messages[0];
  return `${messages[0]} Причины: ${messages.slice(1).join(' | ')}`;
}

function errorDetails(error) {
  const messages = [...new Set(collectErrorMessages(error))];
  const stack = String(error?.stack || '').trim();
  const lines = [];
  if (messages.length > 0) {
    lines.push(messages[0]);
    for (const message of messages.slice(1)) lines.push(`  - ${message}`);
  }
  if (stack && !lines.includes(stack)) lines.push(stack);
  return lines.join('\n') || 'Неизвестная ошибка';
}

async function appendLauncherLog(line) {
  try {
    const logDirectory = path.join(app.getPath('userData'), 'logs');
    await fs.mkdir(logDirectory, { recursive: true });
    const text = String(line || '');
    await fs.appendFile(path.join(logDirectory, 'launcher.log'), text, 'utf8');
  } catch {
    // Ошибка журнала не должна блокировать запуск игры.
  }
}

function progressSink(event) {
  send('launcher:progress', event);
  const message = String(event?.message || '').trim();
  if (!message) return;

  const key = `${event.phase || 'progress'}:${message}`;
  const now = Date.now();
  if (key === lastProgressLogKey && now - lastProgressLogAt < 5000) return;
  lastProgressLogKey = key;
  lastProgressLogAt = now;

  const line = `[launcher:${event.phase || 'progress'}] ${message}\n`;
  appendLauncherLog(line);
  send('launcher:log', line);
}

function logSink(text) {
  appendLauncherLog(text);
  send('launcher:log', text);
}

async function runExclusive(name, operation) {
  if (busyOperation) throw new Error(`Сейчас уже выполняется операция «${busyOperation}».`);
  busyOperation = name;
  send('launcher:busy', { busy: true, operation: name });
  const startedAt = new Date().toISOString();
  const startLine = `[launcher] ${startedAt} — ${name}\n`;
  await appendLauncherLog(startLine);
  send('launcher:log', startLine);

  let failureMessage = '';
  try {
    const result = await operation();
    const doneLine = `[launcher] ${name}: завершено успешно.\n`;
    await appendLauncherLog(doneLine);
    send('launcher:log', doneLine);
    return result;
  } catch (error) {
    failureMessage = errorMessage(error);
    const details = errorDetails(error);
    const failureLine = `[launcher] ${name}: ошибка\n${details}\n`;
    await appendLauncherLog(failureLine);
    send('launcher:log', failureLine);
    throw new Error(failureMessage);
  } finally {
    busyOperation = null;
    send('launcher:busy', {
      busy: false,
      operation: '',
      failed: Boolean(failureMessage),
      message: failureMessage
    });
  }
}

async function cachedPackInfoFor(pack) {
  if (!pack) return null;
  if (lastPackInfo?.packId === pack.id) return structuredClone(lastPackInfo);
  const cached = await readCachedPackSummary(packInfoCacheDirectory(), pack.id);
  return cached ? { ...cached, packId: pack.id } : null;
}

async function loadState() {
  const storedSettings = settingsStore.get();
  const settings = effectivePackSettings(storedSettings);
  const pack = activePack(storedSettings);
  return {
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    settings,
    packs: packRegistry.packs.map(publicPack),
    activePack: publicPack(pack),
    packInfo: await cachedPackInfoFor(pack),
    serverStatus: lastServerStatus?.packId === pack?.id ? structuredClone(lastServerStatus) : null,
    auth: authManager.publicState(),
    runtime: await inspectRuntimeState(settings.gameDirectory),
    modCount: await countInstalledMods(settings.gameDirectory),
    gameRunning
  };
}

async function refreshPackInfo() {
  if (packInfoRefreshInFlight) return packInfoRefreshInFlight;
  packInfoRefreshInFlight = (async () => {
    const storedSettings = settingsStore.get();
    const settings = effectivePackSettings(storedSettings);
    const pack = activePack(storedSettings);
    if (!pack || !settings.manifestUrl) return null;

    try {
      const result = await loadLatestPackSummary({
        manifestUrl: settings.manifestUrl,
        cacheDirectory: packInfoCacheDirectory(),
        fallback: {
          id: pack.id,
          name: pack.name,
          minecraftVersion: pack.minecraftVersion,
          neoForgeVersion: pack.neoForgeVersion,
          serverAddress: settings.serverAddress || pack.serverAddress
        }
      });
      lastPackInfo = { ...result, packId: pack.id };
      send('launcher:pack-info', {
        ...result.pack,
        packId: pack.id,
        fetchedAt: result.fetchedAt,
        fromCache: result.fromCache,
        stale: result.stale
      });
      if (result.warning) {
        await appendLauncherLog(`[launcher:pack-info] ${result.warning}\n`);
      }
      return lastPackInfo;
    } catch (error) {
      const message = errorMessage(error);
      await appendLauncherLog(`[launcher:pack-info] ${message}\n`);
      send('launcher:pack-info', {
        id: pack.id,
        packId: pack.id,
        name: pack.name,
        minecraftVersion: pack.minecraftVersion,
        neoForgeVersion: pack.neoForgeVersion,
        unavailable: true,
        error: message
      });
      return null;
    }
  })().finally(() => {
    packInfoRefreshInFlight = null;
  });
  return packInfoRefreshInFlight;
}

async function refreshServerStatus() {
  if (serverStatusRefreshInFlight) return serverStatusRefreshInFlight;
  serverStatusRefreshInFlight = (async () => {
    const settings = effectivePackSettings();
    const pack = activePack();
    if (!pack) return null;
    if (!settings.serverAddress) {
      lastServerStatus = {
        packId: pack.id,
        reachable: false,
        configured: false,
        checkedAt: new Date().toISOString()
      };
      send('server:status', lastServerStatus);
      return lastServerStatus;
    }

    try {
      const status = await pingMinecraftServer(settings.serverAddress, { timeoutMs: 5000 });
      lastServerStatus = {
        ...status,
        packId: pack.id,
        configured: true
      };
    } catch (error) {
      lastServerStatus = {
        packId: pack.id,
        reachable: false,
        configured: true,
        checkedAt: new Date().toISOString(),
        error: errorMessage(error)
      };
    }
    send('server:status', lastServerStatus);
    return lastServerStatus;
  })().finally(() => {
    serverStatusRefreshInFlight = null;
  });
  return serverStatusRefreshInFlight;
}

function clearScheduledPackServices() {
  if (packInfoTimer) clearInterval(packInfoTimer);
  if (packInfoInitialTimer) clearTimeout(packInfoInitialTimer);
  if (serverStatusTimer) clearInterval(serverStatusTimer);
  if (serverStatusInitialTimer) clearTimeout(serverStatusInitialTimer);
  packInfoTimer = null;
  packInfoInitialTimer = null;
  serverStatusTimer = null;
  serverStatusInitialTimer = null;
}

function schedulePackServices() {
  clearScheduledPackServices();
  packInfoInitialTimer = setTimeout(() => {
    packInfoInitialTimer = null;
    refreshPackInfo().catch(() => {});
  }, 250);
  packInfoInitialTimer.unref?.();
  packInfoTimer = setInterval(() => refreshPackInfo().catch(() => {}), PACK_INFO_REFRESH_INTERVAL_MS);
  packInfoTimer.unref?.();

  serverStatusInitialTimer = setTimeout(() => {
    serverStatusInitialTimer = null;
    refreshServerStatus().catch(() => {});
  }, 450);
  serverStatusInitialTimer.unref?.();
  serverStatusTimer = setInterval(() => refreshServerStatus().catch(() => {}), SERVER_STATUS_INTERVAL_MS);
  serverStatusTimer.unref?.();
}

async function selectPack(packId) {
  if (busyOperation || gameRunning) {
    throw new Error('Нельзя переключать сборку во время проверки файлов или работы Minecraft.');
  }
  const target = getPack(packRegistry, packId);
  if (!target || target.id !== packId) throw new Error('Выбранная сборка отсутствует в реестре.');

  const current = settingsStore.get();
  const directories = { ...(current.packDirectories || {}) };
  directories[current.activePackId] = current.gameDirectory;
  const defaultTargetDirectory = target.id === packRegistry.defaultPackId
    ? path.join(app.getPath('userData'), 'game')
    : path.join(app.getPath('userData'), 'packs', target.id);
  const targetDirectory = directories[target.id] || defaultTargetDirectory;

  await settingsStore.update({
    activePackId: target.id,
    packDirectories: directories,
    packName: target.name,
    manifestUrl: target.manifestUrl,
    runtimeManifestUrl: target.runtimeManifestUrl,
    minecraftVersion: target.minecraftVersion,
    neoForgeVersion: target.neoForgeVersion,
    serverAddress: target.serverAddress,
    gameDirectory: targetDirectory
  });
  currentRuntime = null;
  lastPackInfo = null;
  lastServerStatus = null;
  schedulePackServices();
  return loadState();
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
  const settings = effectivePackSettings();
  if (!settings.manifestUrl) {
    throw new Error('Сначала укажи GitHub-ссылку на манифест сборки в настройках лаунчера.');
  }
  if (!settings.runtimeManifestUrl) {
    throw new Error('В настройках отсутствует ссылка на runtime-manifest-v2.json.');
  }

  const initialBootstrap = await ensureRuntimeBootstrap({
    runtimeManifestUrl: settings.runtimeManifestUrl,
    gameDirectory: settings.gameDirectory,
    expectedMinecraftVersion: settings.minecraftVersion,
    expectedNeoForgeVersion: settings.neoForgeVersion,
    onProgress: progressSink
  });
  if (initialBootstrap.warning) send('launcher:warning', { message: initialBootstrap.warning });

  const syncResult = await syncPack({
    manifestUrl: settings.manifestUrl,
    gameDirectory: settings.gameDirectory,
    force: forcePackCheck,
    onProgress: progressSink
  });
  if (syncResult.warning) send('launcher:warning', { message: syncResult.warning });
  if (syncResult.manifest) {
    const modCount = await countInstalledMods(settings.gameDirectory);
    const info = {
      ...syncResult.manifest.pack,
      serverAddress: syncResult.manifest.pack.serverAddress || settings.serverAddress,
      fileCount: syncResult.managedFileCount ?? syncResult.manifest.files.length,
      modCount,
      packId: settings.activePackId,
      fetchedAt: new Date().toISOString(),
      fromCache: Boolean(syncResult.fromCache),
      stale: Boolean(syncResult.fromCache)
    };
    send('launcher:pack-info', info);
    await writeCachedPackSummary(packInfoCacheDirectory(), info).catch(() => {});
    lastPackInfo = {
      packId: settings.activePackId,
      pack: info,
      fetchedAt: info.fetchedAt,
      fromCache: info.fromCache,
      stale: info.stale
    };
  }

  const manifestPack = syncResult.manifest?.pack;
  const effective = {
    ...settings,
    minecraftVersion: manifestPack?.minecraftVersion || settings.minecraftVersion,
    neoForgeVersion: manifestPack?.neoForgeVersion || settings.neoForgeVersion,
    serverAddress: manifestPack?.serverAddress || settings.serverAddress
  };

  if (
    effective.minecraftVersion !== settings.minecraftVersion
    || effective.neoForgeVersion !== settings.neoForgeVersion
  ) {
    const bootstrap = await ensureRuntimeBootstrap({
      runtimeManifestUrl: settings.runtimeManifestUrl,
      gameDirectory: effective.gameDirectory,
      expectedMinecraftVersion: effective.minecraftVersion,
      expectedNeoForgeVersion: effective.neoForgeVersion,
      onProgress: progressSink
    });
    if (bootstrap.warning) send('launcher:warning', { message: bootstrap.warning });
  }

  currentRuntime = await ensureMinecraft({
    gameDirectory: effective.gameDirectory,
    minecraftVersion: effective.minecraftVersion,
    neoForgeVersion: effective.neoForgeVersion,
    customJavaPath: effective.customJavaPath,
    onProgress: progressSink,
    force: forcePackCheck
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
    const message = errorMessage(error);
    appendLauncherLog(`[launcher:update] ${errorDetails(error)}\n`);
    send('update:state', {
      type: 'error',
      data: { message, manual: updateCheckWasManual }
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
  ipcMain.handle('packs:select', (_event, packId) => selectPack(String(packId || '')));
  ipcMain.handle('settings:save', async (_event, patch) => {
    const saved = await settingsStore.update(patch || {});
    currentRuntime = null;
    scheduleUpdateChecks();
    schedulePackServices();
    return effectivePackSettings(saved);
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
  ipcMain.handle('launcher:refresh-pack-info', () => refreshPackInfo());
  ipcMain.handle('launcher:refresh-server-status', () => refreshServerStatus());
  ipcMain.handle('launcher:open-game-directory', () => shell.openPath(effectivePackSettings().gameDirectory));
  ipcMain.handle('launcher:open-logs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
  ipcMain.handle('external:open', (_event, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Разрешены только HTTPS-ссылки.');
    return shell.openExternal(parsed.toString());
  });
  ipcMain.handle('update:check', () => checkForLauncherUpdates(true));
  ipcMain.handle('update:download', () => autoUpdater.downloadUpdate());
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true));
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
  packRegistry = await loadPackRegistry(resourcePath('resources', 'packs.json'));
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
  schedulePackServices();
}).catch(async (error) => {
  await appendLauncherLog(`[launcher:start] ${errorDetails(error)}\n`);
  dialog.showErrorBox('Dekodev Reborn Launcher', errorMessage(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (!gameRunning) app.quit();
});

app.on('before-quit', () => {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (updateCheckInitialTimer) clearTimeout(updateCheckInitialTimer);
  clearScheduledPackServices();
});
