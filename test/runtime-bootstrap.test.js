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
  componentMap,
  extractRuntimeArchive,
  validateExtractedRuntime
} = require('../src/core/runtime-bootstrap');

const manifest = {
  schemaVersion: 1,
  runtimeVersion: '1.21.1-neoforge-21.1.235-r1',
  runtimeRevision: 1,
  sourceFormat: 'prismlauncher',
  minecraftVersion: '1.21.1',
  neoForgeVersion: '21.1.235',
  lwjglVersion: '3.3.3',
  archive: {
    fileName: 'runtime.zip',
    url: 'https://github.com/Jordandor/Tech-adventure-Runtime/releases/download/test/runtime.zip',
    sha256: 'a'.repeat(64)
  },
  requiredArchiveEntries: ['assets', 'libraries', 'meta', 'mmc-pack.json'],
  requiredComponents: [
    { uid: 'net.minecraft', version: '1.21.1' },
    { uid: 'net.neoforged', version: '21.1.235' },
    { uid: 'org.lwjgl3', version: '3.3.3' }
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

test('runtime-манифест проверяет версии, GitHub URL и SHA-256', () => {
  const result = validateRuntimeManifest(manifest);
  assert.equal(result.minecraftVersion, '1.21.1');
  assert.equal(result.neoForgeVersion, '21.1.235');
  assert.equal(result.archive.sha256, 'a'.repeat(64));

  assert.throws(
    () => validateRuntimeManifest({ ...manifest, archive: { ...manifest.archive, url: 'https://example.org/runtime.zip' } }),
    /GitHub/
  );
  assert.throws(
    () => validateRuntimeManifest({ ...manifest, archive: { ...manifest.archive, sha256: 'bad' } }),
    /SHA-256/
  );
});

test('пути runtime-архива не могут выходить за разрешённые корни', () => {
  assert.equal(normalizeZipPath('assets/objects/aa/file'), 'assets/objects/aa/file');
  assert.equal(normalizeZipPath('mmc-pack.json'), 'mmc-pack.json');
  assert.throws(() => normalizeZipPath('../accounts.json'), /недопустимый путь/);
  assert.throws(() => normalizeZipPath('accounts.json'), /лишний элемент/);
  assert.throws(() => normalizeZipPath('C:\\Users\\test'), /недопустимый путь/);
});

test('компоненты PrismLauncher читаются из mmc-pack.json', () => {
  const components = componentMap({
    components: [
      { uid: 'net.minecraft', version: '1.21.1' },
      { uid: 'net.neoforged', cachedVersion: '21.1.235' }
    ]
  });
  assert.equal(components.get('net.minecraft'), '1.21.1');
  assert.equal(components.get('net.neoforged'), '21.1.235');
});

test('runtime-архив распаковывается и сверяет компоненты', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-runtime-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'runtime.zip');
  const extracted = path.join(directory, 'extracted');
  await makeZip(archive, {
    'assets/indexes/17.json': '{}',
    'libraries/example/library.jar': 'library',
    'meta/net.minecraft/1.21.1.json': '{}',
    'mmc-pack.json': JSON.stringify({
      formatVersion: 1,
      components: [
        { uid: 'org.lwjgl3', version: '3.3.3' },
        { uid: 'net.minecraft', version: '1.21.1' },
        { uid: 'net.neoforged', version: '21.1.235' }
      ]
    })
  });

  await extractRuntimeArchive(archive, extracted);
  await validateExtractedRuntime(extracted, validateRuntimeManifest(manifest));
  assert.equal(await fsp.readFile(path.join(extracted, 'libraries/example/library.jar'), 'utf8'), 'library');
});
