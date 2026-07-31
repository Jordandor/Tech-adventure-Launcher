'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  normalizeManagedPath,
  safeDestination,
  safePackDestination,
  validateManifest
} = require('../src/core/manifest');

function goodManifest() {
  return {
    schemaVersion: 1,
    pack: { id: 'pack', name: 'Pack', version: '1.0.0' },
    files: [{
      path: 'mods/example.jar',
      url: 'https://github.com/example/releases/download/v1/example.jar',
      sha256: 'a'.repeat(64),
      size: 42
    }]
  };
}

test('валидный манифест нормализуется', () => {
  const manifest = validateManifest(goodManifest());
  assert.equal(manifest.files[0].path, 'mods/example.jar');
  assert.equal(manifest.pack.minecraftVersion, '1.21.1');
});

test('переходы вверх и абсолютные пути запрещены', () => {
  assert.throws(() => normalizeManagedPath('../options.txt'), /пределы/);
  assert.throws(() => normalizeManagedPath('/etc/passwd'), /Недопустимый/);
  assert.throws(() => normalizeManagedPath('C:\\Windows\\file'), /пределы|Недопустимый/);
});

test('пользовательские данные нельзя добавить в управление', () => {
  for (const protectedPath of ['saves/world/level.dat', 'screenshots/a.png', 'options.txt', 'servers.dat']) {
    assert.throws(() => normalizeManagedPath(protectedPath));
  }
});

test('дубликаты и HTTP-ссылки запрещены', () => {
  const duplicated = goodManifest();
  duplicated.files.push({ ...duplicated.files[0], path: 'MODS/example.jar' });
  assert.throws(() => validateManifest(duplicated), /повторяется/);
  const insecure = goodManifest();
  insecure.files[0].url = 'http://example.org/file.jar';
  assert.throws(() => validateManifest(insecure), /HTTPS/);
  const outsideGithub = goodManifest();
  outsideGithub.files[0].url = 'https://example.org/file.jar';
  assert.throws(() => validateManifest(outsideGithub), /GitHub/);
});

test('safeDestination остаётся внутри корня', () => {
  const root = path.resolve('/tmp/launcher-game');
  assert.equal(safeDestination(root, 'config/test.toml'), path.join(root, 'config', 'test.toml'));
});

test('пакетный манифест поддерживает обновления частями и одноразовые настройки', () => {
  const rawHash = 'b'.repeat(64);
  const zipHash = 'c'.repeat(64);
  const manifest = validateManifest({
    schemaVersion: 2,
    pack: { id: 'pack', name: 'Pack', version: '2.0.0' },
    packages: [
      {
        id: `raw-${rawHash}`,
        format: 'raw',
        url: 'https://github.com/example/pack/releases/download/v2/raw.bin',
        sha256: rawHash,
        size: 42
      },
      {
        id: `zip-${zipHash}`,
        format: 'zip',
        url: 'https://github.com/example/pack/releases/download/v2/config.zip',
        sha256: zipHash,
        size: 100
      }
    ],
    files: [
      { path: 'mods/example.jar', packageId: `raw-${rawHash}`, sha256: rawHash, size: 42, policy: 'managed' },
      { path: 'options.txt', packageId: `zip-${zipHash}`, sha256: 'd'.repeat(64), size: 10, policy: 'seed' }
    ]
  });

  const gameRoot = path.resolve('/tmp/launcher-game');

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.files[1].policy, 'seed');
  assert.equal(
    safePackDestination(gameRoot, 'options.txt'),
    path.join(gameRoot, 'options.txt')
  );
});

test('options.txt нельзя превратить в управляемый файл', () => {
  const digest = 'e'.repeat(64);
  assert.throws(() => validateManifest({
    schemaVersion: 2,
    pack: { id: 'pack' },
    packages: [{
      id: `raw-${digest}`,
      format: 'raw',
      url: 'https://github.com/example/pack/releases/download/v2/file.bin',
      sha256: digest,
      size: 10
    }],
    files: [{ path: 'options.txt', packageId: `raw-${digest}`, sha256: digest, size: 10, policy: 'managed' }]
  }), /только один раз/);
});
