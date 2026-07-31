'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { writeJsonAtomic } = require('./settings');

const USER_AGENT = 'Tech-Adventure-Launcher/0.2.2';
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_ZIP_ENTRIES = 200000;
const MAX_UNCOMPRESSED_BYTES = 6 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const REQUIRED_ROOTS = new Set(['assets', 'libraries', 'meta']);
const REQUIRED_FILE = 'mmc-pack.json';

function emit(onProgress, phase, message, extra = {}) {
  onProgress?.({ phase, message, ...extra });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function validateGithubUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`${label}: указан некорректный URL.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label}: разрешён только HTTPS.`);
  const host = url.hostname.toLowerCase();
  const allowed = host === 'github.com'
    || host === 'raw.githubusercontent.com'
    || host.endsWith('.githubusercontent.com');
  if (!allowed) throw new Error(`${label}: файл должен загружаться с GitHub.`);
  return url.toString();
}

function normalizeComponent(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`Некорректный requiredComponents[${index}].`);
  const uid = String(raw.uid || '').trim();
  const version = String(raw.version || '').trim();
  if (!uid || !version) throw new Error(`Некорректный requiredComponents[${index}].`);
  return { uid, version };
}

function validateRuntimeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Манифест runtime должен быть JSON-объектом.');
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`Неподдерживаемая версия runtime-манифеста: ${raw.schemaVersion ?? 'не указана'}.`);
  }
  const runtimeVersion = String(raw.runtimeVersion || '').trim();
  const minecraftVersion = String(raw.minecraftVersion || '').trim();
  const neoForgeVersion = String(raw.neoForgeVersion || '').trim();
  if (!runtimeVersion || !minecraftVersion || !neoForgeVersion) {
    throw new Error('В runtime-манифесте не указаны версии runtime, Minecraft или NeoForge.');
  }
  const archive = raw.archive && typeof raw.archive === 'object' ? raw.archive : {};
  const sha256 = String(archive.sha256 || '').toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new Error('В runtime-манифесте не указан корректный SHA-256 архива.');
  const fileName = String(archive.fileName || '').trim();
  if (!fileName.toLowerCase().endsWith('.zip') || /[\\/]/.test(fileName)) {
    throw new Error('В runtime-манифесте указано некорректное имя ZIP-архива.');
  }
  const requiredArchiveEntries = Array.isArray(raw.requiredArchiveEntries)
    ? raw.requiredArchiveEntries.map((entry) => String(entry || '').replaceAll('\\', '/').replace(/\/+$/, ''))
    : [];
  for (const required of ['assets', 'libraries', 'meta', REQUIRED_FILE]) {
    if (!requiredArchiveEntries.includes(required)) {
      throw new Error(`Runtime-манифест не требует обязательный элемент ${required}.`);
    }
  }
  const requiredComponents = Array.isArray(raw.requiredComponents)
    ? raw.requiredComponents.map(normalizeComponent)
    : [];
  return {
    schemaVersion: 1,
    runtimeVersion,
    runtimeRevision: Number.isSafeInteger(Number(raw.runtimeRevision)) ? Number(raw.runtimeRevision) : 1,
    sourceFormat: String(raw.sourceFormat || 'prismlauncher'),
    minecraftVersion,
    neoForgeVersion,
    lwjglVersion: String(raw.lwjglVersion || ''),
    archive: {
      fileName,
      url: validateGithubUrl(archive.url, 'Архив runtime'),
      sha256
    },
    requiredArchiveEntries,
    requiredComponents
  };
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchRuntimeManifest({ runtimeManifestUrl, metadataDirectory, onProgress }) {
  const safeUrl = validateGithubUrl(runtimeManifestUrl, 'Манифест runtime');
  const cacheFile = path.join(metadataDirectory, 'last-runtime-manifest.json');
  emit(onProgress, 'runtime-manifest', 'Получаю манифест базовой игровой среды…', { indeterminate: true });
  try {
    const response = await fetch(safeUrl, {
      redirect: 'follow',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) throw new Error(`GitHub ответил ${response.status} ${response.statusText}.`);
    const manifest = validateRuntimeManifest(await response.json());
    await writeJsonAtomic(cacheFile, manifest);
    return { manifest, fromCache: false, warning: '' };
  } catch (error) {
    const rawCached = await readJson(cacheFile, null);
    if (!rawCached) throw error;
    const cached = validateRuntimeManifest(rawCached);
    return {
      manifest: cached,
      fromCache: true,
      warning: `GitHub недоступен; используется сохранённый runtime-манифест ${cached.runtimeVersion}.`
    };
  }
}

function runtimeMetadataDirectory(gameDirectory) {
  return path.join(gameDirectory, '.tech-adventure-launcher');
}

function bootstrapStatePath(gameDirectory) {
  return path.join(runtimeMetadataDirectory(gameDirectory), 'bootstrap-state.json');
}

async function isBootstrapInstalled(gameDirectory, manifest) {
  const state = await readJson(bootstrapStatePath(gameDirectory), null);
  if (!state || state.runtimeVersion !== manifest.runtimeVersion || state.archiveSha256 !== manifest.archive.sha256) {
    return false;
  }
  return (await exists(path.join(gameDirectory, 'assets')))
    && (await exists(path.join(gameDirectory, 'libraries')))
    && (await exists(path.join(runtimeMetadataDirectory(gameDirectory), 'prism-runtime', 'meta')))
    && (await exists(path.join(runtimeMetadataDirectory(gameDirectory), 'prism-runtime', REQUIRED_FILE)));
}

function progressTransform(onChunk) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      onChunk(chunk.length);
      callback(null, chunk);
    }
  });
}

async function downloadArchive(manifest, destination, onProgress) {
  const failures = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fsp.rm(destination, { force: true });
    try {
      const response = await fetch(manifest.archive.url, {
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      });
      if (!response.ok || !response.body) {
        throw new Error(`GitHub ответил ${response.status} ${response.statusText}.`);
      }
      const total = Number(response.headers.get('content-length')) || 0;
      let current = 0;
      const digest = crypto.createHash('sha256');
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      const hashing = new Transform({
        transform(chunk, _encoding, callback) {
          digest.update(chunk);
          callback(null, chunk);
        }
      });
      await pipeline(
        Readable.fromWeb(response.body),
        progressTransform((bytes) => {
          current += bytes;
          emit(onProgress, 'runtime-download', 'Загружаю базовую игровую среду…', {
            current,
            total,
            indeterminate: total <= 0,
            file: manifest.archive.fileName
          });
        }),
        hashing,
        fs.createWriteStream(destination, { flags: 'wx' })
      );
      const actual = digest.digest('hex');
      if (actual !== manifest.archive.sha256) {
        throw new Error(`SHA-256 runtime-архива не совпал. Ожидался ${manifest.archive.sha256}, получен ${actual}.`);
      }
      return;
    } catch (error) {
      failures.push(error);
      await fsp.rm(destination, { force: true });
      if (attempt >= 3) break;
      emit(onProgress, 'retry', `Загрузка runtime не удалась. Повтор ${attempt + 1} из 3…`, {
        indeterminate: true,
        attempt: attempt + 1,
        attempts: 3
      });
      await sleep(attempt * 1500);
    }
  }
  throw new AggregateError(failures, 'Не удалось загрузить базовую игровую среду после трёх попыток.');
}

function normalizeZipPath(fileName) {
  const slashPath = String(fileName || '').replaceAll('\\', '/');
  if (!slashPath || slashPath.includes('\0') || slashPath.startsWith('/') || /^[A-Za-z]:/.test(slashPath)) {
    throw new Error(`Runtime-архив содержит недопустимый путь: ${fileName}`);
  }
  const segments = slashPath.split('/').filter(Boolean);
  if (!segments.length || segments.includes('..') || segments.some((segment) => segment === '.')) {
    throw new Error(`Runtime-архив содержит недопустимый путь: ${fileName}`);
  }
  const normalized = segments.join('/');
  const root = segments[0].toLowerCase();
  if (!REQUIRED_ROOTS.has(root) && normalized.toLowerCase() !== REQUIRED_FILE) {
    throw new Error(`Runtime-архив содержит лишний элемент ${normalized}.`);
  }
  if (normalized.toLowerCase() === REQUIRED_FILE && segments.length !== 1) {
    throw new Error(`${REQUIRED_FILE} должен лежать в корне runtime-архива.`);
  }
  return normalized;
}

function isUnsafeZipLink(entry) {
  const platform = (entry.versionMadeBy >>> 8) & 0xff;
  if (platform !== 3) return false;
  const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
  return fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000;
}

async function extractRuntimeArchive(archiveFile, extractionDirectory, onProgress) {
  await fsp.rm(extractionDirectory, { recursive: true, force: true });
  await fsp.mkdir(extractionDirectory, { recursive: true });
  let entries = 0;
  let extractedBytes = 0;
  let declaredBytes = 0;
  const seenRoots = new Set();
  let hasPack = false;

  const zipfile = await yauzl.openPromise(archiveFile, {
    autoClose: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: false
  });
  try {
    for await (const entry of zipfile.eachEntry()) {
      entries += 1;
      if (entries > MAX_ZIP_ENTRIES) throw new Error('Runtime-архив содержит слишком много записей.');
      if (entry.isEncrypted()) throw new Error('Runtime-архив содержит зашифрованный файл.');
      if (isUnsafeZipLink(entry)) throw new Error('Runtime-архив содержит ссылку вместо обычного файла.');
      declaredBytes += Number(entry.uncompressedSize || 0);
      if (declaredBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('Распакованный runtime превышает допустимый размер.');

      const directory = entry.fileName.endsWith('/');
      const normalized = normalizeZipPath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      const root = normalized.split('/')[0].toLowerCase();
      if (REQUIRED_ROOTS.has(root)) seenRoots.add(root);
      if (normalized.toLowerCase() === REQUIRED_FILE) hasPack = true;
      const destination = path.resolve(extractionDirectory, ...normalized.split('/'));
      const rootPath = path.resolve(extractionDirectory);
      if (destination !== rootPath && !destination.startsWith(`${rootPath}${path.sep}`)) {
        throw new Error(`Runtime-архив пытается записать файл за пределами папки: ${normalized}`);
      }
      if (directory) {
        await fsp.mkdir(destination, { recursive: true });
        continue;
      }

      await fsp.mkdir(path.dirname(destination), { recursive: true });
      const readStream = await zipfile.openReadStreamPromise(entry);
      await pipeline(
        readStream,
        progressTransform((bytes) => {
          extractedBytes += bytes;
          emit(onProgress, 'runtime-extract', `Распаковываю базовую среду: ${entries} файлов обработано`, {
            current: extractedBytes,
            total: declaredBytes,
            indeterminate: true,
            file: normalized
          });
        }),
        fs.createWriteStream(destination, { flags: 'wx' })
      );
    }
  } finally {
    zipfile.close();
  }

  for (const root of REQUIRED_ROOTS) {
    if (!seenRoots.has(root) || !(await exists(path.join(extractionDirectory, root)))) {
      throw new Error(`В runtime-архиве отсутствует папка ${root}.`);
    }
  }
  if (!hasPack || !(await exists(path.join(extractionDirectory, REQUIRED_FILE)))) {
    throw new Error(`В runtime-архиве отсутствует ${REQUIRED_FILE}.`);
  }
}

function componentMap(pack) {
  const result = new Map();
  if (!pack || !Array.isArray(pack.components)) return result;
  for (const component of pack.components) {
    const uid = String(component?.uid || '').trim();
    const version = String(component?.version || component?.cachedVersion || '').trim();
    if (uid && version) result.set(uid, version);
  }
  return result;
}

async function validateExtractedRuntime(extractionDirectory, manifest) {
  const pack = await readJson(path.join(extractionDirectory, REQUIRED_FILE), null);
  const components = componentMap(pack);
  if (components.get('net.minecraft') !== manifest.minecraftVersion) {
    throw new Error(`Runtime содержит Minecraft ${components.get('net.minecraft') || 'неизвестной версии'}, ожидался ${manifest.minecraftVersion}.`);
  }
  if (components.get('net.neoforged') !== manifest.neoForgeVersion) {
    throw new Error(`Runtime содержит NeoForge ${components.get('net.neoforged') || 'неизвестной версии'}, ожидался ${manifest.neoForgeVersion}.`);
  }
  for (const required of manifest.requiredComponents) {
    if (components.get(required.uid) !== required.version) {
      throw new Error(`Runtime-компонент ${required.uid} имеет версию ${components.get(required.uid) || 'неизвестно'}, ожидалась ${required.version}.`);
    }
  }
}

async function renameWithRetry(from, to) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 4) throw error;
      await sleep(200 * (attempt + 1));
    }
  }
  throw lastError;
}


async function installExtractedRuntime({ extractionDirectory, gameDirectory, manifest }) {
  const metadataDirectory = runtimeMetadataDirectory(gameDirectory);
  const backupRoot = path.join(metadataDirectory, 'runtime-backup');
  const prismDestination = path.join(metadataDirectory, 'prism-runtime');
  const installed = [];

  await fsp.rm(backupRoot, { recursive: true, force: true });
  await fsp.mkdir(backupRoot, { recursive: true });
  await fsp.rm(prismDestination, { recursive: true, force: true });

  try {
    for (const name of ['assets', 'libraries']) {
      const source = path.join(extractionDirectory, name);
      const destination = path.join(gameDirectory, name);
      const backup = path.join(backupRoot, name);
      const hadBackup = await exists(destination);
      if (hadBackup) await renameWithRetry(destination, backup);
      try {
        await renameWithRetry(source, destination);
        installed.push({ destination, backup, hadBackup });
      } catch (error) {
        if (hadBackup && !(await exists(destination))) {
          await renameWithRetry(backup, destination).catch(() => {});
        }
        throw error;
      }
    }

    await fsp.mkdir(prismDestination, { recursive: true });
    await renameWithRetry(path.join(extractionDirectory, 'meta'), path.join(prismDestination, 'meta'));
    await renameWithRetry(path.join(extractionDirectory, REQUIRED_FILE), path.join(prismDestination, REQUIRED_FILE));

    await writeJsonAtomic(bootstrapStatePath(gameDirectory), {
      schemaVersion: 1,
      runtimeVersion: manifest.runtimeVersion,
      runtimeRevision: manifest.runtimeRevision,
      minecraftVersion: manifest.minecraftVersion,
      neoForgeVersion: manifest.neoForgeVersion,
      archiveSha256: manifest.archive.sha256,
      installedAt: new Date().toISOString()
    });
  } catch (error) {
    await fsp.rm(prismDestination, { recursive: true, force: true });
    for (const entry of installed.reverse()) {
      await fsp.rm(entry.destination, { recursive: true, force: true });
      if (entry.hadBackup && await exists(entry.backup)) {
        await renameWithRetry(entry.backup, entry.destination).catch(() => {});
      }
    }
    throw error;
  } finally {
    await fsp.rm(backupRoot, { recursive: true, force: true });
  }
}

async function ensureRuntimeBootstrap({
  runtimeManifestUrl,
  gameDirectory,
  expectedMinecraftVersion,
  expectedNeoForgeVersion,
  onProgress
}) {
  if (!runtimeManifestUrl) throw new Error('Не настроена ссылка на runtime-manifest.json.');
  await fsp.mkdir(gameDirectory, { recursive: true });
  const metadataDirectory = runtimeMetadataDirectory(gameDirectory);
  await fsp.mkdir(metadataDirectory, { recursive: true });
  const loaded = await fetchRuntimeManifest({ runtimeManifestUrl, metadataDirectory, onProgress });
  const { manifest } = loaded;
  if (manifest.minecraftVersion !== expectedMinecraftVersion || manifest.neoForgeVersion !== expectedNeoForgeVersion) {
    throw new Error(
      `Runtime рассчитан на Minecraft ${manifest.minecraftVersion} / NeoForge ${manifest.neoForgeVersion}, `
      + `а сборке нужны ${expectedMinecraftVersion} / ${expectedNeoForgeVersion}.`
    );
  }
  if (await isBootstrapInstalled(gameDirectory, manifest)) {
    emit(onProgress, 'runtime-bootstrap-ready', `Базовая среда ${manifest.runtimeVersion} уже установлена.`, {
      current: 1,
      total: 1,
      reused: true
    });
    return { manifest, reused: true, warning: loaded.warning };
  }

  const transactionDirectory = await fsp.mkdtemp(path.join(metadataDirectory, 'runtime-install-'));
  const archiveFile = path.join(transactionDirectory, manifest.archive.fileName);
  const extractionDirectory = path.join(transactionDirectory, 'extracted');
  try {
    await downloadArchive(manifest, archiveFile, onProgress);
    emit(onProgress, 'runtime-verify', 'SHA-256 runtime-архива проверен.', { current: 1, total: 1 });
    await extractRuntimeArchive(archiveFile, extractionDirectory, onProgress);
    await validateExtractedRuntime(extractionDirectory, manifest);
    emit(onProgress, 'runtime-install', 'Устанавливаю базовую игровую среду…', { indeterminate: true });
    await installExtractedRuntime({ extractionDirectory, gameDirectory, manifest });
  } finally {
    await fsp.rm(transactionDirectory, { recursive: true, force: true });
  }
  emit(onProgress, 'runtime-bootstrap-ready', `Базовая среда ${manifest.runtimeVersion} установлена.`, {
    current: 1,
    total: 1,
    reused: false
  });
  return { manifest, reused: false, warning: loaded.warning };
}

module.exports = {
  validateRuntimeManifest,
  normalizeZipPath,
  componentMap,
  fetchRuntimeManifest,
  extractRuntimeArchive,
  validateExtractedRuntime,
  ensureRuntimeBootstrap,
  bootstrapStatePath,
  isBootstrapInstalled
};
