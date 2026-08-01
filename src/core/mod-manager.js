'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const yauzl = require('yauzl');
const { writeJsonAtomic } = require('./settings');

const DISABLED_SUFFIX = '.disabled';
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ICON_BYTES = 768 * 1024;
const MAX_JAR_ENTRIES = 20000;

function isActiveModName(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith('.jar');
}

function isDisabledModName(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith(`.jar${DISABLED_SUFFIX}`);
}

function activeNameFor(name) {
  return isDisabledModName(name) ? name.slice(0, -DISABLED_SUFFIX.length) : name;
}

function disabledNameFor(name) {
  const active = activeNameFor(name);
  return `${active}${DISABLED_SUFFIX}`;
}

function isManagedModPath(relativePath) {
  return /^mods\/[^/]+\.jar$/i.test(String(relativePath || '').replaceAll('\\', '/'));
}

function disabledManagedPath(relativePath) {
  if (!isManagedModPath(relativePath)) return String(relativePath || '');
  return `${String(relativePath).replaceAll('\\', '/')}${DISABLED_SUFFIX}`;
}

function normalizeModFileName(value) {
  const name = String(value || '').trim();
  if (!name || path.basename(name) !== name || name.includes('/') || name.includes('\\')) {
    throw new Error('Указано некорректное имя файла мода.');
  }
  if (!isActiveModName(name) && !isDisabledModName(name)) {
    throw new Error('Переключать можно только файлы .jar и .jar.disabled.');
  }
  return name;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function fallbackName(fileName) {
  const base = activeNameFor(fileName).replace(/\.jar$/i, '');
  const withoutVersion = base.replace(/[-_](?:v?\d+(?:[._-]\d+)*(?:[-+._][a-z0-9]+)*)$/i, '');
  return (withoutVersion || base)
    .replaceAll('_', ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)([a-zа-яё])/giu, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

function cleanTomlValue(value) {
  const text = String(value || '').trim();
  const quoted = text.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
  return (quoted ? quoted[1] ?? quoted[2] : text).replace(/\\n/g, '\n').trim();
}

function tomlValue(text, key) {
  const match = String(text || '').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'mi'));
  return match ? cleanTomlValue(match[1]) : '';
}

function tomlMultilineValue(text, key) {
  const source = String(text || '');
  const triple = source.match(new RegExp(`${key}\\s*=\\s*(?:"""([\\s\\S]*?)"""|'''([\\s\\S]*?)''')`, 'i'));
  return triple ? String(triple[1] ?? triple[2] ?? '').trim() : tomlValue(source, key);
}

function manifestValue(text, key) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const unfolded = [];
  for (const line of lines) {
    if (line.startsWith(' ') && unfolded.length) unfolded[unfolded.length - 1] += line.slice(1);
    else unfolded.push(line);
  }
  const prefix = `${key.toLowerCase()}:`;
  const line = unfolded.find((item) => item.toLowerCase().startsWith(prefix));
  return line ? line.slice(line.indexOf(':') + 1).trim() : '';
}

function parseNeoForgeMetadata(text, manifestText, loader = 'NeoForge') {
  const source = String(text || '');
  const sectionMatch = source.match(/\[\[mods\]\]([\s\S]*?)(?=\n\s*\[\[|$)/i);
  const section = sectionMatch?.[1] || source;
  let version = tomlValue(section, 'version');
  if (/^\$\{file\.jarVersion\}$/i.test(version)) {
    version = manifestValue(manifestText, 'Implementation-Version')
      || manifestValue(manifestText, 'Specification-Version');
  }
  return {
    loader,
    modId: tomlValue(section, 'modId'),
    name: tomlValue(section, 'displayName'),
    version,
    description: tomlMultilineValue(section, 'description'),
    logoFile: tomlValue(section, 'logoFile') || tomlValue(source, 'logoFile')
  };
}

function parseFabricMetadata(text) {
  const data = JSON.parse(text);
  return {
    loader: 'Fabric',
    modId: String(data.id || ''),
    name: typeof data.name === 'string' ? data.name : '',
    version: String(data.version || ''),
    description: typeof data.description === 'string' ? data.description : '',
    logoFile: typeof data.icon === 'string'
      ? data.icon
      : data.icon && typeof data.icon === 'object'
        ? String(data.icon['128'] || data.icon['64'] || Object.values(data.icon)[0] || '')
        : ''
  };
}

function parseQuiltMetadata(text) {
  const data = JSON.parse(text);
  const quilt = data.quilt_loader || {};
  const metadata = quilt.metadata || {};
  return {
    loader: 'Quilt',
    modId: String(quilt.id || ''),
    name: typeof metadata.name === 'string' ? metadata.name : '',
    version: String(quilt.version || ''),
    description: typeof metadata.description === 'string' ? metadata.description : '',
    logoFile: typeof metadata.icon === 'string' ? metadata.icon : ''
  };
}

async function readEntryBuffer(zipfile, entry, limit) {
  if (entry.uncompressedSize > limit) return null;
  const stream = await zipfile.openReadStreamPromise(entry);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      stream.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function inspectModJar(file, fileName, { includeIcon = true } = {}) {
  const fallback = {
    modId: '',
    name: fallbackName(fileName),
    version: '',
    description: '',
    loader: 'Неизвестно',
    iconDataUrl: ''
  };

  let zipfile;
  try {
    zipfile = await yauzl.openPromise(file, {
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false
    });
    const metadata = new Map();
    const icons = new Map();
    let entries = 0;
    for await (const entry of zipfile.eachEntry()) {
      entries += 1;
      if (entries > MAX_JAR_ENTRIES) break;
      if (entry.fileName.endsWith('/')) continue;
      const normalized = entry.fileName.replaceAll('\\', '/');
      const lower = normalized.toLowerCase();
      const metadataFile = [
        'meta-inf/neoforge.mods.toml',
        'meta-inf/mods.toml',
        'fabric.mod.json',
        'quilt.mod.json',
        'meta-inf/manifest.mf'
      ].includes(lower);
      if (metadataFile) {
        const buffer = await readEntryBuffer(zipfile, entry, MAX_METADATA_BYTES);
        if (buffer) metadata.set(lower, buffer.toString('utf8'));
        continue;
      }
      if (
        includeIcon
        && lower.endsWith('.png')
        && (/(^|\/)(logo|icon)[^/]*\.png$/i.test(normalized) || lower.split('/').length <= 2)
        && icons.size < 12
      ) {
        const buffer = await readEntryBuffer(zipfile, entry, MAX_ICON_BYTES);
        if (buffer) icons.set(lower, buffer);
      }
    }

    const manifestText = metadata.get('meta-inf/manifest.mf') || '';
    let parsed = null;
    if (metadata.has('meta-inf/neoforge.mods.toml')) {
      parsed = parseNeoForgeMetadata(metadata.get('meta-inf/neoforge.mods.toml'), manifestText, 'NeoForge');
    } else if (metadata.has('meta-inf/mods.toml')) {
      parsed = parseNeoForgeMetadata(metadata.get('meta-inf/mods.toml'), manifestText, 'Forge');
    } else if (metadata.has('fabric.mod.json')) {
      parsed = parseFabricMetadata(metadata.get('fabric.mod.json'));
    } else if (metadata.has('quilt.mod.json')) {
      parsed = parseQuiltMetadata(metadata.get('quilt.mod.json'));
    }

    const result = { ...fallback, ...(parsed || {}) };
    result.name = String(result.name || fallback.name).trim().slice(0, 160);
    result.modId = String(result.modId || '').trim().slice(0, 160);
    result.version = String(result.version || manifestValue(manifestText, 'Implementation-Version') || '').trim().slice(0, 120);
    result.description = String(result.description || '').replace(/\s+/g, ' ').trim().slice(0, 420);

    if (includeIcon && icons.size) {
      const requested = String(result.logoFile || '').replaceAll('\\', '/').toLowerCase();
      const icon = icons.get(requested)
        || [...icons.entries()].find(([name]) => /(^|\/)(logo|icon)[^/]*\.png$/i.test(name))?.[1]
        || icons.values().next().value;
      if (icon) result.iconDataUrl = `data:image/png;base64,${icon.toString('base64')}`;
    }
    delete result.logoFile;
    return result;
  } catch {
    return fallback;
  } finally {
    zipfile?.close?.();
  }
}

async function readManagedPaths(gameDirectory) {
  try {
    const state = JSON.parse(await fs.readFile(path.join(gameDirectory, '.tech-adventure-launcher', 'state.json'), 'utf8'));
    return new Set((Array.isArray(state.files) ? state.files : [])
      .map((entry) => String(entry?.path || '').replaceAll('\\', '/').toLowerCase())
      .filter(isManagedModPath));
  } catch {
    return new Set();
  }
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}


async function countMods(gameDirectory) {
  try {
    const entries = await fs.readdir(path.join(gameDirectory, 'mods'), { withFileTypes: true });
    let enabledCount = 0;
    let disabledCount = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (isActiveModName(entry.name)) enabledCount += 1;
      else if (isDisabledModName(entry.name)) disabledCount += 1;
    }
    return { enabledCount, disabledCount, totalCount: enabledCount + disabledCount };
  } catch (error) {
    if (error.code === 'ENOENT') return { enabledCount: 0, disabledCount: 0, totalCount: 0 };
    throw error;
  }
}

function metadataCacheFile(gameDirectory) {
  return path.join(gameDirectory, '.tech-adventure-launcher', 'mod-metadata-cache.json');
}

async function readMetadataCache(gameDirectory) {
  try {
    const data = JSON.parse(await fs.readFile(metadataCacheFile(gameDirectory), 'utf8'));
    return data && typeof data.entries === 'object' ? data.entries : {};
  } catch {
    return {};
  }
}

async function writeMetadataCache(gameDirectory, entries) {
  await writeJsonAtomic(metadataCacheFile(gameDirectory), { schemaVersion: 1, entries });
}

async function listMods(gameDirectory, { includeIcons = true } = {}) {
  const modsDirectory = path.join(gameDirectory, 'mods');
  let entries = [];
  try {
    entries = await fs.readdir(modsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && (isActiveModName(entry.name) || isDisabledModName(entry.name)))
    .map((entry) => entry.name);
  const managedPaths = await readManagedPaths(gameDirectory);
  const metadataCache = await readMetadataCache(gameDirectory);
  const nextCache = {};
  let cacheChanged = false;
  const mods = await mapLimit(files, 5, async (fileName) => {
    const activeName = activeNameFor(fileName);
    const fullPath = path.join(modsDirectory, fileName);
    const stat = await fs.stat(fullPath);
    const cacheKey = activeName.toLowerCase();
    const cached = metadataCache[cacheKey];
    const canUseCache = cached
      && cached.size === stat.size
      && Math.abs(Number(cached.mtimeMs) - stat.mtimeMs) < 2
      && (!includeIcons || cached.iconScanned === true);
    const metadata = canUseCache
      ? cached.metadata
      : await inspectModJar(fullPath, activeName, { includeIcon: includeIcons });
    nextCache[cacheKey] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      iconScanned: includeIcons || cached?.iconScanned === true,
      metadata
    };
    if (!canUseCache) cacheChanged = true;
    return {
      fileName,
      activeFileName: activeName,
      relativePath: `mods/${activeName}`,
      enabled: isActiveModName(fileName),
      managed: managedPaths.has(`mods/${activeName}`.toLowerCase()),
      size: stat.size,
      ...metadata
    };
  });
  if (cacheChanged || Object.keys(metadataCache).length !== Object.keys(nextCache).length) {
    await writeMetadataCache(gameDirectory, nextCache).catch(() => {});
  }
  mods.sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }) || a.fileName.localeCompare(b.fileName, 'en'));
  const enabledCount = mods.filter((mod) => mod.enabled).length;
  return {
    mods,
    enabledCount,
    disabledCount: mods.length - enabledCount,
    totalCount: mods.length
  };
}

function registryFile(gameDirectory) {
  return path.join(gameDirectory, '.tech-adventure-launcher', 'disabled-mods.json');
}

async function readDisabledRegistry(gameDirectory) {
  try {
    const data = JSON.parse(await fs.readFile(registryFile(gameDirectory), 'utf8'));
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return {
      schemaVersion: 1,
      entries: entries
        .map((entry) => ({
          path: String(entry?.path || '').replaceAll('\\', '/'),
          modId: String(entry?.modId || ''),
          disabledAt: String(entry?.disabledAt || '')
        }))
        .filter((entry) => isManagedModPath(entry.path))
    };
  } catch {
    return { schemaVersion: 1, entries: [] };
  }
}

async function writeDisabledRegistry(gameDirectory, registry) {
  await writeJsonAtomic(registryFile(gameDirectory), {
    schemaVersion: 1,
    entries: registry.entries
  });
}

function samePreference(entry, pathValue, modId) {
  return entry.path.toLowerCase() === pathValue.toLowerCase()
    || (modId && entry.modId && entry.modId.toLowerCase() === modId.toLowerCase());
}

async function toggleMod(gameDirectory, requestedFileName, enabled) {
  const fileName = normalizeModFileName(requestedFileName);
  const modsDirectory = path.join(gameDirectory, 'mods');
  const activeName = activeNameFor(fileName);
  const activeFile = path.join(modsDirectory, activeName);
  const disabledFile = path.join(modsDirectory, disabledNameFor(activeName));
  const activeExists = await exists(activeFile);
  const disabledExists = await exists(disabledFile);
  if (!activeExists && !disabledExists) throw new Error('Файл мода больше не существует. Обнови список модов.');
  if (activeExists && disabledExists) throw new Error('Обнаружены одновременно включённая и выключенная копии мода. Удали дубликат вручную.');

  const currentFile = activeExists ? activeFile : disabledFile;
  const metadata = await inspectModJar(currentFile, activeName, { includeIcon: false });
  const relativePath = `mods/${activeName}`;
  const registry = await readDisabledRegistry(gameDirectory);

  if (enabled) {
    if (disabledExists) await fs.rename(disabledFile, activeFile);
    registry.entries = registry.entries.filter((entry) => !samePreference(entry, relativePath, metadata.modId));
  } else {
    if (activeExists) await fs.rename(activeFile, disabledFile);
    registry.entries = registry.entries.filter((entry) => !samePreference(entry, relativePath, metadata.modId));
    registry.entries.push({
      path: relativePath,
      modId: metadata.modId || '',
      disabledAt: new Date().toISOString()
    });
  }
  await writeDisabledRegistry(gameDirectory, registry);
  return {
    fileName: enabled ? activeName : disabledNameFor(activeName),
    activeFileName: activeName,
    enabled: Boolean(enabled),
    modId: metadata.modId || '',
    name: metadata.name || fallbackName(activeName)
  };
}

async function reapplyDisabledMods(gameDirectory) {
  const registry = await readDisabledRegistry(gameDirectory);
  if (!registry.entries.length) return { reapplied: [], registry };
  const snapshot = await listMods(gameDirectory, { includeIcons: false });
  const reapplied = [];
  const nextEntries = [];

  for (const preference of registry.entries) {
    const targetPath = preference.path.toLowerCase();
    let mod = snapshot.mods.find((item) => item.relativePath.toLowerCase() === targetPath);
    if (!mod && preference.modId) {
      mod = snapshot.mods.find((item) => item.modId && item.modId.toLowerCase() === preference.modId.toLowerCase());
    }
    if (!mod) {
      nextEntries.push(preference);
      continue;
    }
    if (mod.enabled) {
      const activeFile = path.join(gameDirectory, 'mods', mod.activeFileName);
      const disabledFile = path.join(gameDirectory, 'mods', disabledNameFor(mod.activeFileName));
      if (await exists(disabledFile)) await fs.rm(disabledFile, { force: true });
      await fs.rename(activeFile, disabledFile);
      reapplied.push(mod.relativePath);
    }
    nextEntries.push({
      path: mod.relativePath,
      modId: mod.modId || preference.modId || '',
      disabledAt: preference.disabledAt || new Date().toISOString()
    });
  }

  registry.entries = nextEntries;
  await writeDisabledRegistry(gameDirectory, registry);
  return { reapplied, registry };
}

module.exports = {
  DISABLED_SUFFIX,
  isActiveModName,
  isDisabledModName,
  activeNameFor,
  disabledNameFor,
  isManagedModPath,
  disabledManagedPath,
  normalizeModFileName,
  fallbackName,
  inspectModJar,
  countMods,
  listMods,
  readDisabledRegistry,
  toggleMod,
  reapplyDisabledMods
};
