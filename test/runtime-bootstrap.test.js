'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const {
  validateRuntimeManifest,
  normalizeZipPath,
  extractRuntimeArchive,
  validateExtractedRuntime
} = require('../src/core/runtime-bootstrap');

const manifest = {
  schemaVersion: 2,
  runtimeVersion: '1.21.1-neoforge-21.1.235-r2',
  runtimeRevision: 2,
  sourceFormat: 'standard-minecraft-launcher',
  platform: 'windows-x64',
  minecraftVersion: '1.21.1',
  neoForgeVersion: '21.1.235',
  versionId: 'neoforge-21.1.235',
  baseVersionId: '1.21.1',
  java: {
    majorVersion: 21,
    executable: 'java/bin/javaw.exe',
    consoleExecutable: 'java/bin/java.exe'
  },
  archive: {
    fileName: 'runtime.zip',
    url: 'https://github.com/Jordandor/Tech-adventure-Runtime/releases/download/test/runtime.zip',
    sha256: 'a'.repeat(64)
  },
  requiredArchiveEntries: ['assets', 'libraries', 'versions', 'java'],
  requiredFiles: [
    'versions/1.21.1/1.21.1.jar',
    'versions/1.21.1/1.21.1.json',
    'versions/neoforge-21.1.235/neoforge-21.1.235.json',
    'java/bin/java.exe',
    'java/bin/javaw.exe'
  ]
};

async function makeZip(file, entries) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) {
    zip.addBuffer(Buffer.from(content), name);
  }
  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(file));
}

test('runtime-манифест v2 проверяет профили, Java, GitHub URL и SHA-256', () => {
  const result = validateRuntimeManifest(manifest);
  assert.equal(result.minecraftVersion, '1.21.1');
  assert.equal(result.neoForgeVersion, '21.1.235');
  assert.equal(result.versionId, 'neoforge-21.1.235');
  assert.equal(result.java.majorVersion, 21);
  assert.equal(result.archive.sha256, 'a'.repeat(64));

  assert.throws(
    () => validateRuntimeManifest({ ...manifest, archive: { ...manifest.archive, url: 'https://example.org/runtime.zip' } }),
    /GitHub/
  );
  assert.throws(
    () => validateRuntimeManifest({ ...manifest, archive: { ...manifest.archive, sha256: 'bad' } }),
    /SHA-256/
  );
  assert.throws(
    () => validateRuntimeManifest({ ...manifest, schemaVersion: 1 }),
    /Неподдерживаемая/
  );
});

test('пути runtime-архива не могут выходить за разрешённые корни', () => {
  assert.equal(normalizeZipPath('assets/objects/aa/file'), 'assets/objects/aa/file');
  assert.equal(normalizeZipPath('versions/1.21.1/1.21.1.json'), 'versions/1.21.1/1.21.1.json');
  assert.equal(normalizeZipPath('java/bin/javaw.exe'), 'java/bin/javaw.exe');
  assert.throws(() => normalizeZipPath('../accounts.json'), /недопустимый путь/);
  assert.throws(() => normalizeZipPath('accounts.json'), /assets, libraries, versions или java/);
  assert.throws(() => normalizeZipPath('C:\\Users\\test'), /недопустимый путь/);
});

test('стандартный runtime распаковывается и сверяет профили Minecraft и NeoForge', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-runtime-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'runtime.zip');
  const extracted = path.join(directory, 'extracted');
  await makeZip(archive, {
    'assets/indexes/17.json': '{}',
    'libraries/example/library.jar': 'library',
    'versions/1.21.1/1.21.1.jar': 'client',
    'versions/1.21.1/1.21.1.json': JSON.stringify({
      id: '1.21.1',
      javaVersion: { component: 'java-runtime-delta', majorVersion: 21 }
    }),
    'versions/neoforge-21.1.235/neoforge-21.1.235.json': JSON.stringify({
      id: 'neoforge-21.1.235',
      inheritsFrom: '1.21.1',
      arguments: {
        game: ['--fml.neoForgeVersion', '21.1.235', '--launchTarget', 'forgeclient']
      }
    }),
    'java/bin/java.exe': 'java',
    'java/bin/javaw.exe': 'javaw'
  });

  await extractRuntimeArchive(archive, extracted);
  await validateExtractedRuntime(extracted, validateRuntimeManifest(manifest));
  assert.equal(await fsp.readFile(path.join(extracted, 'libraries/example/library.jar'), 'utf8'), 'library');
});
