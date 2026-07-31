'use strict';

const byId = (id) => document.getElementById(id);

const elements = {
  appVersion: byId('app-version'),
  packTitle: byId('pack-title'),
  minecraftTag: byId('minecraft-tag'),
  neoForgeTag: byId('neoforge-tag'),
  filesTag: byId('files-tag'),
  packVersion: byId('pack-version'),
  packNews: byId('pack-news'),
  offlineMode: byId('offline-mode'),
  microsoftMode: byId('microsoft-mode'),
  offlineAuth: byId('offline-auth'),
  microsoftAuth: byId('microsoft-auth'),
  offlineUsername: byId('offline-username'),
  microsoftName: byId('microsoft-name'),
  microsoftCaption: byId('microsoft-caption'),
  microsoftLogin: byId('microsoft-login'),
  microsoftLogout: byId('microsoft-logout'),
  playButton: byId('play-button'),
  verifyButton: byId('verify-button'),
  serverCaption: byId('server-caption'),
  progressTitle: byId('progress-title'),
  progressDetail: byId('progress-detail'),
  progressPercent: byId('progress-percent'),
  progressBar: byId('progress-bar'),
  sidebarStatus: byId('sidebar-status'),
  sidebarStatusDot: byId('sidebar-status-dot'),
  settingsForm: byId('settings-form'),
  settingsResult: byId('settings-result'),
  logOutput: byId('log-output'),
  deviceModal: byId('device-modal'),
  deviceCode: byId('device-code'),
  deviceOpen: byId('device-open'),
  toast: byId('toast'),
  updateBanner: byId('update-banner'),
  updateTitle: byId('update-title'),
  updateCaption: byId('update-caption'),
  updateAction: byId('update-action')
};

let state = null;
let authMode = 'offline';
let busy = false;
let deviceVerificationUri = 'https://www.microsoft.com/link';
let toastTimer = null;
let logText = '[launcher] Ожидание запуска…\n';

function showToast(message, type = 'normal', duration = 4800) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast ${type === 'normal' ? '' : type}`.trim();
  toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), duration);
}

function friendlyError(error) {
  const message = String(error?.message || error || 'Неизвестная ошибка');
  return message.replace(/^Error invoking remote method '[^']+':\s*/i, '');
}

async function attempt(action) {
  try {
    return await action();
  } catch (error) {
    const message = friendlyError(error);
    showToast(message, 'error', 7500);
    setStatus(message, 'error');
    return null;
  }
}

function setStatus(text, kind = 'ready') {
  elements.sidebarStatus.textContent = text;
  elements.sidebarStatusDot.className = `status-dot ${kind === 'ready' ? '' : kind}`.trim();
}

function setBusy(value, operation = '', failed = false, message = '') {
  busy = value;
  elements.playButton.disabled = value;
  elements.verifyButton.disabled = value;
  elements.microsoftLogin.disabled = value;
  if (value) {
    setStatus(operation || 'Выполняется операция…', 'busy');
  } else if (failed) {
    setStatus(message || 'Операция завершилась с ошибкой', 'error');
  } else {
    setStatus('Готов к запуску');
  }
}

function setAuthMode(mode, persist = false) {
  authMode = mode === 'microsoft' ? 'microsoft' : 'offline';
  elements.offlineMode.classList.toggle('active', authMode === 'offline');
  elements.microsoftMode.classList.toggle('active', authMode === 'microsoft');
  elements.offlineAuth.classList.toggle('hidden', authMode !== 'offline');
  elements.microsoftAuth.classList.toggle('hidden', authMode !== 'microsoft');
  if (persist && state) {
    state.settings.authMode = authMode;
    window.launcher.saveSettings({
      authMode,
      offlineUsername: elements.offlineUsername.value.trim()
    }).catch((error) => showToast(friendlyError(error), 'error'));
  }
}

function renderAuth(auth) {
  const profile = auth?.profile;
  if (auth?.authenticated && profile) {
    elements.microsoftName.textContent = profile.name;
    elements.microsoftCaption.textContent = `UUID ${profile.id.slice(0, 8)}…${profile.id.slice(-4)}`;
    elements.microsoftLogin.textContent = 'Обновить вход';
    elements.microsoftLogout.classList.remove('hidden');
    elements.deviceModal.classList.add('hidden');
  } else {
    const previous = state?.settings?.lastMicrosoftProfile;
    elements.microsoftName.textContent = previous?.name || 'Аккаунт не подключён';
    elements.microsoftCaption.textContent = previous
      ? 'Сессия будет восстановлена при запуске'
      : 'Официальный профиль Minecraft';
    elements.microsoftLogin.textContent = previous ? 'Восстановить вход' : 'Войти через Microsoft';
    elements.microsoftLogout.classList.toggle('hidden', !previous);
  }
}

function renderPackInfo(pack) {
  if (!pack) return;
  elements.packTitle.textContent = pack.name || state.settings.packName;
  elements.packVersion.textContent = `Версия ${pack.version || 'не указана'}`;
  elements.packNews.textContent = pack.news || 'Сборка обновлена и готова к запуску.';
  elements.minecraftTag.textContent = `Minecraft ${pack.minecraftVersion || state.settings.minecraftVersion}`;
  elements.neoForgeTag.textContent = `NeoForge ${pack.neoForgeVersion || state.settings.neoForgeVersion}`;
  if (Number.isFinite(pack.fileCount)) elements.filesTag.textContent = `${pack.fileCount} управляемых файлов`;
  if (pack.serverAddress) elements.serverCaption.textContent = pack.serverAddress;
}

function hydrateSettings(settings) {
  byId('setting-manifest').value = settings.manifestUrl || '';
  byId('setting-runtime-manifest').value = settings.runtimeManifestUrl || '';
  byId('setting-minecraft').value = settings.minecraftVersion || '1.21.1';
  byId('setting-neoforge').value = settings.neoForgeVersion || '';
  byId('setting-server').value = settings.serverAddress || '';
  byId('setting-game-dir').value = settings.gameDirectory || '';
  byId('setting-java').value = settings.customJavaPath || '';
  byId('setting-min-memory').value = settings.minMemoryMb || 4096;
  byId('setting-max-memory').value = settings.maxMemoryMb || 8192;
  byId('setting-close-on-start').checked = Boolean(settings.closeLauncherOnGameStart);
  byId('setting-update-repo').value = settings.updateRepository || '';
  byId('setting-auto-update').checked = Boolean(settings.autoUpdateLauncher);
  elements.offlineUsername.value = settings.offlineUsername || '';
  elements.packTitle.textContent = settings.packName || 'Tech Adventure';
  elements.minecraftTag.textContent = `Minecraft ${settings.minecraftVersion}`;
  elements.neoForgeTag.textContent = `NeoForge ${settings.neoForgeVersion}`;
  elements.serverCaption.textContent = settings.serverAddress || 'Запуск сборки';
  setAuthMode(settings.authMode, false);
}

function collectSettings() {
  return {
    manifestUrl: byId('setting-manifest').value.trim(),
    runtimeManifestUrl: byId('setting-runtime-manifest').value.trim(),
    minecraftVersion: byId('setting-minecraft').value.trim(),
    neoForgeVersion: byId('setting-neoforge').value.trim(),
    serverAddress: byId('setting-server').value.trim(),
    gameDirectory: byId('setting-game-dir').value.trim(),
    customJavaPath: byId('setting-java').value.trim(),
    minMemoryMb: Number(byId('setting-min-memory').value),
    maxMemoryMb: Number(byId('setting-max-memory').value),
    closeLauncherOnGameStart: byId('setting-close-on-start').checked,
    updateRepository: byId('setting-update-repo').value.trim(),
    autoUpdateLauncher: byId('setting-auto-update').checked,
    authMode,
    offlineUsername: elements.offlineUsername.value.trim()
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`;
}

function renderProgress(event) {
  elements.progressTitle.textContent = event.message || 'Выполняется операция…';
  elements.progressDetail.textContent = event.file || phaseCaption(event.phase);
  if (event.indeterminate || !Number.isFinite(event.total) || event.total <= 0) {
    elements.progressBar.classList.add('indeterminate');
    elements.progressPercent.textContent = '…';
    return;
  }
  elements.progressBar.classList.remove('indeterminate');
  const percent = Math.max(0, Math.min(100, Math.round((event.current / event.total) * 100)));
  elements.progressBar.style.width = `${percent}%`;
  elements.progressPercent.textContent = ['download', 'runtime-download'].includes(event.phase)
    ? `${formatBytes(event.current)} / ${formatBytes(event.total)}`
    : `${percent}%`;
}

function phaseCaption(phase) {
  return {
    manifest: 'Проверка обновлений сборки',
    scan: 'Сверка локальных файлов',
    download: 'Безопасная загрузка и проверка SHA-256',
    extract: 'Проверка и распаковка пакетов',
    install: 'Применение обновления сборки',
    java: 'Автоматическая среда Java',
    minecraft: 'Официальные файлы Minecraft',
    neoforge: 'Загрузчик модификаций NeoForge',
    dependencies: 'Библиотеки и игровые ресурсы',
    runtime: 'Проверка установленной игровой среды',
    recovery: 'Восстановление игровой среды',
    retry: 'Повтор сетевого запроса',
    launch: 'Подготовка процесса Minecraft',
    done: 'Синхронизация завершена',
    'runtime-ready': 'Игровая среда готова',
    'runtime-manifest': 'Проверка базовой игровой среды',
    'runtime-download': 'Загрузка Minecraft и NeoForge',
    'runtime-verify': 'Проверка SHA-256 базовой среды',
    'runtime-extract': 'Распаковка базовой среды',
    'runtime-install': 'Установка базовой среды',
    'runtime-bootstrap-ready': 'Базовая игровая среда готова'
  }[phase] || 'Подготовка сборки';
}

function appendLog(chunk) {
  logText += String(chunk || '');
  if (logText.length > 240000) logText = logText.slice(-200000);
  elements.logOutput.textContent = logText;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
}

function showUpdate(type, data = {}) {
  if (type === 'not-available') {
    elements.updateBanner.classList.add('hidden');
    if (data.manual) showToast('Установлена актуальная версия лаунчера.');
    return;
  }
  if (type === 'checking') {
    if (data.manual) showToast('Проверяю обновления лаунчера…');
    return;
  }
  if (type === 'error') {
    elements.updateBanner.classList.add('hidden');
    if (data.manual) showToast(data.message || 'Не удалось проверить обновления.', 'warning');
    return;
  }
  elements.updateBanner.classList.remove('hidden');
  if (type === 'available') {
    elements.updateTitle.textContent = `Доступна версия ${data.version || ''}`;
    elements.updateCaption.textContent = data.autoDownloading
      ? 'Обновление скачивается в фоне.'
      : 'Обновление лаунчера опубликовано на GitHub.';
    elements.updateAction.textContent = data.autoDownloading ? '…' : 'Скачать';
    elements.updateAction.disabled = Boolean(data.autoDownloading);
    elements.updateAction.onclick = data.autoDownloading
      ? null
      : () => window.launcher.downloadUpdate().catch((error) => showToast(friendlyError(error), 'error'));
  } else if (type === 'progress') {
    elements.updateTitle.textContent = 'Загружаю обновление';
    elements.updateCaption.textContent = `${Math.round(data.percent || 0)}%`;
    elements.updateAction.textContent = '…';
    elements.updateAction.disabled = true;
  } else if (type === 'downloaded') {
    elements.updateTitle.textContent = 'Обновление готово';
    elements.updateCaption.textContent = 'Лаунчер перезапустится и установит новую версию.';
    elements.updateAction.textContent = 'Установить';
    elements.updateAction.disabled = false;
    elements.updateAction.onclick = () => window.launcher.installUpdate();
  }
}

async function initialize() {
  state = await attempt(() => window.launcher.getState());
  if (!state) return;
  elements.appVersion.textContent = `v${state.appVersion}`;
  hydrateSettings(state.settings);
  renderAuth(state.auth);
  if (state.runtime.installed) {
    elements.progressDetail.textContent = `Установлены Minecraft ${state.runtime.minecraftVersion} и NeoForge ${state.runtime.neoForgeVersion}`;
  }
}

document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => showView(button.dataset.view));
});
elements.offlineMode.addEventListener('click', () => setAuthMode('offline', true));
elements.microsoftMode.addEventListener('click', () => setAuthMode('microsoft', true));

elements.microsoftLogin.addEventListener('click', async () => {
  const auth = await attempt(() => window.launcher.microsoftLogin());
  if (!auth) {
    elements.deviceModal.classList.add('hidden');
    return;
  }
  state.auth = auth;
  state.settings.authMode = 'microsoft';
  setAuthMode('microsoft');
  renderAuth(auth);
  showToast(`Выполнен вход как ${auth.profile.name}.`);
});

elements.microsoftLogout.addEventListener('click', async () => {
  const auth = await attempt(() => window.launcher.logout());
  if (!auth) return;
  state.auth = auth;
  state.settings.lastMicrosoftProfile = null;
  renderAuth(auth);
  showToast('Данные входа Microsoft удалены с этого компьютера.');
});

elements.playButton.addEventListener('click', async () => {
  await attempt(async () => {
    state.settings = await window.launcher.saveSettings({
      authMode,
      offlineUsername: elements.offlineUsername.value.trim()
    });
    const result = await window.launcher.play();
    showToast(`Minecraft запускается как ${result.profile.name}.`);
  });
});

elements.verifyButton.addEventListener('click', async () => {
  const result = await attempt(() => window.launcher.verify());
  if (!result) return;
  const changed = result.changed?.length || 0;
  const moved = result.moved?.length || 0;
  showToast(`Проверка завершена. Обновлено: ${changed}, убрано из сборки: ${moved}.`);
});

elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = await attempt(() => window.launcher.saveSettings(collectSettings()));
  if (!saved) return;
  state.settings = saved;
  hydrateSettings(saved);
  elements.settingsResult.textContent = 'Настройки сохранены';
  setTimeout(() => { elements.settingsResult.textContent = ''; }, 3000);
});

byId('choose-game-dir').addEventListener('click', async () => {
  const selected = await window.launcher.chooseGameDirectory();
  if (selected) byId('setting-game-dir').value = selected;
});
byId('choose-java').addEventListener('click', async () => {
  const selected = await window.launcher.chooseJava();
  if (selected) byId('setting-java').value = selected;
});
byId('clear-java').addEventListener('click', () => { byId('setting-java').value = ''; });
byId('open-pack-folder').addEventListener('click', () => window.launcher.openGameDirectory());
byId('open-log-folder').addEventListener('click', () => window.launcher.openLogs());
byId('check-update').addEventListener('click', () => attempt(() => window.launcher.checkUpdate()));
byId('minimize-button').addEventListener('click', () => window.launcher.minimize());
byId('close-button').addEventListener('click', () => window.launcher.close());
elements.deviceOpen.addEventListener('click', () => window.launcher.openExternal(deviceVerificationUri));
byId('device-cancel').addEventListener('click', () => elements.deviceModal.classList.add('hidden'));

window.launcher.onProgress(renderProgress);
window.launcher.onBusy(({ busy: isBusy, operation, failed, message }) => setBusy(isBusy, operation, failed, message));
window.launcher.onWarning(({ message }) => showToast(message, 'warning', 8000));
window.launcher.onPackInfo((pack) => renderPackInfo(pack));
window.launcher.onLog(appendLog);
window.launcher.onDeviceCode((code) => {
  deviceVerificationUri = code.verificationUri || deviceVerificationUri;
  elements.deviceCode.textContent = code.userCode || 'Смотри браузер';
  elements.deviceModal.classList.remove('hidden');
});
window.launcher.onAuthState((auth) => {
  if (state) state.auth = auth;
  renderAuth(auth);
});
window.launcher.onGameState((gameState) => {
  if (gameState.state === 'started') {
    setStatus('Minecraft запускается', 'busy');
    appendLog(`[launcher] Процесс Minecraft запущен, PID ${gameState.pid}.\n`);
  } else if (gameState.state === 'window-ready') {
    setStatus('Minecraft запущен');
  } else if (gameState.state === 'closed') {
    setStatus(`Minecraft завершён · код ${gameState.code ?? '?'}`);
    appendLog(`[launcher] Minecraft завершён с кодом ${gameState.code ?? '?'}.\n`);
  } else if (gameState.state === 'minecraft-exit' && gameState.crashReport) {
    showToast(`Игра завершилась с ошибкой. Краш-репорт: ${gameState.crashReportLocation || 'см. журнал'}`, 'error', 10000);
  } else if (gameState.state === 'error') {
    showToast(gameState.message || 'Не удалось запустить Minecraft.', 'error');
  }
});
window.launcher.onUpdateState(({ type, data }) => showUpdate(type, data));

initialize().catch(() => {});
