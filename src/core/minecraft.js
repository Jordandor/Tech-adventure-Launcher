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

function emit(onProgress, phase, message, extra = {}) {
  onProgress?.({ phase, message, ...extra });
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
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Java не ответила за 10 секунд.'));
    }, 10000);
    child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Java завершилась с кодом ${code}.`));
      const match = output.match(/version\s+"(?:1\.)?(\d+)/i) || output.match(/openjdk\s+(\d+)/i);
      if (!match) return reject(new Error('Не удалось определить версию Java.'));
      resolve({ major: Number(match[1]), output: output.trim() });
    });
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

async function ensureJava({ component, runtimeRoot, customJavaPath, onProgress }) {
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
  if (await isFile(paths.installer)) {
    try {
      const version = await runJavaVersion(paths.installer);
      if (version.major >= 21) {
        if (!(await isFile(paths.launcher))) paths.launcher = paths.installer;
        return { ...paths, managed: true, major: version.major };
      }
    } catch {
      // Повреждённая среда будет восстановлена установщиком ниже.
    }
  }

  emit(onProgress, 'java', 'Устанавливаю Java 21…', { indeterminate: true });
  const manifest = await fetchJavaRuntimeManifest({ target });
  await installJavaRuntimeTask({
    destination: runtimeDirectory,
    manifest
  }).startAndWait();
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

async function ensureMinecraft({
  gameDirectory,
  runtimeRoot,
  minecraftVersion,
  neoForgeVersion,
  customJavaPath,
  onProgress
}) {
  await fs.mkdir(gameDirectory, { recursive: true });
  const metadataDirectory = path.join(gameDirectory, '.tech-adventure-launcher');
  const runtimeStateFile = path.join(metadataDirectory, 'runtime-state.json');
  const runtimeState = await readJson(runtimeStateFile);

  emit(onProgress, 'minecraft', `Проверяю Minecraft ${minecraftVersion}…`, { indeterminate: true });
  const versionList = await getVersionList();
  const versionMeta = versionList.versions.find((entry) => entry.id === minecraftVersion);
  if (!versionMeta) throw new Error(`Minecraft ${minecraftVersion} отсутствует в официальном манифесте Mojang.`);

  const baseVersion = await install(versionMeta, gameDirectory, {
    side: 'client',
    assetsDownloadConcurrency: 16,
    librariesDownloadConcurrency: 8
  });
  const java = await ensureJava({
    component: baseVersion.javaVersion?.component || 'java-runtime-delta',
    runtimeRoot,
    customJavaPath,
    onProgress
  });

  let versionId = runtimeState?.minecraftVersion === minecraftVersion
    && runtimeState?.neoForgeVersion === neoForgeVersion
    ? runtimeState.versionId
    : '';
  let resolved = await parseInstalledVersion(gameDirectory, versionId);

  if (!resolved) {
    emit(onProgress, 'neoforge', `Устанавливаю NeoForge ${neoForgeVersion}…`, { indeterminate: true });
    versionId = await installNeoForged('neoforge', neoForgeVersion, gameDirectory, {
      side: 'client',
      java: java.installer,
      librariesDownloadConcurrency: 8
    });
    resolved = await Version.parse(gameDirectory, versionId);
  }

  emit(onProgress, 'dependencies', 'Проверяю библиотеки и ресурсы игры…', { indeterminate: true });
  resolved = await installDependencies(resolved, {
    side: 'client',
    assetsDownloadConcurrency: 16,
    librariesDownloadConcurrency: 8
  });
  await writeJsonAtomic(runtimeStateFile, {
    schemaVersion: 1,
    minecraftVersion,
    neoForgeVersion,
    versionId,
    javaComponent: baseVersion.javaVersion?.component || 'java-runtime-delta',
    verifiedAt: new Date().toISOString()
  });

  emit(onProgress, 'runtime-ready', 'Minecraft и NeoForge готовы.', { current: 1, total: 1 });
  return { versionId, resolved, java };
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
  const state = await readJson(path.join(gameDirectory, '.tech-adventure-launcher', 'runtime-state.json'));
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
  ensureJava,
  parseInstalledVersion,
  ensureMinecraft,
  parseServerAddress,
  launchMinecraft,
  inspectRuntimeState
};
