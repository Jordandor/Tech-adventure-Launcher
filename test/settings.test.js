'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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

const defaultGameDirectory = path.resolve('/tmp/game');

test('настройки памяти и пути нормализуются', () => {
  const result = normalizeSettings(
    { minMemoryMb: 4096, maxMemoryMb: 12288 },
    defaults,
    defaultGameDirectory
  );

  assert.equal(result.maxMemoryMb, 12288);
  assert.equal(result.gameDirectory, defaultGameDirectory);
});

test('максимум памяти не может быть меньше минимума', () => {
  assert.throws(
    () => normalizeSettings(
      { minMemoryMb: 8192, maxMemoryMb: 4096 },
      defaults,
      defaultGameDirectory
    ),
    /не может быть меньше/
  );
});

test('URL манифеста допускает только HTTPS', () => {
  assert.throws(
    () => normalizeSettings(
      { manifestUrl: 'http://example.org/manifest.json' },
      defaults,
      defaultGameDirectory
    ),
    /HTTPS/
  );

  assert.throws(
    () => normalizeSettings(
      { manifestUrl: 'https://example.org/manifest.json' },
      defaults,
      defaultGameDirectory
    ),
    /GitHub/
  );
});
