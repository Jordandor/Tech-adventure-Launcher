'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const yauzl = require('yauzl');
const { writeJsonAtomic } = require('./settings');

const DISABLED_SUFFIX = '.disabled';
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ICON_BYTES = 768 * 1024;
const MAX_JAR_ENTRIES = 20000;
const METADATA_CACHE_SCHEMA_VERSION = 2;
const PLATFORM_DEPENDENCY_IDS = new Set([
  'minecraft',
  'neoforge',
  'forge',
  'java',
  'javafml',
  'lowcodefml',
  'modlauncher',
  'fabricloader',
  'quilt_loader'
]);

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

function normalizedModId(value) {
  return String(value || '').trim().toLowerCase();
}

function uniqueModIds(values) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = normalizedModId(value);
    if (!id || PLATFORM_DEPENDENCY_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function dependencyIdsFromObject(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (item && typeof item === 'object') return [item.id, item.mod_id, item.modId].filter(Boolean);
      return [];
    });
  }
  if (typeof value === 'object') return Object.keys(value);
  return [];
}

function parseNeoForgeDependencies(source, ownerIds) {
  const owners = new Set((ownerIds || []).map(normalizedModId).filter(Boolean));
  const dependencies = [];
  const blockPattern = /\[\[dependencies\.([^\]]+)\]\]([\s\S]*?)(?=\n\s*\[\[|$)/gi;
  for (const match of String(source || '').matchAll(blockPattern)) {
    const owner = cleanTomlValue(match[1]).toLowerCase();
    if (owners.size && !owners.has(owner)) continue;
    const block = match[2];
    const modId = normalizedModId(tomlValue(block, 'modId'));
    if (!modId || PLATFORM_DEPENDENCY_IDS.has(modId)) continue;

    const mandatoryText = tomlValue(block, 'mandatory').toLowerCase();
    const type = tomlValue(block, 'type').toLowerCase();
    const side = tomlValue(block, 'side').toLowerCase();
    const required = mandatoryText
      ? mandatoryText === 'true'
      : !type || ['required', 'required_client', 'required-server', 'required_server'].includes(type);
    const clientRelevant = !side || ['both', 'client'].includes(side);
    if (required && clientRelevant) dependencies.push(modId);
  }
  return uniqueModIds(dependencies);
}

function parseNeoForgeMetadata(text, manifestText, loader = 'NeoForge') {
  const source = String(text || '');
  const sections = [...source.matchAll(/\[\[mods\]\]([\s\S]*?)(?=\n\s*\[\[|$)/gi)]
    .map((match) => match[1]);
  const section = sections[0] || source;
  const providedModIds = uniqueModIds(sections.map((item) => tomlValue(item, 'modId')));
  const modId = normalizedModId(tomlValue(section, 'modId'));
  if (modId && !providedModIds.includes(modId)) providedModIds.unshift(modId);
  let version = tomlValue(section, 'version');
  if (/^\$\{file\.jarVersion\}$/i.test(version)) {
    version = manifestValue(manifestText, 'Implementation-Version')
      || manifestValue(manifestText, 'Specification-Version');
  }
  return {
    loader,
    modId,
    providedModIds,
    dependencies: parseNeoForgeDependencies(source, providedModIds),
    name: tomlValue(section, 'displayName'),
    version,
    description: tomlMultilineValue(section, 'description'),
    logoFile: tomlValue(section, 'logoFile') || tomlValue(source, 'logoFile')
  };
}

function parseFabricMetadata(text) {
  const data = JSON.parse(text);
  const modId = normalizedModId(data.id);
  return {
    loader: 'Fabric',
    modId,
    providedModIds: uniqueModIds([modId, ...(Array.isArray(data.provides) ? data.provides : [])]),
    dependencies: uniqueModIds(dependencyIdsFromObject(data.depends)),
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
  const modId = normalizedModId(quilt.id);
  return {
    loader: 'Quilt',
    modId,
    providedModIds: uniqueModIds([modId, ...dependencyIdsFromObject(quilt.provides)]),
    dependencies: uniqueModIds(dependencyIdsFromObject(quilt.depends)),
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
    iconDataUrl: '',
    providedModIds: [],
    dependencies: []
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
    result.modId = normalizedModId(result.modId).slice(0, 160);
    result.providedModIds = uniqueModIds([result.modId, ...(Array.isArray(result.providedModIds) ? result.providedModIds : [])]).slice(0, 32);
    result.dependencies = uniqueModIds(Array.isArray(result.dependencies) ? result.dependencies : []).slice(0, 128);
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
    if (data?.schemaVersion !== METADATA_CACHE_SCHEMA_VERSION || typeof data.entries !== 'object') return {};
    return data.entries;
  } catch {
    return {};
  }
}

async function writeMetadataCache(gameDirectory, entries) {
  await writeJsonAtomic(metadataCacheFile(gameDirectory), { schemaVersion: METADATA_CACHE_SCHEMA_VERSION, entries });
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

function providedIdsFor(mod) {
  return uniqueModIds([mod?.modId, ...(Array.isArray(mod?.providedModIds) ? mod.providedModIds : [])]);
}

function dependencyIdsFor(mod) {
  return uniqueModIds(Array.isArray(mod?.dependencies) ? mod.dependencies : []);
}

function publicModReference(mod) {
  return {
    fileName: mod.fileName,
    activeFileName: mod.activeFileName,
    name: mod.name || fallbackName(mod.activeFileName),
    modId: mod.modId || '',
    providedModIds: providedIdsFor(mod),
    dependencies: dependencyIdsFor(mod),
    enabled: Boolean(mod.enabled)
  };
}

function findMod(snapshot, requestedFileName) {
  const activeName = activeNameFor(normalizeModFileName(requestedFileName)).toLowerCase();
  return snapshot.mods.find((mod) => mod.activeFileName.toLowerCase() === activeName) || null;
}

function findDependentMods(snapshot, target, { enabledOnly = true } = {}) {
  const candidates = snapshot.mods.filter((mod) => mod !== target && (!enabledOnly || mod.enabled));
  const discovered = new Map();
  const direct = [];
  let frontier = new Set(providedIdsFor(target));
  const visitedIds = new Set(frontier);
  let depth = 0;

  while (frontier.size) {
    const next = new Set();
    for (const mod of candidates) {
      const key = mod.activeFileName.toLowerCase();
      if (discovered.has(key)) continue;
      const matching = dependencyIdsFor(mod).filter((id) => frontier.has(id));
      if (!matching.length) continue;
      const reference = { ...publicModReference(mod), dependencyDepth: depth + 1, dependsOn: matching };
      discovered.set(key, reference);
      if (depth === 0) direct.push(reference);
      for (const id of providedIdsFor(mod)) {
        if (!visitedIds.has(id)) {
          visitedIds.add(id);
          next.add(id);
        }
      }
    }
    frontier = next;
    depth += 1;
  }

  return {
    directDependents: direct,
    dependents: [...discovered.values()].sort((a, b) => a.dependencyDepth - b.dependencyDepth || a.name.localeCompare(b.name, 'ru'))
  };
}

async function analyzeModToggle(gameDirectory, requestedFileName, enabled) {
  const snapshot = await listMods(gameDirectory, { includeIcons: false });
  const target = findMod(snapshot, requestedFileName);
  if (!target) throw new Error('Файл мода больше не существует. Обнови список модов.');
  if (enabled || !target.enabled) {
    return {
      target: publicModReference(target),
      directDependents: [],
      dependents: [],
      requiresConfirmation: false
    };
  }
  const graph = findDependentMods(snapshot, target, { enabledOnly: true });
  return {
    target: publicModReference(target),
    ...graph,
    requiresConfirmation: graph.dependents.length > 0
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

async function toggleMods(gameDirectory, requestedFileNames, enabled) {
  const requested = [...new Set((Array.isArray(requestedFileNames) ? requestedFileNames : [requestedFileNames])
    .map((value) => activeNameFor(normalizeModFileName(value)).toLowerCase()))];
  if (!requested.length) return { results: [], summary: await countMods(gameDirectory) };

  const snapshot = await listMods(gameDirectory, { includeIcons: false });
  const byName = new Map(snapshot.mods.map((mod) => [mod.activeFileName.toLowerCase(), mod]));
  const selected = requested.map((name) => {
    const mod = byName.get(name);
    if (!mod) throw new Error(`Файл мода ${name} больше не существует. Обнови список модов.`);
    return mod;
  });
  const modsDirectory = path.join(gameDirectory, 'mods');
  const registry = await readDisabledRegistry(gameDirectory);
  const renamed = [];
  const results = [];

  try {
    for (const mod of selected) {
      const activeFile = path.join(modsDirectory, mod.activeFileName);
      const disabledFile = path.join(modsDirectory, disabledNameFor(mod.activeFileName));
      const activeExists = await exists(activeFile);
      const disabledExists = await exists(disabledFile);
      if (activeExists && disabledExists) {
        throw new Error(`Обнаружены одновременно включённая и выключенная копии ${mod.name}. Удали дубликат вручную.`);
      }
      if (!activeExists && !disabledExists) throw new Error(`Файл мода ${mod.name} больше не существует.`);
      if (Boolean(mod.enabled) !== Boolean(enabled)) {
        const source = enabled ? disabledFile : activeFile;
        const destination = enabled ? activeFile : disabledFile;
        await fs.rename(source, destination);
        renamed.push({ source: destination, destination: source });
      }

      const relativePath = `mods/${mod.activeFileName}`;
      registry.entries = registry.entries.filter((entry) => !samePreference(entry, relativePath, mod.modId));
      if (!enabled) {
        registry.entries.push({
          path: relativePath,
          modId: mod.modId || '',
          disabledAt: new Date().toISOString()
        });
      }
      results.push({
        fileName: enabled ? mod.activeFileName : disabledNameFor(mod.activeFileName),
        activeFileName: mod.activeFileName,
        enabled: Boolean(enabled),
        modId: mod.modId || '',
        name: mod.name || fallbackName(mod.activeFileName)
      });
    }
    await writeDisabledRegistry(gameDirectory, registry);
  } catch (error) {
    for (const operation of renamed.reverse()) {
      await fs.rename(operation.source, operation.destination).catch(() => {});
    }
    throw error;
  }

  return { results, summary: await countMods(gameDirectory) };
}

async function toggleMod(gameDirectory, requestedFileName, enabled) {
  const response = await toggleMods(gameDirectory, [requestedFileName], enabled);
  return response.results[0];
}

async function setAllMods(gameDirectory, enabled) {
  const snapshot = await listMods(gameDirectory, { includeIcons: false });
  const files = snapshot.mods.filter((mod) => mod.enabled !== Boolean(enabled)).map((mod) => mod.fileName);
  return toggleMods(gameDirectory, files, enabled);
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
  findDependentMods,
  analyzeModToggle,
  toggleMods,
  toggleMod,
  setAllMods,
  reapplyDisabledMods
};
