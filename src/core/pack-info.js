'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { validateGithubUrl } = require('./manifest');
const { writeJsonAtomic } = require('./settings');

const USER_AGENT = 'Dekodev-Reborn-Launcher/0.2.10';

function normalizePackSummary(rawPack, fallback = {}) {
  const raw = rawPack && typeof rawPack === 'object' ? rawPack : {};
  return {
    id: String(raw.id || fallback.id || 'pack').trim().slice(0, 80),
    name: String(raw.name || fallback.name || 'Minecraft Pack').trim().slice(0, 80),
    version: String(raw.version || '0.0.0').trim().slice(0, 80),
    minecraftVersion: String(raw.minecraftVersion || fallback.minecraftVersion || '1.21.1').trim().slice(0, 40),
    neoForgeVersion: String(raw.neoForgeVersion || fallback.neoForgeVersion || '').trim().slice(0, 40),
    serverAddress: String(raw.serverAddress || fallback.serverAddress || '').trim().slice(0, 255),
    news: String(raw.news || '').trim().slice(0, 1200)
  };
}

async function fetchPackSummary(manifestUrl, fallback = {}, timeoutMs = 20000) {
  const safeUrl = validateGithubUrl(manifestUrl, 'Манифест сборки');
  const response = await fetch(safeUrl, {
    redirect: 'follow',
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache',
      'user-agent': USER_AGENT
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`GitHub ответил ${response.status} ${response.statusText}.`);
  }
  const raw = await response.json();
  if (!raw || typeof raw !== 'object' || !raw.pack || typeof raw.pack !== 'object') {
    throw new Error('В GitHub-манифесте отсутствует раздел pack.');
  }
  return normalizePackSummary(raw.pack, fallback);
}

function packInfoCachePath(cacheDirectory, packId) {
  const safeId = String(packId || 'pack').replace(/[^a-z0-9._-]/gi, '_');
  return path.join(cacheDirectory, `${safeId}.json`);
}

async function readCachedPackSummary(cacheDirectory, packId) {
  try {
    const cached = JSON.parse(await fs.readFile(packInfoCachePath(cacheDirectory, packId), 'utf8'));
    if (!cached?.pack || typeof cached.pack !== 'object') return null;
    return {
      pack: normalizePackSummary(cached.pack),
      fetchedAt: String(cached.fetchedAt || ''),
      fromCache: true,
      stale: true
    };
  } catch {
    return null;
  }
}

async function writeCachedPackSummary(cacheDirectory, pack) {
  const payload = {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    pack: normalizePackSummary(pack)
  };
  await writeJsonAtomic(packInfoCachePath(cacheDirectory, pack.id), payload);
  return payload;
}

async function loadLatestPackSummary({ manifestUrl, cacheDirectory, fallback }) {
  try {
    const pack = await fetchPackSummary(manifestUrl, fallback);
    const cached = await writeCachedPackSummary(cacheDirectory, pack);
    return {
      pack,
      fetchedAt: cached.fetchedAt,
      fromCache: false,
      stale: false,
      warning: ''
    };
  } catch (error) {
    const cached = await readCachedPackSummary(cacheDirectory, fallback?.id);
    if (cached) {
      return {
        ...cached,
        warning: `Не удалось обновить сведения о сборке: ${error.message}`
      };
    }
    throw error;
  }
}

module.exports = {
  USER_AGENT,
  normalizePackSummary,
  fetchPackSummary,
  packInfoCachePath,
  readCachedPackSummary,
  writeCachedPackSummary,
  loadLatestPackSummary
};
