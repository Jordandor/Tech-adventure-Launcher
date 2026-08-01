'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  normalizePackSummary,
  readCachedPackSummary,
  writeCachedPackSummary
} = require('../src/core/pack-info');

test('сводка сборки берёт сервер из локального профиля, если манифест оставил его пустым', () => {
  const summary = normalizePackSummary({
    id: 'tech-adventure',
    name: 'Tech Adventure',
    version: '1.0.2',
    serverAddress: ''
  }, {
    serverAddress: '127.0.0.1:25565',
    minecraftVersion: '1.21.1'
  });
  assert.equal(summary.serverAddress, '127.0.0.1:25565');
  assert.equal(summary.version, '1.0.2');
});

test('последняя версия сборки сохраняется для показа без сети', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dekodev-pack-info-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await writeCachedPackSummary(directory, {
    id: 'tech-adventure',
    name: 'Tech Adventure',
    version: '1.0.2',
    minecraftVersion: '1.21.1',
    neoForgeVersion: '21.1.235',
    news: 'Обновление'
  });
  const cached = await readCachedPackSummary(directory, 'tech-adventure');
  assert.equal(cached.pack.version, '1.0.2');
  assert.equal(cached.fromCache, true);
  assert.equal(cached.stale, true);
});
