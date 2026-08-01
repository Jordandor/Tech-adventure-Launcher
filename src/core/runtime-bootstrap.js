'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { writeJsonAtomic } = require('./settings');

const USER_AGENT = 'Dekodev-Reborn-Launcher/0.2.9';
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_ZIP_ENTRIES = 200000;
const MAX_UNCOMPRESSED_BYTES = 6 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const REQUIRED_ROOTS = new Set(['assets', 'libraries', 'versions', 'java']);

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

function normalizeRelativePath(value, label) {
  const slashPath = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!slashPath || slashPath.includes('\0') || slashPath.startsWith('/') || /^[A-Za-z]:/.test(slashPath)) {
    throw new Error(`${label}: указан недопустимый путь.`);
  }
  const segments = slashPath.split('/').filter(Boolean);
  if (!segments.length || segments.includes('..') || segments.some((segment) => segment === '.')) {
    throw new Error(`${label}: указан недопустимый путь.`);
  }
  const normalized = segments.join('/');
  if (!REQUIRED_ROOTS.has(segments[0].toLowerCase())) {
    throw new Error(`${label}: путь должен находиться внутри assets, libraries, versions или java.`);
  }
  return normalized;
}

function validateRuntimeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Манифест runtime должен быть JSON-объектом.');
  }
  if (raw.schemaVersion !== 2) {
    throw new Error(`Неподдерживаемая версия runtime-манифеста: ${raw.schemaVersion ?? 'не указана'}.`);
  }

  const runtimeVersion = String(raw.runtimeVersion || '').trim();
  const minecraftVersion = String(raw.minecraftVersion || '').trim();
  const neoForgeVersion = String(raw.neoForgeVersion || '').trim();
  const versionId = String(raw.versionId || '').trim();
  const baseVersionId = String(raw.baseVersionId || '').trim();
  const sourceFormat = String(raw.sourceFormat || '').trim();
  const platform = String(raw.platform || '').trim();
  if (!runtimeVersion || !minecraftVersion || !neoForgeVersion || !versionId || !baseVersionId) {
    throw new Error('В runtime-манифесте не указаны версии runtime, Minecraft, NeoForge или ID профилей.');
  }
  if (sourceFormat !== 'standard-minecraft-launcher') {
    throw new Error(`Неподдерживаемый формат runtime: ${sourceFormat || 'не указан'}.`);
  }
  if (platform !== 'windows-x64') {
    throw new Error(`Неподдерживаемая платформа runtime: ${platform || 'не указана'}.`);
  }
  if (versionId !== `neoforge-${neoForgeVersion}`) {
    throw new Error('ID профиля NeoForge не соответствует указанной версии NeoForge.');
  }
  if (baseVersionId !== minecraftVersion) {
    throw new Error('ID базового профиля не соответствует версии Minecraft.');
  }

  const archive = raw.archive && typeof raw.archive === 'object' ? raw.archive : {};
  const sha256 = String(archive.sha256 || '').toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new Error('В runtime-манифесте не указан корректный SHA-256 архива.');
  const fileName = String(archive.fileName || '').trim();
  if (!fileName.toLowerCase().endsWith('.zip') || /[\\/]/.test(fileName)) {
    throw new Error('В runtime-манифесте указано некорректное имя ZIP-архива.');
  }

  const requiredArchiveEntries = Array.isArray(raw.requiredArchiveEntries)
    ? raw.requiredArchiveEntries.map((entry) => String(entry || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase())
    : [];
  for (const required of REQUIRED_ROOTS) {
    if (!requiredArchiveEntries.includes(required)) {
      throw new Error(`Runtime-манифест не требует обязательную папку ${required}.`);
    }
  }

  const java = raw.java && typeof raw.java === 'object' ? raw.java : {};
  const javaMajorVersion = Number(java.majorVersion);
  if (!Number.isInteger(javaMajorVersion) || javaMajorVersion < 21) {
    throw new Error('Runtime должен содержать Java 21 или новее.');
  }
  const javaExecutable = normalizeRelativePath(java.executable, 'Исполняемый файл Java');
  const javaConsoleExecutable = normalizeRelativePath(java.consoleExecutable, 'Консольный файл Java');
  if (!javaExecutable.toLowerCase().startsWith('java/') || !javaConsoleExecutable.toLowerCase().startsWith('java/')) {
    throw new Error('Исполняемые файлы Java должны находиться в папке java.');
  }

  const requiredFiles = Array.isArray(raw.requiredFiles)
    ? raw.requiredFiles.map((entry, index) => normalizeRelativePath(entry, `requiredFiles[${index}]`))
    : [];
  if (!requiredFiles.length) throw new Error('Runtime-манифест не содержит список обязательных файлов.');
  for (const required of [
    `versions/${baseVersionId}/${baseVersionId}.jar`,
    `versions/${baseVersionId}/${baseVersionId}.json`,
    `versions/${versionId}/${versionId}.json`,
    javaExecutable,
    javaConsoleExecutable
  ]) {
    if (!requiredFiles.includes(required)) {
      throw new Error(`Runtime-манифест не требует обязательный файл ${required}.`);
    }
  }

  return {
    schemaVersion: 2,
    runtimeVersion,
    runtimeRevision: Number.isSafeInteger(Number(raw.runtimeRevision)) ? Number(raw.runtimeRevision) : 2,
    sourceFormat,
    platform,
    minecraftVersion,
    neoForgeVersion,
    versionId,
    baseVersionId,
    java: {
      majorVersion: javaMajorVersion,
      executable: javaExecutable,
      consoleExecutable: javaConsoleExecutable
    },
    archive: {
      fileName,
      url: validateGithubUrl(archive.url, 'Архив runtime'),
      sha256
    },
    requiredArchiveEntries: [...new Set(requiredArchiveEntries)],
    requiredFiles: [...new Set(requiredFiles)]
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
  const cacheFile = path.join(metadataDirectory, 'last-runtime-manifest-v2.json');
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

function runtimeStatePath(gameDirectory) {
  return path.join(runtimeMetadataDirectory(gameDirectory), 'runtime-state.json');
}

async function hasRequiredFiles(root, requiredFiles) {
  for (const relative of requiredFiles) {
    if (!(await exists(path.join(root, ...relative.split('/'))))) return false;
  }
  return true;
}

async function isBootstrapInstalled(gameDirectory, manifest) {
  const state = await readJson(bootstrapStatePath(gameDirectory), null);
  if (
    !state
    || state.schemaVersion !== 2
    || state.runtimeVersion !== manifest.runtimeVersion
    || state.archiveSha256 !== manifest.archive.sha256
    || state.versionId !== manifest.versionId
  ) {
    return false;
  }
  for (const root of REQUIRED_ROOTS) {
    if (!(await exists(path.join(gameDirectory, root)))) return false;
  }
  return hasRequiredFiles(gameDirectory, manifest.requiredFiles);
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
          emit(onProgress, 'runtime-download', 'Загружаю Minecraft, NeoForge и Java с GitHub…', {
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
  const normalized = normalizeRelativePath(fileName, 'Runtime-архив');
  const root = normalized.split('/')[0].toLowerCase();
  if (!REQUIRED_ROOTS.has(root)) {
    throw new Error(`Runtime-архив содержит лишний элемент ${normalized}.`);
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
      const rawName = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      if (!rawName) continue;
      const normalized = normalizeZipPath(rawName);
      const root = normalized.split('/')[0].toLowerCase();
      seenRoots.add(root);
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
}

async function validateExtractedRuntime(extractionDirectory, manifest) {
  if (!(await hasRequiredFiles(extractionDirectory, manifest.requiredFiles))) {
    for (const relative of manifest.requiredFiles) {
      if (!(await exists(path.join(extractionDirectory, ...relative.split('/'))))) {
        throw new Error(`В runtime-архиве отсутствует обязательный файл ${relative}.`);
      }
    }
  }

  const baseVersionFile = path.join(
    extractionDirectory,
    'versions',
    manifest.baseVersionId,
    `${manifest.baseVersionId}.json`
  );
  const neoForgeVersionFile = path.join(
    extractionDirectory,
    'versions',
    manifest.versionId,
    `${manifest.versionId}.json`
  );
  const base = await readJson(baseVersionFile, null);
  const neoForge = await readJson(neoForgeVersionFile, null);
  if (base?.id !== manifest.baseVersionId) {
    throw new Error(`Базовый профиль runtime имеет ID ${base?.id || 'неизвестно'}, ожидался ${manifest.baseVersionId}.`);
  }
  const profileJavaMajor = Number(base?.javaVersion?.majorVersion);
  if (!Number.isInteger(profileJavaMajor) || profileJavaMajor < manifest.java.majorVersion) {
    throw new Error(`Профиль Minecraft требует неподходящую Java ${base?.javaVersion?.majorVersion || 'неизвестно'}.`);
  }
  if (neoForge?.id !== manifest.versionId || neoForge?.inheritsFrom !== manifest.baseVersionId) {
    throw new Error('Профиль NeoForge не соответствует указанным версиям Minecraft и NeoForge.');
  }
  const gameArguments = Array.isArray(neoForge?.arguments?.game) ? neoForge.arguments.game.map(String) : [];
  const neoForgeFlag = gameArguments.indexOf('--fml.neoForgeVersion');
  if (neoForgeFlag < 0 || gameArguments[neoForgeFlag + 1] !== manifest.neoForgeVersion) {
    throw new Error('В профиле NeoForge указана другая версия загрузчика.');
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
  const installed = [];
  const previousBootstrapState = await readJson(bootstrapStatePath(gameDirectory), null);
  const previousRuntimeState = await readJson(runtimeStatePath(gameDirectory), null);

  await fsp.rm(backupRoot, { recursive: true, force: true });
  await fsp.mkdir(backupRoot, { recursive: true });

  try {
    for (const name of REQUIRED_ROOTS) {
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

    const installedAt = new Date().toISOString();
    await writeJsonAtomic(bootstrapStatePath(gameDirectory), {
      schemaVersion: 2,
      runtimeVersion: manifest.runtimeVersion,
      runtimeRevision: manifest.runtimeRevision,
      minecraftVersion: manifest.minecraftVersion,
      neoForgeVersion: manifest.neoForgeVersion,
      versionId: manifest.versionId,
      baseVersionId: manifest.baseVersionId,
      archiveSha256: manifest.archive.sha256,
      requiredFiles: manifest.requiredFiles,
      installedAt
    });
    await writeJsonAtomic(runtimeStatePath(gameDirectory), {
      schemaVersion: 2,
      runtimeVersion: manifest.runtimeVersion,
      runtimeRevision: manifest.runtimeRevision,
      minecraftVersion: manifest.minecraftVersion,
      neoForgeVersion: manifest.neoForgeVersion,
      versionId: manifest.versionId,
      baseVersionId: manifest.baseVersionId,
      javaMajorVersion: manifest.java.majorVersion,
      javaExecutable: manifest.java.executable,
      javaConsoleExecutable: manifest.java.consoleExecutable,
      requiredFiles: manifest.requiredFiles,
      archiveSha256: manifest.archive.sha256,
      installedAt,
      verifiedAt: installedAt
    });
    await fsp.rm(path.join(metadataDirectory, 'prism-runtime'), { recursive: true, force: true });
  } catch (error) {
    if (previousBootstrapState) {
      await writeJsonAtomic(bootstrapStatePath(gameDirectory), previousBootstrapState).catch(() => {});
    } else {
      await fsp.rm(bootstrapStatePath(gameDirectory), { force: true }).catch(() => {});
    }
    if (previousRuntimeState) {
      await writeJsonAtomic(runtimeStatePath(gameDirectory), previousRuntimeState).catch(() => {});
    } else {
      await fsp.rm(runtimeStatePath(gameDirectory), { force: true }).catch(() => {});
    }
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
  if (!runtimeManifestUrl) throw new Error('Не настроена ссылка на runtime-manifest-v2.json.');
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Текущий runtime поддерживает только Windows x64.');
  }
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
    emit(onProgress, 'runtime-install', 'Устанавливаю Minecraft, NeoForge и Java из локального архива…', {
      indeterminate: true
    });
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
  fetchRuntimeManifest,
  extractRuntimeArchive,
  validateExtractedRuntime,
  ensureRuntimeBootstrap,
  bootstrapStatePath,
  runtimeStatePath,
  isBootstrapInstalled,
  hasRequiredFiles
};
