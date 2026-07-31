#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const yazl = require('yazl');
const { normalizePackPath, validateManifest } = require('../src/core/manifest');

const DEFAULT_ROOTS = [
  'mods',
  'config',
  'CustomSkinLoader',
  'defaultconfigs',
  'kubejs',
  'resourcepacks',
  'shaderpacks',
  'scripts',
  'options.txt'
];
const DEFAULT_SEED_PATHS = [
  'options.txt',
  'config/iris.properties',
  'config/sodium-options.json',
  'config/embeddium-options.json',
  'config/oculus.properties'
];
const DEFAULT_EXCLUDED_PATHS = new Set([
  'customskinloader/customskinloader.log',
  'customskinloader/customskinapiplus-clientid'
]);
const FIXED_ZIP_TIME = new Date('2020-01-01T00:00:00.000Z');

function parseArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Неизвестный аргумент: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function required(args, name) {
  const value = String(args[name] || '').trim();
  if (!value) throw new Error(`Не указан обязательный параметр --${name}.`);
  return value;
}

function commaList(value, fallback) {
  return String(value || fallback.join(','))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function integerOption(value, fallback, { min, max, label }) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}: ожидалось целое число от ${min} до ${max}.`);
  }
  return parsed;
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function walk(directory, root = directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`Символические ссылки не поддерживаются: ${absolute}`);
    }
    if (entry.isDirectory()) result.push(...await walk(absolute, root));
    else if (entry.isFile()) result.push({
      absolute,
      relative: path.relative(root, absolute).split(path.sep).join('/')
    });
  }
  return result;
}

async function collectFiles(source, roots) {
  const collected = new Map();
  for (const rootName of roots) {
    const normalizedRoot = normalizePackPath(rootName);
    const absolute = path.join(source, ...normalizedRoot.split('/'));
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Символические ссылки не поддерживаются: ${absolute}`);
    const candidates = info.isDirectory()
      ? await walk(absolute, source)
      : info.isFile()
        ? [{ absolute, relative: normalizedRoot }]
        : [];
    for (const candidate of candidates) {
      const managedPath = normalizePackPath(candidate.relative);
      const key = managedPath.toLowerCase();
      const segments = key.split('/');
      if (
        segments.includes('.index')
        || key.startsWith('customskinloader/caches/')
        || DEFAULT_EXCLUDED_PATHS.has(key)
        || key.endsWith('.log')
        || key.endsWith('thumbs.db')
        || key.endsWith('.ds_store')
      ) continue;
      if (collected.has(key)) throw new Error(`Файл ${managedPath} попал в публикацию дважды.`);
      collected.set(key, { absolute: candidate.absolute, path: managedPath });
    }
  }
  return [...collected.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function joinUrl(baseUrl, assetName) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(encodeURIComponent(assetName), normalizedBase).toString();
}

async function readPreviousManifest(value) {
  const location = String(value || '').trim();
  if (!location) return null;
  let raw;
  if (/^https:\/\//i.test(location)) {
    const response = await fetch(location, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Не удалось получить предыдущий манифест: ${response.status}.`);
    raw = await response.json();
  } else {
    raw = JSON.parse(await readFile(path.resolve(location), 'utf8'));
  }
  const manifest = validateManifest(raw);
  return manifest.schemaVersion === 2 ? manifest : null;
}

async function createDeterministicZip(files, output) {
  await mkdir(path.dirname(output), { recursive: true });
  const archive = new yazl.ZipFile();
  for (const file of files.slice().sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    archive.addFile(file.absolute, file.path, {
      compress: true,
      mtime: FIXED_ZIP_TIME,
      mode: 0o100644
    });
  }
  archive.end();
  await pipeline(archive.outputStream, createWriteStream(output, { flags: 'wx' }));
}

async function moveAcrossFilesystems(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

function printHelp() {
  console.log(`
Генератор пакетного манифеста Tech Adventure

Обязательные параметры:
  --source <папка>          Корень готовой клиентской сборки
  --base-url <HTTPS URL>    URL Assets нового GitHub Release
  --pack-version <версия>   Версия сборки, например 1.0.1
  --assets <папка>          Пустая папка для новых пакетов релиза

Полезные параметры:
  --previous <файл|URL>     Манифест предыдущей версии для переиспользования пакетов
  --output <файл>           Результат (по умолчанию pack-manifest.json)
  --plan <файл>             Список новых Assets (по умолчанию pack-publish-plan.json)
  --roots <список>          Управляемые папки и файлы через запятую
  --seed <список>           Настройки, которые ставятся только при отсутствии
  --direct-threshold-mb N   Файлы от N МиБ публикуются отдельно (по умолчанию 2)
  --buckets N               Число стабильных ZIP-корзин для мелких файлов (по умолчанию 64)
  --minecraft <версия>      По умолчанию 1.21.1
  --neoforge <версия>       По умолчанию 21.1.247
  --server <адрес:порт>     Сервер для автоматического подключения
  --news <текст>            Новость этой версии

Неизменившиеся пакеты сохраняют старые URL. В Assets попадают только новые
объекты, поэтому игроки скачивают лишь изменившуюся часть сборки.
`);
}

async function generateManifest(args) {
  const source = path.resolve(required(args, 'source'));
  const baseUrl = required(args, 'base-url');
  const packVersion = required(args, 'pack-version');
  const assetsDirectory = path.resolve(required(args, 'assets'));
  const output = path.resolve(String(args.output || 'pack-manifest.json'));
  const planOutput = path.resolve(String(args.plan || 'pack-publish-plan.json'));
  const parsedBaseUrl = new URL(baseUrl);
  const githubHost = parsedBaseUrl.hostname === 'github.com'
    || parsedBaseUrl.hostname === 'raw.githubusercontent.com'
    || parsedBaseUrl.hostname.endsWith('.githubusercontent.com');
  if (parsedBaseUrl.protocol !== 'https:' || !githubHost) {
    throw new Error('--base-url должен быть HTTPS-ссылкой на GitHub.');
  }
  if (!(await stat(source)).isDirectory()) throw new Error(`Папка не найдена: ${source}`);

  await mkdir(assetsDirectory, { recursive: true });
  if ((await readdir(assetsDirectory)).length > 0) {
    throw new Error(`Папка --assets должна быть пустой: ${assetsDirectory}`);
  }

  const roots = commaList(args.roots, DEFAULT_ROOTS);
  const seedSet = new Set(commaList(args.seed, DEFAULT_SEED_PATHS).map((entry) => normalizePackPath(entry).toLowerCase()));
  seedSet.add('options.txt');
  const directThresholdMb = integerOption(args['direct-threshold-mb'], 2, {
    min: 1,
    max: 512,
    label: '--direct-threshold-mb'
  });
  const bucketCount = integerOption(args.buckets, 64, { min: 8, max: 512, label: '--buckets' });
  const directThreshold = directThresholdMb * 1024 * 1024;
  const previous = await readPreviousManifest(args.previous);
  const previousPackages = new Map((previous?.packages || []).map((entry) => [entry.id, entry]));

  const sourceFiles = await collectFiles(source, roots);
  const files = await Promise.all(sourceFiles.map(async (file) => {
    const info = await stat(file.absolute);
    return {
      ...file,
      size: info.size,
      sha256: await sha256(file.absolute),
      policy: seedSet.has(file.path.toLowerCase()) ? 'seed' : 'managed'
    };
  }));

  const rawGroups = new Map();
  const buckets = new Map();
  for (const file of files) {
    if (file.size >= directThreshold) {
      if (!rawGroups.has(file.sha256)) rawGroups.set(file.sha256, []);
      rawGroups.get(file.sha256).push(file);
      continue;
    }
    const bucket = Number.parseInt(hashText(file.path.toLowerCase()).slice(0, 8), 16) % bucketCount;
    const key = String(bucket).padStart(String(bucketCount - 1).length, '0');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(file);
  }

  const packages = [];
  const newAssets = [];
  for (const [digest, members] of [...rawGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const id = `raw-${digest}`;
    const previousPackage = previousPackages.get(id);
    const assetName = `file-${digest}.bin`;
    const pack = previousPackage?.format === 'raw'
      && previousPackage.sha256 === digest
      && previousPackage.size === members[0].size
      ? previousPackage
      : {
          id,
          format: 'raw',
          url: joinUrl(baseUrl, assetName),
          sha256: digest,
          size: members[0].size
        };
    packages.push(pack);
    if (pack !== previousPackage) {
      await copyFile(members[0].absolute, path.join(assetsDirectory, assetName));
      newAssets.push(assetName);
    }
    for (const file of members) file.packageId = id;
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'tech-adventure-pack-'));
  try {
    for (const [bucket, members] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const temporaryZip = path.join(temporaryDirectory, `bucket-${bucket}.zip`);
      await createDeterministicZip(members, temporaryZip);
      const digest = await sha256(temporaryZip);
      const size = (await stat(temporaryZip)).size;
      const id = `zip-${digest}`;
      const previousPackage = previousPackages.get(id);
      const assetName = `bundle-${digest}.zip`;
      const pack = previousPackage?.format === 'zip'
        && previousPackage.sha256 === digest
        && previousPackage.size === size
        ? previousPackage
        : {
            id,
            format: 'zip',
            url: joinUrl(baseUrl, assetName),
            sha256: digest,
            size
          };
      packages.push(pack);
      if (pack !== previousPackage) {
        await moveAcrossFilesystems(temporaryZip, path.join(assetsDirectory, assetName));
        newAssets.push(assetName);
      }
      for (const file of members) file.packageId = id;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  packages.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const manifest = validateManifest({
    schemaVersion: 2,
    pack: {
      id: String(args.id || 'tech-adventure'),
      name: String(args.name || 'Tech Adventure'),
      version: packVersion,
      minecraftVersion: String(args.minecraft || '1.21.1'),
      neoForgeVersion: String(args.neoforge || '21.1.247'),
      serverAddress: String(args.server || ''),
      news: String(args.news || '')
    },
    packages,
    files: files
      .map(({ path: filePath, sha256: digest, size, packageId, policy }) => ({
        path: filePath,
        sha256: digest,
        size,
        packageId,
        policy
      }))
      .sort((a, b) => a.path.localeCompare(b.path, 'en'))
  });

  const plan = {
    schemaVersion: 1,
    packVersion,
    manifest: path.basename(output),
    newAssets: newAssets.sort(),
    reusedPackages: packages.length - newAssets.length,
    totalPackages: packages.length,
    totalFiles: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0)
  };
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(path.dirname(planOutput), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(planOutput, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return { manifest, plan, output, planOutput, assetsDirectory };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) return printHelp();
  const result = await generateManifest(args);
  console.log(`Создан ${result.output}`);
  console.log(`Файлов сборки: ${result.plan.totalFiles}`);
  console.log(`Пакетов в манифесте: ${result.plan.totalPackages}`);
  console.log(`Новых Assets: ${result.plan.newAssets.length}`);
  console.log(`Переиспользовано пакетов: ${result.plan.reusedPackages}`);
  console.log(`Assets для релиза: ${result.assetsDirectory}`);
}

const directExecution = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (directExecution) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

export {
  DEFAULT_ROOTS,
  DEFAULT_SEED_PATHS,
  collectFiles,
  createDeterministicZip,
  generateManifest,
  parseArguments
};
