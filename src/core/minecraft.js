'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Version, launch, createMinecraftProcessWatcher } = require('@xmcl/core');
const { writeJsonAtomic } = require('./settings');

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
  timeoutMs = 45 * 1000,
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

async function removeZeroByteFiles(directory) {
  const queue = [directory];
  let removed = 0;
  while (queue.length) {
    const current = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(target);
      } else if (entry.isFile()) {
        const stat = await fs.stat(target);
        if (stat.size === 0) {
          await fs.rm(target, { force: true });
          removed += 1;
        }
      }
    }
  }
  return removed;
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

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
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
    && runtimeState.schemaVersion === 2
    && runtimeState.minecraftVersion === minecraftVersion
    && runtimeState.neoForgeVersion === neoForgeVersion
    && runtimeState.versionId
    && runtimeState.javaExecutable
  );
}

async function parseInstalledVersion(gameDirectory, versionId) {
  if (!versionId) return null;
  try {
    return await Version.parse(gameDirectory, versionId);
  } catch {
    return null;
  }
}

async function verifyRequiredFiles(gameDirectory, requiredFiles = []) {
  for (const relative of requiredFiles) {
    const safe = String(relative || '').replaceAll('\\', '/');
    if (!safe || safe.startsWith('/') || safe.includes('..') || /^[A-Za-z]:/.test(safe)) {
      throw new Error(`В состоянии runtime указан недопустимый путь: ${relative}`);
    }
    const target = path.resolve(gameDirectory, ...safe.split('/'));
    const root = path.resolve(gameDirectory);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`В состоянии runtime указан путь за пределами игровой папки: ${relative}`);
    }
    if (!(await isFile(target))) {
      throw new Error(`Базовая игровая среда повреждена: отсутствует ${safe}.`);
    }
  }
}

async function findExistingJava({
  gameDirectory,
  customJavaPath,
  javaExecutable = 'java/bin/javaw.exe',
  javaConsoleExecutable = 'java/bin/java.exe'
}) {
  if (customJavaPath) {
    const java = path.resolve(customJavaPath);
    if (!(await isFile(java))) throw new Error(`Java не найдена: ${java}`);
    const version = await runJavaVersion(java);
    if (version.major < 21) {
      throw new Error(`Для Minecraft 1.21.1 нужна Java 21 или новее, а выбрана Java ${version.major}.`);
    }
    return { installer: java, launcher: java, managed: false, major: version.major };
  }

  const launcher = path.join(gameDirectory, ...String(javaExecutable).replaceAll('\\', '/').split('/'));
  const installerCandidate = path.join(
    gameDirectory,
    ...String(javaConsoleExecutable).replaceAll('\\', '/').split('/')
  );
  const installer = await isFile(installerCandidate) ? installerCandidate : launcher;
  if (!(await isFile(launcher)) || !(await isFile(installer))) return null;

  const version = await runJavaVersion(installer);
  if (version.major < 21) {
    throw new Error(`В базовом runtime находится неподходящая Java ${version.major}.`);
  }
  return { installer, launcher, managed: true, major: version.major };
}

async function ensureJava(options) {
  const java = await findExistingJava(options);
  if (!java) {
    throw new Error('Java 21 отсутствует в локальном runtime. Повтори проверку файлов для переустановки базовой среды.');
  }
  return java;
}

async function loadInstalledRuntime({
  gameDirectory,
  minecraftVersion,
  neoForgeVersion,
  customJavaPath,
  onProgress
}) {
  const runtimeState = await readJson(runtimeStatePath(gameDirectory));
  if (!matchesRuntimeState(runtimeState, minecraftVersion, neoForgeVersion)) return null;

  emit(onProgress, 'runtime', 'Проверяю локальные Minecraft, NeoForge и Java…', { indeterminate: true });
  await verifyRequiredFiles(gameDirectory, runtimeState.requiredFiles || []);
  const resolved = await parseInstalledVersion(gameDirectory, runtimeState.versionId);
  if (!resolved) {
    throw new Error(`Не удалось прочитать локальный профиль ${runtimeState.versionId}.`);
  }

  const java = await ensureJava({
    gameDirectory,
    customJavaPath,
    javaExecutable: runtimeState.javaExecutable,
    javaConsoleExecutable: runtimeState.javaConsoleExecutable
  });

  return {
    versionId: runtimeState.versionId,
    resolved,
    java,
    reused: true,
    runtimeVersion: runtimeState.runtimeVersion || '',
    runtimeRevision: Number(runtimeState.runtimeRevision || 0)
  };
}

async function ensureMinecraft({
  gameDirectory,
  minecraftVersion,
  neoForgeVersion,
  customJavaPath,
  onProgress,
  force = false
}) {
  await fs.mkdir(gameDirectory, { recursive: true });
  const installed = await loadInstalledRuntime({
    gameDirectory,
    minecraftVersion,
    neoForgeVersion,
    customJavaPath,
    onProgress
  });
  if (!installed) {
    throw new Error(
      'Локальный runtime Minecraft и NeoForge не установлен. '
      + 'Лаунчер не будет загружать игру с серверов Mojang; повтори проверку файлов для установки runtime с GitHub.'
    );
  }

  if (force) {
    const stateFile = runtimeStatePath(gameDirectory);
    const state = await readJson(stateFile) || {};
    await writeJsonAtomic(stateFile, {
      ...state,
      verifiedAt: new Date().toISOString()
    });
  }

  emit(onProgress, 'runtime-ready', 'Локальные Minecraft, NeoForge и Java готовы.', {
    current: 1,
    total: 1,
    reused: true,
    verified: Boolean(force)
  });
  return { ...installed, verified: Boolean(force) };
}

function replaceAccountLaunchPlaceholders(value, replacements) {
  if (typeof value === 'string') {
    return value
      .replaceAll('${clientid}', replacements.clientId)
      .replaceAll('${auth_xuid}', replacements.xuid);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceAccountLaunchPlaceholders(entry, replacements));
  }
  return value;
}

function withMicrosoftLaunchArguments(resolvedVersion, session) {
  if (session?.mode !== 'microsoft') return resolvedVersion;

  const accessToken = String(session.accessToken || '').trim();
  const clientId = String(session.clientId || '').trim();
  const xuidCandidate = String(session.xuid || '').trim();
  const xuid = /^\d+$/.test(xuidCandidate) ? xuidCandidate : '0';
  if (!accessToken) throw new Error('Microsoft-сессия не содержит токен Minecraft. Обнови вход в лаунчере.');
  if (!clientId) throw new Error('Microsoft-сессия не содержит Client ID. Обнови вход в лаунчере.');

  const gameArguments = resolvedVersion?.arguments?.game;
  if (!Array.isArray(gameArguments)) {
    throw new Error('Профиль Minecraft не содержит игровых аргументов для Microsoft-входа.');
  }

  const replacements = { clientId, xuid };
  const patchedGameArguments = gameArguments.map((argument) => {
    if (typeof argument === 'string' || Array.isArray(argument)) {
      return replaceAccountLaunchPlaceholders(argument, replacements);
    }
    if (!argument || typeof argument !== 'object') return argument;
    return {
      ...argument,
      value: replaceAccountLaunchPlaceholders(argument.value, replacements)
    };
  });

  const serialized = JSON.stringify(patchedGameArguments);
  if (serialized.includes('${clientid}') || serialized.includes('${auth_xuid}')) {
    throw new Error('Не удалось подготовить аргументы лицензионного запуска Minecraft.');
  }

  return {
    ...resolvedVersion,
    arguments: {
      ...resolvedVersion.arguments,
      game: patchedGameArguments
    }
  };
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
  const launchVersion = withMicrosoftLaunchArguments(runtime.resolved, session);
  const child = await launch({
    gamePath: gameDirectory,
    resourcePath: gameDirectory,
    javaPath: runtime.java.launcher,
    version: launchVersion,
    gameProfile: {
      id: session.profile.id.replaceAll('-', ''),
      name: session.profile.name
    },
    accessToken: session.accessToken,
    userType: session.userType,
    properties: {},
    launcherName: 'DekodevRebornLauncher',
    launcherBrand: 'dekodev-reborn',
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
  if (!state || state.schemaVersion !== 2) return { installed: false };
  const parsed = await parseInstalledVersion(gameDirectory, state.versionId);
  let requiredFilesPresent = true;
  try {
    await verifyRequiredFiles(gameDirectory, state.requiredFiles || []);
  } catch {
    requiredFilesPresent = false;
  }
  return {
    installed: Boolean(parsed) && requiredFilesPresent,
    minecraftVersion: state.minecraftVersion || '',
    neoForgeVersion: state.neoForgeVersion || '',
    versionId: state.versionId || '',
    runtimeVersion: state.runtimeVersion || '',
    runtimeRevision: Number(state.runtimeRevision || 0)
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
  replaceAccountLaunchPlaceholders,
  withMicrosoftLaunchArguments,
  launchMinecraft,
  inspectRuntimeState,
  withTimeout,
  retryNetworkOperation,
  removeZeroByteFiles,
  verifyRequiredFiles,
  runtimeStatePath
};
