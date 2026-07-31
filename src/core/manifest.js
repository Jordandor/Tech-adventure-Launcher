'use strict';

const path = require('node:path');

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const PROTECTED_TOP_LEVEL = new Set([
  '.tech-adventure-launcher',
  'saves',
  'screenshots',
  'crash-reports',
  'logs',
  'versions',
  'libraries',
  'assets',
  'runtime',
  'natives'
]);
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function normalizePath(input, { allowOptions = false } = {}) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('В манифесте найден файл без пути.');
  }

  const slashPath = input.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    slashPath.includes('\0')
    || /[\u0000-\u001f]/.test(slashPath)
    || path.posix.isAbsolute(slashPath)
    || /^[A-Za-z]:/.test(slashPath)
    || slashPath.includes(':')
  ) {
    throw new Error(`Недопустимый путь в манифесте: ${input}`);
  }

  const rawSegments = slashPath.split('/');
  if (rawSegments.includes('..')) {
    throw new Error(`Путь выходит за пределы папки игры: ${input}`);
  }
  if (rawSegments.some((segment) => !segment || segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_RESERVED_NAME.test(segment))) {
    throw new Error(`Недопустимое имя файла в манифесте: ${input}`);
  }

  const normalized = path.posix.normalize(slashPath);
  if (normalized.length > 220 || normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    throw new Error(`Путь выходит за пределы папки игры: ${input}`);
  }

  const topLevel = normalized.split('/')[0].toLowerCase();
  if (PROTECTED_TOP_LEVEL.has(topLevel)) {
    throw new Error(`Лаунчер не управляет пользовательской папкой ${topLevel}.`);
  }

  const lower = normalized.toLowerCase();
  if (lower === 'servers.dat') {
    throw new Error('Лаунчер не должен перезаписывать пользовательский файл servers.dat.');
  }
  if (!allowOptions && lower === 'options.txt') {
    throw new Error('Лаунчер не должен перезаписывать пользовательский файл options.txt.');
  }

  return normalized;
}

function normalizeManagedPath(input) {
  return normalizePath(input, { allowOptions: false });
}

function normalizePackPath(input) {
  return normalizePath(input, { allowOptions: true });
}

function validateHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}: некорректный URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${label}: разрешён только HTTPS.`);
  }
  return url.toString();
}

function validateGithubUrl(value, label) {
  const normalized = validateHttpsUrl(value, label);
  const hostname = new URL(normalized).hostname.toLowerCase();
  const githubHost = hostname === 'github.com'
    || hostname === 'api.github.com'
    || hostname === 'raw.githubusercontent.com'
    || hostname.endsWith('.githubusercontent.com');
  if (!githubHost) {
    throw new Error(`${label}: файл должен загружаться с GitHub.`);
  }
  return normalized;
}

function normalizePackMetadata(rawPack) {
  return {
    id: String(rawPack.id || 'pack'),
    name: String(rawPack.name || 'Minecraft Pack'),
    version: String(rawPack.version || '0.0.0'),
    minecraftVersion: String(rawPack.minecraftVersion || '1.21.1'),
    neoForgeVersion: String(rawPack.neoForgeVersion || ''),
    serverAddress: String(rawPack.serverAddress || ''),
    news: String(rawPack.news || '')
  };
}

function normalizeSize(value, label) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${label}: указан некорректный размер.`);
  }
  return size;
}

function normalizeSha256(value, label) {
  const digest = String(value ?? '').toLowerCase();
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`${label}: не указан корректный SHA-256.`);
  }
  return digest;
}

function validateLegacyFiles(rawFiles) {
  if (!Array.isArray(rawFiles)) {
    throw new Error('В манифесте отсутствует массив files.');
  }
  if (rawFiles.length > 10000) {
    throw new Error('В манифесте слишком много файлов.');
  }

  const seen = new Set();
  return rawFiles.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Некорректная запись files[${index}].`);
    }
    const managedPath = normalizeManagedPath(entry.path);
    const key = managedPath.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Путь ${managedPath} повторяется в манифесте.`);
    }
    seen.add(key);

    return {
      path: managedPath,
      url: validateGithubUrl(entry.url, managedPath),
      sha256: normalizeSha256(entry.sha256, managedPath),
      size: normalizeSize(entry.size, managedPath)
    };
  });
}

function validatePackages(rawPackages) {
  if (!Array.isArray(rawPackages) || rawPackages.length === 0) {
    throw new Error('В манифесте отсутствует массив packages.');
  }
  if (rawPackages.length > 5000) {
    throw new Error('В манифесте слишком много пакетов загрузки.');
  }

  const seen = new Set();
  return rawPackages.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Некорректная запись packages[${index}].`);
    }
    const id = String(entry.id || '').trim();
    if (!PACKAGE_ID_PATTERN.test(id)) {
      throw new Error(`Некорректный идентификатор packages[${index}].`);
    }
    if (seen.has(id)) {
      throw new Error(`Пакет ${id} повторяется в манифесте.`);
    }
    seen.add(id);

    const format = entry.format === 'raw' ? 'raw' : entry.format === 'zip' ? 'zip' : '';
    if (!format) {
      throw new Error(`Для пакета ${id} указан неподдерживаемый формат.`);
    }
    return {
      id,
      format,
      url: validateGithubUrl(entry.url, `Пакет ${id}`),
      sha256: normalizeSha256(entry.sha256, `Пакет ${id}`),
      size: normalizeSize(entry.size, `Пакет ${id}`)
    };
  });
}

function validatePackageFiles(rawFiles, packages) {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error('В манифесте отсутствует массив files.');
  }
  if (rawFiles.length > 50000) {
    throw new Error('В манифесте слишком много файлов.');
  }

  const packagesById = new Map(packages.map((entry) => [entry.id, entry]));
  const membersByPackage = new Map(packages.map((entry) => [entry.id, []]));
  const seen = new Set();
  const files = rawFiles.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Некорректная запись files[${index}].`);
    }
    const managedPath = normalizePackPath(entry.path);
    const key = managedPath.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Путь ${managedPath} повторяется в манифесте.`);
    }
    seen.add(key);

    const packageId = String(entry.packageId || '').trim();
    if (!packagesById.has(packageId)) {
      throw new Error(`Для ${managedPath} указан неизвестный пакет ${packageId || '(пусто)'}.`);
    }
    const policy = entry.policy === 'seed' ? 'seed' : entry.policy === 'managed' || entry.policy == null ? 'managed' : '';
    if (!policy) {
      throw new Error(`Для ${managedPath} указана неподдерживаемая политика установки.`);
    }
    if (managedPath.toLowerCase() === 'options.txt' && policy !== 'seed') {
      throw new Error('options.txt разрешено устанавливать только один раз с политикой seed.');
    }

    const file = {
      path: managedPath,
      sha256: normalizeSha256(entry.sha256, managedPath),
      size: normalizeSize(entry.size, managedPath),
      packageId,
      policy
    };
    membersByPackage.get(packageId).push(file);
    return file;
  });

  for (const pack of packages) {
    const members = membersByPackage.get(pack.id);
    if (!members.length) {
      throw new Error(`Пакет ${pack.id} не используется ни одним файлом.`);
    }
    if (pack.format === 'raw') {
      for (const member of members) {
        if (member.sha256 !== pack.sha256 || member.size !== pack.size) {
          throw new Error(`RAW-пакет ${pack.id} не совпадает с файлом ${member.path}.`);
        }
      }
    }
  }
  return files;
}

function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Манифест должен быть JSON-объектом.');
  }
  if (![1, 2].includes(raw.schemaVersion)) {
    throw new Error(`Неподдерживаемая версия манифеста: ${raw.schemaVersion ?? 'не указана'}.`);
  }
  if (!raw.pack || typeof raw.pack !== 'object' || Array.isArray(raw.pack)) {
    throw new Error('В манифесте отсутствует раздел pack.');
  }

  const pack = normalizePackMetadata(raw.pack);
  if (raw.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      pack,
      files: validateLegacyFiles(raw.files),
      packages: []
    };
  }

  const packages = validatePackages(raw.packages);
  return {
    schemaVersion: 2,
    pack,
    packages,
    files: validatePackageFiles(raw.files, packages)
  };
}

function safePath(gameDirectory, managedPath, normalizer) {
  const root = path.resolve(gameDirectory);
  const destination = path.resolve(root, ...normalizer(managedPath).split('/'));
  const relative = path.relative(root, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Путь выходит за пределы папки игры: ${managedPath}`);
  }
  return destination;
}

function safeDestination(gameDirectory, managedPath) {
  return safePath(gameDirectory, managedPath, normalizeManagedPath);
}

function safePackDestination(gameDirectory, managedPath) {
  return safePath(gameDirectory, managedPath, normalizePackPath);
}

module.exports = {
  SHA256_PATTERN,
  PACKAGE_ID_PATTERN,
  PROTECTED_TOP_LEVEL,
  normalizeManagedPath,
  normalizePackPath,
  validateHttpsUrl,
  validateGithubUrl,
  validateManifest,
  safeDestination,
  safePackDestination
};
