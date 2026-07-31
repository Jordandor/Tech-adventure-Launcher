'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSettings } = require('../src/core/settings');

const defaults = {
  packName: 'Tech Adventure',
  minecraftVersion: '1.21.1',
  neoForgeVersion: '21.1.247',
  manifestUrl: '',
  serverAddress: '',
  minMemoryMb: 4096,
  maxMemoryMb: 8192,
  gameDirectory: '',
  customJavaPath: '',
  closeLauncherOnGameStart: false,
  autoUpdateLauncher: true,
  updateRepository: ''
};

test('настройки памяти и пути нормализуются', () => {
  const result = normalizeSettings({ minMemoryMb: 4096, maxMemoryMb: 12288 }, defaults, '/tmp/game');
  assert.equal(result.maxMemoryMb, 12288);
  assert.equal(result.gameDirectory, '/tmp/game');
});

test('максимум памяти не может быть меньше минимума', () => {
  assert.throws(
    () => normalizeSettings({ minMemoryMb: 8192, maxMemoryMb: 4096 }, defaults, '/tmp/game'),
    /не может быть меньше/
  );
});

test('URL манифеста допускает только HTTPS', () => {
  assert.throws(
    () => normalizeSettings({ manifestUrl: 'http://example.org/manifest.json' }, defaults, '/tmp/game'),
    /HTTPS/
  );
  assert.throws(
    () => normalizeSettings({ manifestUrl: 'https://example.org/manifest.json' }, defaults, '/tmp/game'),
    /GitHub/
  );
});
