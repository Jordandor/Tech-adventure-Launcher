'use strict';

const fs = require('node:fs/promises');

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function normalizeGithubUrl(value, label) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label}: указан некорректный URL.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label}: разрешён только HTTPS.`);
  const hostname = url.hostname.toLowerCase();
  const githubHost = hostname === 'github.com'
    || hostname === 'raw.githubusercontent.com'
    || hostname.endsWith('.githubusercontent.com');
  if (!githubHost) throw new Error(`${label}: укажи ссылку на файл в GitHub.`);
  return url.toString();
}

function normalizeColor(value, fallback) {
  const text = String(value || '').trim();
  return HEX_COLOR_PATTERN.test(text) ? text.toLowerCase() : fallback;
}

function normalizeTheme(rawTheme = {}) {
  return {
    id: String(rawTheme.id || 'default').trim().slice(0, 64),
    accent: normalizeColor(rawTheme.accent, '#b8e86d'),
    accentBright: normalizeColor(rawTheme.accentBright, '#d7ff91'),
    secondary: normalizeColor(rawTheme.secondary, '#57b9a9'),
    heroStart: normalizeColor(rawTheme.heroStart, '#0c191c'),
    heroEnd: normalizeColor(rawTheme.heroEnd, '#122523')
  };
}

function normalizePack(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Некорректная запись packs[${index}].`);
  }
  const id = String(raw.id || '').trim();
  if (!PACK_ID_PATTERN.test(id)) throw new Error(`Некорректный ID сборки packs[${index}].`);
  const name = String(raw.name || '').trim();
  if (!name) throw new Error(`У сборки ${id} отсутствует название.`);

  return {
    id,
    name: name.slice(0, 80),
    shortName: String(raw.shortName || name).trim().slice(0, 40),
    eyebrow: String(raw.eyebrow || 'СОБСТВЕННАЯ СБОРКА').trim().slice(0, 100),
    description: String(raw.description || '').trim().slice(0, 500),
    manifestUrl: normalizeGithubUrl(raw.manifestUrl, `Манифест сборки ${name}`),
    runtimeManifestUrl: normalizeGithubUrl(raw.runtimeManifestUrl, `Runtime сборки ${name}`),
    minecraftVersion: String(raw.minecraftVersion || '1.21.1').trim().slice(0, 40),
    neoForgeVersion: String(raw.neoForgeVersion || '').trim().slice(0, 40),
    serverAddress: String(raw.serverAddress || '').trim().slice(0, 255),
    theme: normalizeTheme(raw.theme)
  };
}

function validatePackRegistry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Реестр сборок должен быть JSON-объектом.');
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`Неподдерживаемая версия реестра сборок: ${raw.schemaVersion ?? 'не указана'}.`);
  }
  if (!Array.isArray(raw.packs) || raw.packs.length === 0) {
    throw new Error('В реестре отсутствуют сборки.');
  }
  if (raw.packs.length > 50) throw new Error('В реестре слишком много сборок.');

  const packs = raw.packs.map(normalizePack);
  const ids = new Set();
  for (const pack of packs) {
    const key = pack.id.toLowerCase();
    if (ids.has(key)) throw new Error(`Сборка ${pack.id} повторяется в реестре.`);
    ids.add(key);
  }

  const requestedDefault = String(raw.defaultPackId || '').trim();
  const defaultPackId = packs.some((pack) => pack.id === requestedDefault)
    ? requestedDefault
    : packs[0].id;
  return { schemaVersion: 1, defaultPackId, packs };
}

async function loadPackRegistry(file) {
  return validatePackRegistry(JSON.parse(await fs.readFile(file, 'utf8')));
}

function getPack(registry, packId) {
  if (!registry) return null;
  return registry.packs.find((pack) => pack.id === packId)
    || registry.packs.find((pack) => pack.id === registry.defaultPackId)
    || registry.packs[0]
    || null;
}

function publicPack(pack) {
  if (!pack) return null;
  return structuredClone(pack);
}

module.exports = {
  PACK_ID_PATTERN,
  HEX_COLOR_PATTERN,
  normalizeGithubUrl,
  normalizeTheme,
  normalizePack,
  validatePackRegistry,
  loadPackRegistry,
  getPack,
  publicPack
};
