'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const {
  normalizeManagedPath,
  normalizePackPath,
  safeDestination,
  safePackDestination,
  validateManifest,
  validateGithubUrl
} = require('./manifest');
const { writeJsonAtomic } = require('./settings');
const { isManagedModPath, disabledManagedPath } = require('./mod-manager');

const USER_AGENT = 'Dekodev-Reborn-Launcher/0.2.10';
const MAX_ZIP_ENTRIES = 50000;

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingManagedDestination(gameDirectory, managedPath, destinationResolver) {
  const active = destinationResolver(gameDirectory, managedPath);
  if (await exists(active)) return { destination: active, disabled: false };
  if (!isManagedModPath(managedPath)) return { destination: active, disabled: false };
  const disabledPath = disabledManagedPath(managedPath);
  const disabled = destinationResolver(gameDirectory, disabledPath);
  if (await exists(disabled)) return { destination: disabled, disabled: true };
  return { destination: active, disabled: false };
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function fetchJson(url, { timeoutMs = 30000 } = {}) {
  const safeUrl = validateGithubUrl(url, 'Манифест сборки');
  const response = await fetch(safeUrl, {
    redirect: 'follow',
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Сервер манифеста ответил ${response.status} ${response.statusText}.`);
  }
  return response.json();
}

async function readJsonOr(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadManifest({ manifestUrl, metadataDirectory, onProgress }) {
  const cacheFile = path.join(metadataDirectory, 'last-manifest.json');
  onProgress?.({ phase: 'manifest', message: 'Получаю манифест сборки…', indeterminate: true });
  try {
    const manifest = validateManifest(await fetchJson(manifestUrl));
    await writeJsonAtomic(cacheFile, manifest);
    return { manifest, fromCache: false, warning: '' };
  } catch (error) {
    const cached = await readJsonOr(cacheFile, null);
    if (!cached) throw error;
    const manifest = validateManifest(cached);
    return {
      manifest,
      fromCache: true,
      warning: `GitHub недоступен; используется сохранённый манифест ${manifest.pack.version}.`
    };
  }
}

function progressTransform(onChunk) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      onChunk(chunk.length);
      callback(null, chunk);
    }
  });
}

async function downloadFile(entry, destination, onBytes) {
  const label = entry.path || entry.id || 'архив сборки';
  const response = await fetch(entry.url, {
    redirect: 'follow',
    headers: { 'user-agent': USER_AGENT }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Не удалось скачать ${label}: ${response.status} ${response.statusText}.`);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.rm(destination, { force: true });
  await pipeline(
    Readable.fromWeb(response.body),
    progressTransform(onBytes),
    fs.createWriteStream(destination, { flags: 'wx' })
  );
  const stat = await fsp.stat(destination);
  if (stat.size !== entry.size) {
    await fsp.rm(destination, { force: true });
    throw new Error(`Размер ${label} не совпал с манифестом.`);
  }
  const actualHash = await hashFile(destination);
  if (actualHash !== entry.sha256) {
    await fsp.rm(destination, { force: true });
    throw new Error(`Проверка SHA-256 не пройдена для ${label}.`);
  }
}

async function renameWithRetry(from, to) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function installStagedFile({ gameDirectory, entry, stagedFile, trashDirectory, destinationResolver = safeDestination }) {
  const destination = destinationResolver(gameDirectory, entry.path);
  const backup = path.join(trashDirectory, ...entry.path.split('/'));
  await fsp.mkdir(path.dirname(destination), { recursive: true });

  let backedUp = false;
  if (await exists(destination)) {
    await fsp.mkdir(path.dirname(backup), { recursive: true });
    await renameWithRetry(destination, backup);
    backedUp = true;
  }

  try {
    await renameWithRetry(stagedFile, destination);
  } catch (error) {
    if (backedUp && !(await exists(destination))) {
      await renameWithRetry(backup, destination).catch(() => {});
    }
    throw error;
  }
}

function stateFilesMap(state, normalizer = normalizeManagedPath) {
  const map = new Map();
  if (!state || !Array.isArray(state.files)) return map;
  for (const entry of state.files) {
    try {
      const managedPath = normalizer(entry.path);
      map.set(managedPath.toLowerCase(), {
        path: managedPath,
        sha256: String(entry.sha256 || '').toLowerCase(),
        size: Number(entry.size),
        packageId: String(entry.packageId || ''),
        policy: entry.policy === 'seed' ? 'seed' : 'managed'
      });
    } catch {
      // Повреждённые записи старого состояния игнорируются.
    }
  }
  return map;
}

async function inspectEntry({ entry, gameDirectory, oldFiles, force }) {
  const resolved = await resolveExistingManagedDestination(gameDirectory, entry.path, safeDestination);
  let stat;
  try {
    stat = await fsp.stat(resolved.destination);
  } catch {
    return { entry, current: false, disabled: resolved.disabled };
  }
  if (!stat.isFile() || stat.size !== entry.size) return { entry, current: false, disabled: resolved.disabled };

  const previous = oldFiles.get(entry.path.toLowerCase());
  if (!force && previous?.sha256 === entry.sha256 && previous?.size === entry.size) {
    return { entry, current: true, disabled: resolved.disabled };
  }
  return { entry, current: (await hashFile(resolved.destination)) === entry.sha256, disabled: resolved.disabled };
}

async function moveStaleFiles({ gameDirectory, oldFiles, nextFiles, trashDirectory, destinationResolver = safeDestination }) {
  const moved = [];
  for (const previous of oldFiles.values()) {
    if (nextFiles.has(previous.path.toLowerCase()) || previous.policy === 'seed') continue;
    const resolved = await resolveExistingManagedDestination(gameDirectory, previous.path, destinationResolver);
    if (!(await exists(resolved.destination))) continue;
    const storedPath = resolved.disabled ? disabledManagedPath(previous.path) : previous.path;
    const destination = path.join(trashDirectory, ...storedPath.split('/'));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await renameWithRetry(resolved.destination, destination);
    moved.push(previous.path);
  }
  return moved;
}

async function syncLegacyManifest({ manifest, state, stateFile, gameDirectory, stagingDirectory, trashDirectory, force, onProgress }) {
  const oldFiles = stateFilesMap(state);

  onProgress?.({
    phase: 'scan',
    message: force ? 'Проверяю хеши файлов…' : 'Проверяю состояние сборки…',
    current: 0,
    total: manifest.files.length
  });
  let scanned = 0;
  const inspected = await mapLimit(manifest.files, 4, async (entry) => {
    const result = await inspectEntry({ entry, gameDirectory, oldFiles, force });
    scanned += 1;
    onProgress?.({
      phase: 'scan',
      message: `Проверено ${scanned} из ${manifest.files.length}`,
      current: scanned,
      total: manifest.files.length
    });
    return result;
  });
  const required = inspected.filter((item) => !item.current);
  const totalBytes = required.reduce((sum, item) => sum + item.entry.size, 0);
  let downloadedBytes = 0;
  const changed = [];

  onProgress?.({
    phase: 'download',
    message: required.length ? `Нужно загрузить файлов: ${required.length}` : 'Все файлы актуальны.',
    current: 0,
    total: totalBytes
  });

  await mapLimit(required, 4, async (item) => {
    const entry = item.entry;
    const stagedFile = path.join(stagingDirectory, `${entry.sha256}.part`);
    await downloadFile(entry, stagedFile, (bytes) => {
      downloadedBytes += bytes;
      onProgress?.({
        phase: 'download',
        message: `Загружаю ${entry.path}`,
        current: downloadedBytes,
        total: totalBytes,
        file: entry.path
      });
    });
    const installEntry = item.disabled ? { ...entry, path: disabledManagedPath(entry.path) } : entry;
    await installStagedFile({ gameDirectory, entry: installEntry, stagedFile, trashDirectory });
    changed.push(entry.path);
  });

  const nextFiles = new Map(manifest.files.map((entry) => [entry.path.toLowerCase(), entry]));
  const moved = await moveStaleFiles({ gameDirectory, oldFiles, nextFiles, trashDirectory });
  await writeJsonAtomic(stateFile, {
    schemaVersion: 1,
    packId: manifest.pack.id,
    packVersion: manifest.pack.version,
    updatedAt: new Date().toISOString(),
    files: manifest.files.map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size }))
  });

  return { changed: changed.sort(), moved: moved.sort(), managedFileCount: manifest.files.length };
}

async function inspectPackageEntry({ entry, gameDirectory, oldFiles, force }) {
  const resolved = await resolveExistingManagedDestination(gameDirectory, entry.path, safePackDestination);
  let stat;
  try {
    stat = await fsp.stat(resolved.destination);
  } catch {
    return { entry, current: false, disabled: resolved.disabled };
  }
  if (!stat.isFile()) return { entry, current: false, disabled: resolved.disabled };
  if (entry.policy === 'seed') return { entry, current: true, disabled: resolved.disabled };
  if (stat.size !== entry.size) return { entry, current: false, disabled: resolved.disabled };

  const previous = oldFiles.get(entry.path.toLowerCase());
  if (!force && previous?.sha256 === entry.sha256 && previous?.size === entry.size) {
    return { entry, current: true, disabled: resolved.disabled };
  }
  return { entry, current: (await hashFile(resolved.destination)) === entry.sha256, disabled: resolved.disabled };
}

function isUnsafeZipLink(entry) {
  const platform = (entry.versionMadeBy >>> 8) & 0xff;
  if (platform !== 3) return false;
  const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
  return fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000;
}

function expectedDirectoryKeys(files) {
  const directories = new Set();
  for (const file of files) {
    const parts = file.path.toLowerCase().split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      directories.add(current);
    }
  }
  return directories;
}

async function extractZipPackage({ packageFile, extractionDirectory, expectedFiles, packageId, onProgress }) {
  const expected = new Map(expectedFiles.map((entry) => [entry.path.toLowerCase(), entry]));
  const allowedDirectories = expectedDirectoryKeys(expectedFiles);
  const seen = new Set();
  let entryCount = 0;
  let extracted = 0;
  await fsp.rm(extractionDirectory, { recursive: true, force: true });
  await fsp.mkdir(extractionDirectory, { recursive: true });

  const zipfile = await yauzl.openPromise(packageFile, {
    autoClose: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: false
  });
  try {
    for await (const entry of zipfile.eachEntry()) {
      entryCount += 1;
      if (entryCount > MAX_ZIP_ENTRIES) {
        throw new Error(`В пакете ${packageId} слишком много записей.`);
      }
      if (entry.isEncrypted()) throw new Error(`Пакет ${packageId} содержит зашифрованный файл.`);
      if (isUnsafeZipLink(entry)) throw new Error(`Пакет ${packageId} содержит ссылку вместо обычного файла.`);

      const directoryEntry = entry.fileName.endsWith('/');
      const rawPath = directoryEntry ? entry.fileName.slice(0, -1) : entry.fileName;
      if (!rawPath) continue;
      const managedPath = normalizePackPath(rawPath);
      const key = managedPath.toLowerCase();

      if (directoryEntry) {
        if (!allowedDirectories.has(key)) {
          throw new Error(`Пакет ${packageId} содержит лишнюю папку ${managedPath}.`);
        }
        await fsp.mkdir(safePackDestination(extractionDirectory, managedPath), { recursive: true });
        continue;
      }

      const expectedFile = expected.get(key);
      if (!expectedFile) throw new Error(`Пакет ${packageId} содержит лишний файл ${managedPath}.`);
      if (seen.has(key)) throw new Error(`Файл ${managedPath} повторяется в пакете ${packageId}.`);
      if (entry.uncompressedSize !== expectedFile.size) {
        throw new Error(`Размер ${managedPath} внутри пакета не совпал с манифестом.`);
      }
      seen.add(key);

      const destination = safePackDestination(extractionDirectory, managedPath);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      const digest = crypto.createHash('sha256');
      const readStream = await zipfile.openReadStreamPromise(entry);
      const hashingStream = new Transform({
        transform(chunk, _encoding, callback) {
          digest.update(chunk);
          callback(null, chunk);
        }
      });
      await pipeline(readStream, hashingStream, fs.createWriteStream(destination, { flags: 'wx' }));
      const actualHash = digest.digest('hex');
      if (actualHash !== expectedFile.sha256) {
        throw new Error(`Проверка SHA-256 не пройдена для ${managedPath} внутри пакета.`);
      }
      extracted += 1;
      onProgress?.({
        phase: 'extract',
        message: `Распаковываю файлы сборки: ${extracted} из ${expected.size}`,
        current: extracted,
        total: expected.size,
        file: managedPath
      });
    }
  } finally {
    zipfile.close();
  }

  if (seen.size !== expected.size) {
    const missing = [...expected.values()].find((entry) => !seen.has(entry.path.toLowerCase()));
    throw new Error(`В пакете ${packageId} отсутствует файл ${missing?.path || '(неизвестно)'}.`);
  }
}

async function preparePackages({ manifest, required, transactionDirectory, onProgress }) {
  const packagesById = new Map(manifest.packages.map((entry) => [entry.id, entry]));
  const allMembers = new Map(manifest.packages.map((entry) => [entry.id, []]));
  const requiredMembers = new Map();
  for (const entry of manifest.files) allMembers.get(entry.packageId).push(entry);
  for (const entry of required) {
    if (!requiredMembers.has(entry.packageId)) requiredMembers.set(entry.packageId, []);
    requiredMembers.get(entry.packageId).push(entry);
  }

  const requiredPackages = [...requiredMembers.keys()].map((id) => packagesById.get(id));
  const totalBytes = requiredPackages.reduce((sum, entry) => sum + entry.size, 0);
  let downloadedBytes = 0;
  const staged = new Map();
  onProgress?.({
    phase: 'download',
    message: requiredPackages.length ? `Нужно загрузить пакетов: ${requiredPackages.length}` : 'Все файлы актуальны.',
    current: 0,
    total: totalBytes
  });

  await mapLimit(requiredPackages, 2, async (pack) => {
    const packageFile = path.join(transactionDirectory, 'packages', `${pack.sha256}.part`);
    await downloadFile(pack, packageFile, (bytes) => {
      downloadedBytes += bytes;
      onProgress?.({
        phase: 'download',
        message: `Загружаю пакет ${pack.id}`,
        current: downloadedBytes,
        total: totalBytes,
        file: pack.id
      });
    });

    const needed = requiredMembers.get(pack.id);
    if (pack.format === 'raw') {
      const firstDestination = safePackDestination(path.join(transactionDirectory, 'files'), needed[0].path);
      await fsp.mkdir(path.dirname(firstDestination), { recursive: true });
      await renameWithRetry(packageFile, firstDestination);
      staged.set(needed[0].path.toLowerCase(), firstDestination);
      for (const entry of needed.slice(1)) {
        const destination = safePackDestination(path.join(transactionDirectory, 'files'), entry.path);
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.copyFile(firstDestination, destination);
        staged.set(entry.path.toLowerCase(), destination);
      }
      return;
    }

    const extractionDirectory = path.join(transactionDirectory, 'extracted', pack.id);
    await extractZipPackage({
      packageFile,
      extractionDirectory,
      expectedFiles: allMembers.get(pack.id),
      packageId: pack.id,
      onProgress
    });
    await fsp.rm(packageFile, { force: true });
    for (const entry of needed) {
      staged.set(entry.path.toLowerCase(), safePackDestination(extractionDirectory, entry.path));
    }
  });
  return staged;
}

async function syncPackageManifest({ manifest, state, stateFile, gameDirectory, stagingDirectory, trashDirectory, force, onProgress }) {
  const samePack = state?.packId === manifest.pack.id;
  const oldFiles = samePack ? stateFilesMap(state, normalizePackPath) : new Map();

  onProgress?.({
    phase: 'scan',
    message: force ? 'Проверяю хеши файлов…' : 'Проверяю состояние сборки…',
    current: 0,
    total: manifest.files.length
  });
  let scanned = 0;
  const inspected = await mapLimit(manifest.files, 4, async (entry) => {
    const result = await inspectPackageEntry({ entry, gameDirectory, oldFiles, force });
    scanned += 1;
    onProgress?.({
      phase: 'scan',
      message: `Проверено ${scanned} из ${manifest.files.length}`,
      current: scanned,
      total: manifest.files.length,
      file: entry.path
    });
    return result;
  });
  const required = inspected.filter((item) => !item.current);
  const requiredEntries = required.map((item) => item.entry);
  const transactionDirectory = await fsp.mkdtemp(path.join(stagingDirectory, 'sync-'));
  const changed = [];
  try {
    const staged = await preparePackages({ manifest, required: requiredEntries, transactionDirectory, onProgress });
    let installed = 0;
    for (const item of required.slice().sort((a, b) => a.entry.path.localeCompare(b.entry.path, 'en'))) {
      const entry = item.entry;
      const destination = safePackDestination(gameDirectory, item.disabled ? disabledManagedPath(entry.path) : entry.path);
      if (entry.policy === 'seed' && await exists(destination)) continue;
      const stagedFile = staged.get(entry.path.toLowerCase());
      if (!stagedFile) throw new Error(`Не подготовлен файл ${entry.path}.`);
      const installEntry = item.disabled ? { ...entry, path: disabledManagedPath(entry.path) } : entry;
      await installStagedFile({
        gameDirectory,
        entry: installEntry,
        stagedFile,
        trashDirectory,
        destinationResolver: safePackDestination
      });
      changed.push(entry.path);
      installed += 1;
      onProgress?.({
        phase: 'install',
        message: `Устанавливаю файлы: ${installed} из ${required.length}`,
        current: installed,
        total: required.length,
        file: entry.path
      });
    }
  } finally {
    await fsp.rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
  }

  const nextFiles = new Map(manifest.files.map((entry) => [entry.path.toLowerCase(), entry]));
  const moved = await moveStaleFiles({
    gameDirectory,
    oldFiles,
    nextFiles,
    trashDirectory,
    destinationResolver: safePackDestination
  });
  await writeJsonAtomic(stateFile, {
    schemaVersion: 2,
    packId: manifest.pack.id,
    packVersion: manifest.pack.version,
    updatedAt: new Date().toISOString(),
    files: manifest.files.map(({ path: filePath, sha256, size, packageId, policy }) => ({
      path: filePath,
      sha256,
      size,
      packageId,
      policy
    }))
  });

  return { changed: changed.sort(), moved: moved.sort(), managedFileCount: manifest.files.length };
}

async function syncPack({ manifestUrl, gameDirectory, force = false, onProgress }) {
  if (!manifestUrl) {
    return {
      skipped: true,
      changed: [],
      moved: [],
      warning: 'URL манифеста пока не настроен.'
    };
  }

  const metadataDirectory = path.join(gameDirectory, '.tech-adventure-launcher');
  const stateFile = path.join(metadataDirectory, 'state.json');
  const stagingDirectory = path.join(metadataDirectory, 'staging');
  const trashDirectory = path.join(
    metadataDirectory,
    'replaced',
    new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  );
  await fsp.mkdir(stagingDirectory, { recursive: true });

  const { manifest, fromCache, warning } = await loadManifest({
    manifestUrl,
    metadataDirectory,
    onProgress
  });
  const state = await readJsonOr(stateFile, null);
  const result = manifest.schemaVersion === 2
    ? await syncPackageManifest({ manifest, state, stateFile, gameDirectory, stagingDirectory, trashDirectory, force, onProgress })
    : await syncLegacyManifest({ manifest, state, stateFile, gameDirectory, stagingDirectory, trashDirectory, force, onProgress });

  onProgress?.({
    phase: 'done',
    message: `Сборка ${manifest.pack.version} готова.`,
    current: 1,
    total: 1
  });
  return {
    skipped: false,
    manifest,
    fromCache,
    warning,
    ...result
  };
}

module.exports = {
  USER_AGENT,
  exists,
  hashFile,
  mapLimit,
  fetchJson,
  loadManifest,
  downloadFile,
  stateFilesMap,
  inspectEntry,
  inspectPackageEntry,
  extractZipPackage,
  syncPack
};
