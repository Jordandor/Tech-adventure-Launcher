'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validatePackRegistry,
  getPack,
  normalizeTheme
} = require('../src/core/pack-registry');

const rawRegistry = {
  schemaVersion: 1,
  defaultPackId: 'tech-adventure',
  packs: [
    {
      id: 'tech-adventure',
      name: 'Tech Adventure',
      manifestUrl: 'https://raw.githubusercontent.com/Jordandor/Tech-adventure/main/pack-manifest.json',
      runtimeManifestUrl: 'https://raw.githubusercontent.com/Jordandor/Tech-adventure-Runtime/main/runtime-manifest-v2.json',
      minecraftVersion: '1.21.1',
      neoForgeVersion: '21.1.235',
      serverAddress: '127.0.0.1:25565',
      theme: { accent: '#B8E86D' }
    }
  ]
};

test('реестр сборок выбирает Tech Adventure по умолчанию', () => {
  const registry = validatePackRegistry(rawRegistry);
  assert.equal(registry.defaultPackId, 'tech-adventure');
  assert.equal(getPack(registry, 'tech-adventure').name, 'Tech Adventure');
  assert.equal(getPack(registry, 'missing').id, 'tech-adventure');
});

test('тема сборки получает безопасные цвета по умолчанию', () => {
  const theme = normalizeTheme({ accent: '#ABCDEF', secondary: 'red' });
  assert.equal(theme.accent, '#abcdef');
  assert.equal(theme.secondary, '#57b9a9');
});

test('дублирующиеся ID сборок запрещены', () => {
  assert.throws(() => validatePackRegistry({
    ...rawRegistry,
    packs: [rawRegistry.packs[0], rawRegistry.packs[0]]
  }), /повторяется/);
});
