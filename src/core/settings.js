'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asMemory(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1024 && number <= 65536 ? number : fallback;
}

function normalizeOptionalHttpsUrl(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label}: указан некорректный URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${label}: разрешён только HTTPS.`);
  }
  const hostname = url.hostname.toLowerCase();
  const githubHost = hostname === 'github.com'
    || hostname === 'raw.githubusercontent.com'
    || hostname.endsWith('.githubusercontent.com');
  if (!githubHost) {
    throw new Error(`${label}: укажи прямую ссылку на файл в GitHub.`);
  }
  return url.toString();
}

function normalizeUpdateRepository(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    throw new Error('Репозиторий обновлений указывается в формате владелец/репозиторий.');
  }
  return text;
}

function migrateSavedSettings(saved, defaults) {
  const migrated = saved && typeof saved === 'object' ? { ...saved } : {};

  if (!String(migrated.manifestUrl || '').trim()) delete migrated.manifestUrl;
  if (!String(migrated.updateRepository || '').trim()) delete migrated.updateRepository;

  const legacyNeoForgeVersions = new Set(['21.1.247']);
  if (
    legacyNeoForgeVersions.has(String(migrated.neoForgeVersion || '').trim())
    && defaults.neoForgeVersion
  ) {
    migrated.neoForgeVersion = defaults.neoForgeVersion;
  }

  return migrated;
}

function normalizeSettings(input, defaults, defaultGameDirectory) {
  const source = { ...defaults, ...(input || {}) };
  const minMemoryMb = asMemory(source.minMemoryMb, 4096);
  const maxMemoryMb = asMemory(source.maxMemoryMb, 8192);
  if (maxMemoryMb < minMemoryMb) {
    throw new Error('Максимальный объём памяти не может быть меньше минимального.');
  }

  const gameDirectoryInput = String(source.gameDirectory ?? '').trim();
  const gameDirectory = path.resolve(gameDirectoryInput || defaultGameDirectory);
  const manifestUrl = String(source.manifestUrl || '').trim()
    || String(defaults.manifestUrl || '').trim();
  const updateRepository = String(source.updateRepository || '').trim()
    || String(defaults.updateRepository || '').trim();

  return {
    packName: String(source.packName || 'Tech Adventure').trim().slice(0, 80),
    minecraftVersion: String(source.minecraftVersion || '1.21.1').trim(),
    neoForgeVersion: String(source.neoForgeVersion || '21.1.235').trim(),
    manifestUrl: normalizeOptionalHttpsUrl(manifestUrl, 'Манифест сборки'),
    serverAddress: String(source.serverAddress || '').trim().slice(0, 255),
    minMemoryMb,
    maxMemoryMb,
    gameDirectory,
    customJavaPath: String(source.customJavaPath || '').trim(),
    closeLauncherOnGameStart: asBoolean(source.closeLauncherOnGameStart, false),
    autoUpdateLauncher: asBoolean(source.autoUpdateLauncher, true),
    updateRepository: normalizeUpdateRepository(updateRepository),
    authMode: source.authMode === 'microsoft' ? 'microsoft' : 'offline',
    offlineUsername: String(source.offlineUsername || '').trim().slice(0, 16),
    lastMicrosoftProfile: source.lastMicrosoftProfile && typeof source.lastMicrosoftProfile === 'object'
      ? {
          name: String(source.lastMicrosoftProfile.name || '').slice(0, 16),
          id: String(source.lastMicrosoftProfile.id || '').replaceAll('-', '').slice(0, 32)
        }
      : null
  };
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}

class SettingsStore {
  constructor({ settingsPath, defaultsPath, defaultGameDirectory }) {
    this.settingsPath = settingsPath;
    this.defaultsPath = defaultsPath;
    this.defaultGameDirectory = defaultGameDirectory;
    this.defaults = null;
    this.value = null;
  }

  async load() {
    if (!this.defaults) {
      this.defaults = JSON.parse(await fs.readFile(this.defaultsPath, 'utf8'));
    }
    let saved = {};
    try {
      saved = JSON.parse(await fs.readFile(this.settingsPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const migrated = migrateSavedSettings(saved, this.defaults);
    this.value = normalizeSettings(migrated, this.defaults, this.defaultGameDirectory);
    await writeJsonAtomic(this.settingsPath, this.value);
    return this.get();
  }

  get() {
    if (!this.value) throw new Error('Настройки ещё не загружены.');
    return structuredClone(this.value);
  }

  async update(patch) {
    const next = normalizeSettings({ ...this.value, ...patch }, this.defaults, this.defaultGameDirectory);
    await writeJsonAtomic(this.settingsPath, next);
    this.value = next;
    return this.get();
  }
}

module.exports = {
  SettingsStore,
  normalizeSettings,
  normalizeOptionalHttpsUrl,
  normalizeUpdateRepository,
  migrateSavedSettings,
  writeJsonAtomic
};
