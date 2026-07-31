'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');
const { syncPack } = require('../src/core/synchronizer');

function createZip(entries) {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    const chunks = [];
    archive.outputStream.on('data', (chunk) => chunks.push(chunk));
    archive.outputStream.on('error', reject);
    archive.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of Object.entries(entries)) {
      archive.addBuffer(Buffer.from(content), name, { mtime: new Date('2020-01-01T00:00:00Z'), mode: 0o100644 });
    }
    archive.end();
  });
}

test('синхронизация скачивает GitHub-файл, сохраняет пользовательские данные и убирает старый мод', async (t) => {
  const game = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-sync-test-'));
  t.after(() => fs.rm(game, { recursive: true, force: true }));
  const metadata = path.join(game, '.tech-adventure-launcher');
  await fs.mkdir(path.join(game, 'mods'), { recursive: true });
  await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(game, 'mods', 'old.jar'), 'old');
  await fs.writeFile(path.join(game, 'options.txt'), 'fov:0.5');
  await fs.writeFile(path.join(metadata, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    files: [{ path: 'mods/old.jar', sha256: '0'.repeat(64), size: 3 }]
  }));

  const payload = Buffer.from('new mod bytes');
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const manifest = {
    schemaVersion: 1,
    pack: { id: 'test', name: 'Test', version: '1.0.0', minecraftVersion: '1.21.1', neoForgeVersion: '21.1.247' },
    files: [{
      path: 'mods/new.jar',
      url: 'https://github.com/example/pack/releases/download/v1/new.jar',
      sha256: digest,
      size: payload.length
    }]
  };

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('manifest.json')) {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await syncPack({
    manifestUrl: 'https://raw.githubusercontent.com/example/pack/main/manifest.json',
    gameDirectory: game,
    force: true
  });
  assert.deepEqual(result.changed, ['mods/new.jar']);
  assert.deepEqual(result.moved, ['mods/old.jar']);
  assert.equal(await fs.readFile(path.join(game, 'mods', 'new.jar'), 'utf8'), payload.toString());
  assert.equal(await fs.readFile(path.join(game, 'options.txt'), 'utf8'), 'fov:0.5');
  await assert.rejects(fs.access(path.join(game, 'mods', 'old.jar')));
});

test('пакетная синхронизация скачивает только нужные пакеты и не сбрасывает seed-настройки', async (t) => {
  const game = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-package-test-'));
  t.after(() => fs.rm(game, { recursive: true, force: true }));
  const metadata = path.join(game, '.tech-adventure-launcher');
  await fs.mkdir(path.join(game, 'mods'), { recursive: true });
  await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(game, 'mods', 'old.jar'), 'old');
  await fs.writeFile(path.join(game, 'options.txt'), 'lang:ru_ru');
  await fs.writeFile(path.join(metadata, 'state.json'), JSON.stringify({
    schemaVersion: 2,
    packId: 'test',
    files: [{ path: 'mods/old.jar', sha256: '0'.repeat(64), size: 3, policy: 'managed' }]
  }));

  const modPayload = Buffer.from('new mod bytes');
  const irisPayload = Buffer.from('enableShaders=true\nshaderPack=Complementary.zip\n');
  const configPayload = Buffer.from('enabled=true\n');
  const optionsPayload = Buffer.from('lang:ru_ru\nresourcePacks:["file/Fresh.zip"]\n');
  const zipPayload = await createZip({
    'config/iris.properties': irisPayload,
    'config/pack.toml': configPayload,
    'options.txt': optionsPayload
  });
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const modHash = digest(modPayload);
  const zipHash = digest(zipPayload);
  const manifest = {
    schemaVersion: 2,
    pack: { id: 'test', name: 'Test', version: '2.0.0', minecraftVersion: '1.21.1', neoForgeVersion: '21.1.247' },
    packages: [
      {
        id: `raw-${modHash}`,
        format: 'raw',
        url: 'https://github.com/example/pack/releases/download/v2/mod.bin',
        sha256: modHash,
        size: modPayload.length
      },
      {
        id: `zip-${zipHash}`,
        format: 'zip',
        url: 'https://github.com/example/pack/releases/download/v2/settings.zip',
        sha256: zipHash,
        size: zipPayload.length
      }
    ],
    files: [
      { path: 'mods/new.jar', packageId: `raw-${modHash}`, sha256: modHash, size: modPayload.length, policy: 'managed' },
      { path: 'config/iris.properties', packageId: `zip-${zipHash}`, sha256: digest(irisPayload), size: irisPayload.length, policy: 'seed' },
      { path: 'config/pack.toml', packageId: `zip-${zipHash}`, sha256: digest(configPayload), size: configPayload.length, policy: 'managed' },
      { path: 'options.txt', packageId: `zip-${zipHash}`, sha256: digest(optionsPayload), size: optionsPayload.length, policy: 'seed' }
    ]
  };

  const originalFetch = global.fetch;
  const assetRequests = [];
  global.fetch = async (url) => {
    const text = String(url);
    if (text.includes('manifest.json')) {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assetRequests.push(text);
    const payload = text.endsWith('mod.bin') ? modPayload : zipPayload;
    return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
  };
  t.after(() => { global.fetch = originalFetch; });

  const first = await syncPack({
    manifestUrl: 'https://raw.githubusercontent.com/example/pack/main/manifest.json',
    gameDirectory: game,
    force: true
  });
  assert.deepEqual(first.changed, ['config/iris.properties', 'config/pack.toml', 'mods/new.jar']);
  assert.deepEqual(first.moved, ['mods/old.jar']);
  assert.equal(await fs.readFile(path.join(game, 'options.txt'), 'utf8'), 'lang:ru_ru');
  assert.equal(await fs.readFile(path.join(game, 'config', 'iris.properties'), 'utf8'), irisPayload.toString());
  assert.equal(await fs.readFile(path.join(game, 'config', 'pack.toml'), 'utf8'), configPayload.toString());

  await fs.writeFile(path.join(game, 'config', 'iris.properties'), 'enableShaders=false\n');
  await fs.writeFile(path.join(game, 'config', 'pack.toml'), 'broken=true\n');
  assetRequests.length = 0;
  const repaired = await syncPack({
    manifestUrl: 'https://raw.githubusercontent.com/example/pack/main/manifest.json',
    gameDirectory: game,
    force: true
  });
  assert.deepEqual(repaired.changed, ['config/pack.toml']);
  assert.equal(assetRequests.length, 1);
  assert.match(assetRequests[0], /settings\.zip$/);
  assert.equal(await fs.readFile(path.join(game, 'config', 'iris.properties'), 'utf8'), 'enableShaders=false\n');
  assert.equal(await fs.readFile(path.join(game, 'config', 'pack.toml'), 'utf8'), configPayload.toString());
});
