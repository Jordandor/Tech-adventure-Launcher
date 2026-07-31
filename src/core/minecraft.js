'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Version, launch, createMinecraftProcessWatcher } = require('@xmcl/core');
const {
  getVersionList,
  install,
  installDependencies,
  installNeoForged,
  fetchJavaRuntimeManifest,
  installJavaRuntimeTask
} = require('@xmcl/installer');
const { writeJsonAtomic } = require('./settings');

const METADATA_TIMEOUT_MS = 45 * 1000;
const JAVA_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const GAME_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const NEOFORGE_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEPENDENCIES_TIMEOUT_MS = 20 * 60 * 1000;

function emit(onProgress, phase, message, extra = {}) {
  onProgress?.({ phase, message, ...extra });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(operation, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label}: превышено время ожидания (${Math.ceil(milliseconds / 1000)} с).`));
    }, milliseconds);
  });
  return Promise.race([Promise.resolve().then(operation), timeout])
    .finally(() => clearTimeout(timer));
}

async function retryNetworkOperation(label, operation, {
  attempts = 3,
  timeoutMs = METADATA_TIMEOUT_MS,
  onProgress
} = {}) {
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withTimeout(operation, timeoutMs, label);
    } catch (error) {
      failures.push(error);
      if (attempt >= attempts) break;
      emit(
        onProgress,
        'retry',
        `${label}: попытка ${attempt} не удалась, повторяю…`,
        { indeterminate: true, attempt, attempts }
      );
      await sleep(1000 * attempt);
    }
  }
  throw new AggregateError(failures, `${label}: не удалось выполнить после ${attempts} попыток.`);
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function runJavaVersion(javaPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, ['-version'], { windowsHide: true });
    let output = '';
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('Java не ответила за 10 секунд.')));
    }, 10000);

    child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      if (code !== 0) return reject(new Error(`Java завершилась с кодом ${code}.`));
      const match = output.match(/version\s+"(?:1\.)?(\d+)/i) || output.match(/openjdk\s+(\d+)/i);
      if (!match) return reject(new Error('Не удалось определить версию Java.'));
      resolve({ major: Number(match[1]), output: output.trim() });
    }));
  });
}

function managedJavaPaths(runtimeDirectory) {
  if (process.platform === 'win32') {
    return {
      installer: path.join(runtimeDirectory, 'bin', 'java.exe'),
      launcher: path.join(runtimeDirectory, 'bin', 'javaw.exe')
    };
  }
  const java = path.join(runtimeDirectory, 'bin', 'java');
  return { installer: java, launcher: java };
}

async function findExistingJava({ component, runtimeRoot, customJavaPath }) {
  if (customJavaPath) {
    const java = path.resolve(customJavaPath);
    if (!(await isFile(java))) throw new Error(`Java не найдена: ${java}`);
    const version = await runJavaVersion(java);
    if (version.major < 21) {
      throw new Error(`Для Minecraft 1.21.1 нужна Java 21 или новее, а выбрана Java ${version.major}.`);
    }
    return { installer: java, launcher: java, managed: false, major: version.major };
  }

  const target = component || 'java-runtime-delta';
  const runtimeDirectory = path.join(runtimeRoot, target);
  const paths = managedJavaPaths(runtimeDirectory);
  if (!(await isFile(paths.installer))) return null;

  try {
    const version = await runJavaVersion(paths.installer);
    if (version.major < 21) return null;
    if (!(await isFile(paths.launcher))) paths.launcher = paths.installer;
    return { ...paths, managed: true, major: version.major };
  } catch {
    return null;
  }
}

async function ensureJava({ component, runtimeRoot, customJavaPath, onProgress }) {
  const existing = await findExistingJava({ component, runtimeRoot, customJavaPath });
  if (existing) return existing;

  const target = component || 'java-runtime-delta';
  const runtimeDirectory = path.join(runtimeRoot, target);
  const paths = managedJavaPaths(runtimeDirectory);

  emit(onProgress, 'java', 'Получаю сведения о Java 21…', { indeterminate: true });
  const manifest = await retryNetworkOperation(
    'Получение манифеста Java',
    () => fetchJavaRuntimeManifest({ target }),
    { onProgress }
  );

  emit(onProgress, 'java', 'Устанавливаю Java 21…', { indeterminate: true });
  await withTimeout(
    () => installJavaRuntimeTask({
      destination: runtimeDirectory,
      manifest
    }).startAndWait(),
    JAVA_INSTALL_TIMEOUT_MS,
    'Установка Java 21'
  );

  const version = await runJavaVersion(paths.installer);
  if (version.major < 21) throw new Error(`Автоматически установилась неподходящая Java ${version.major}.`);
  if (!(await isFile(paths.launcher))) paths.launcher = paths.installer;
  return { ...paths, managed: true, major: version.major };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function parseInstalledVersion(gameDirectory, versionId) {
  if (!versionId) return null;
  try {
    return await Version.parse(gameDirectory, versionId);
  } catch {
    return null;
  }
}

function runtimeStatePath(gameDirectory) {
  return path.join(gameDirectory, '.tech-adventure-launcher', 'runtime-state.json');
}

function matchesRuntimeState(runtimeState, minecraftVersion, neoForgeVersion) {
  return Boolean(
    runtimeState
    && runtimeState.minecraftVersion === minecraftVersion
    && runtimeState.neoForgeVersion === neoForgeVersion
    && runtimeState.versionId
  );
}

async function loadInstalledRuntime({
  gameDirectory,
  runtimeRoot,
  minecraftVersion,
  neoForgeVersion,
  customJavaPath,
  onProgress
}) {
  const runtimeState = await readJson(runtimeStatePath(gameDirectory));
  if (!matchesRuntimeState(runtimeState, minecraftVersion, neoForgeVersion)) return null;

  emit(onProgress, 'runtime', 'Проверяю уже установленную игровую среду…', { indeterminate: true });
  const resolved = await parseInstalledVersion(gameDirectory, runtimeState.versionId);
  if (!resolved) return null;

  const java = await findExistingJava({
    component: runtimeState.javaComponent || 'java-runtime-delta',
    runtimeRoot,
    customJavaPath
  });
  if (!java) return null;

  return {
    versionId: runtimeState.versionId,
    resolved,
    java,
    reused: true
  };
}

async function ensureMinecraft({
  gameDirectory,
  runtimeRoot,
  minecraftVersion,
  neoForgeVersion,
  customJavaPath,
  onProgress,
  force = false
}) {
  await fs.mkdir(gameDirectory, { recursive: true });

  if (!force) {
    const installed = await loadInstalledRuntime({
      gameDirectory,
      runtimeRoot,
      minecraftVersion,
      neoForgeVersion,
      customJavaPath,
      onProgress
    });
    if (installed) {
      emit(onProgress, 'runtime-ready', 'Использую уже установленный Minecraft и NeoForge.', {
        current: 1,
        total: 1,
        reused: true
      });
      return installed;
    }
    emit(onProgress, 'recovery', 'Локальная игровая среда неполна. Запускаю восстановление…', {
      indeterminate: true
    });
  }

  const stateFile = runtimeStatePath(gameDirectory);
  const runtimeState = await readJson(stateFile);

  emit(onProgress, 'minecraft', `Получаю сведения о Minecraft ${minecraftVersion}…`, { indeterminate: true });
  const versionList = await retryNetworkOperation(
    'Получение официального манифеста Minecraft',
    () => getVersionList(),
    { onProgress }
  );
  const versionMeta = versionList.versions.find((entry) => entry.id === minecraftVersion);
  if (!versionMeta) throw new Error(`Minecraft ${minecraftVersion} отсутствует в официальном манифесте Mojang.`);

  emit(onProgress, 'minecraft', `Устанавливаю и проверяю Minecraft ${minecraftVersion}…`, {
    indeterminate: true
  });
  const baseVersion = await withTimeout(
    () => install(versionMeta, gameDirectory, {
      side: 'client',
      assetsDownloadConcurrency: 16,
      librariesDownloadConcurrency: 8
    }),
    GAME_INSTALL_TIMEOUT_MS,
    `Установка Minecraft ${minecraftVersion}`
  );

  const javaComponent = baseVersion.javaVersion?.component
    || runtimeState?.javaComponent
    || 'java-runtime-delta';
  const java = await ensureJava({
    component: javaComponent,
    runtimeRoot,
    customJavaPath,
    onProgress
  });

  let versionId = matchesRuntimeState(runtimeState, minecraftVersion, neoForgeVersion)
    ? runtimeState.versionId
    : '';
  let resolved = await parseInstalledVersion(gameDirectory, versionId);

  if (!resolved) {
    emit(onProgress, 'neoforge', `Устанавливаю NeoForge ${neoForgeVersion}…`, { indeterminate: true });
    versionId = await withTimeout(
      () => installNeoForged('neoforge', neoForgeVersion, gameDirectory, {
        side: 'client',
        java: java.installer,
        librariesDownloadConcurrency: 8
      }),
      NEOFORGE_INSTALL_TIMEOUT_MS,
      `Установка NeoForge ${neoForgeVersion}`
    );
    resolved = await Version.parse(gameDirectory, versionId);
  }

  emit(onProgress, 'dependencies', 'Проверяю библиотеки и ресурсы игры…', { indeterminate: true });
  resolved = await withTimeout(
    () => installDependencies(resolved, {
      side: 'client',
      assetsDownloadConcurrency: 16,
      librariesDownloadConcurrency: 8
    }),
    DEPENDENCIES_TIMEOUT_MS,
    'Проверка библиотек и ресурсов Minecraft'
  );

  await writeJsonAtomic(stateFile, {
    schemaVersion: 1,
    minecraftVersion,
    neoForgeVersion,
    versionId,
    javaComponent,
    verifiedAt: new Date().toISOString()
  });

  emit(onProgress, 'runtime-ready', 'Minecraft и NeoForge готовы.', { current: 1, total: 1 });
  return { versionId, resolved, java, reused: false };
}

function parseServerAddress(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(`minecraft://${text}`);
  } catch {
    throw new Error('Адрес сервера указан неверно. Пример: play.example.org:25565');
  }
  const port = url.port ? Number(url.port) : 25565;
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Адрес сервера указан неверно. Пример: play.example.org:25565');
  }
  return { ip: url.hostname, port };
}

async function launchMinecraft({
  gameDirectory,
  runtime,
  session,
  minMemoryMb,
  maxMemoryMb,
  serverAddress,
  onLog,
  onState
}) {
  if (!session?.profile?.id || !session?.profile?.name) {
    throw new Error('Сначала выбери способ входа.');
  }
  const server = parseServerAddress(serverAddress);
  const child = await launch({
    gamePath: gameDirectory,
    resourcePath: gameDirectory,
    javaPath: runtime.java.launcher,
    version: runtime.resolved,
    gameProfile: {
      id: session.profile.id.replaceAll('-', ''),
      name: session.profile.name
    },
    accessToken: session.accessToken,
    userType: session.userType,
    properties: {},
    launcherName: 'TechAdventureLauncher',
    launcherBrand: 'tech-adventure',
    minMemory: minMemoryMb,
    maxMemory: maxMemoryMb,
    server: server || undefined,
    extraExecOption: {
      cwd: gameDirectory,
      windowsHide: true
    }
  });

  child.stdout?.on('data', (chunk) => onLog?.(chunk.toString()));
  child.stderr?.on('data', (chunk) => onLog?.(chunk.toString()));
  child.once('spawn', () => onState?.({ state: 'started', pid: child.pid }));
  child.once('error', (error) => onState?.({ state: 'error', message: error.message }));
  child.once('close', (code, signal) => onState?.({ state: 'closed', code, signal }));

  const watcher = createMinecraftProcessWatcher(child);
  watcher.on('minecraft-window-ready', () => onState?.({ state: 'window-ready', pid: child.pid }));
  watcher.on('minecraft-exit', (event) => onState?.({
    state: 'minecraft-exit',
    code: event.code,
    crashReport: event.crashReport,
    crashReportLocation: event.crashReportLocation
  }));
  return { pid: child.pid };
}

async function inspectRuntimeState(gameDirectory) {
  const state = await readJson(runtimeStatePath(gameDirectory));
  if (!state) return { installed: false };
  const parsed = await parseInstalledVersion(gameDirectory, state.versionId);
  return {
    installed: Boolean(parsed),
    minecraftVersion: state.minecraftVersion || '',
    neoForgeVersion: state.neoForgeVersion || '',
    versionId: state.versionId || ''
  };
}

module.exports = {
  runJavaVersion,
  managedJavaPaths,
  findExistingJava,
  ensureJava,
  parseInstalledVersion,
  matchesRuntimeState,
  loadInstalledRuntime,
  ensureMinecraft,
  parseServerAddress,
  launchMinecraft,
  inspectRuntimeState,
  withTimeout,
  retryNetworkOperation
};
