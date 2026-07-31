'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesRuntimeState,
  parseServerAddress,
  retryNetworkOperation,
  withTimeout
} = require('../src/core/minecraft');

test('адрес сервера разбирается без запуска игры', () => {
  assert.deepEqual(parseServerAddress('play.example.org'), { ip: 'play.example.org', port: 25565 });
  assert.deepEqual(parseServerAddress('play.example.org:25570'), { ip: 'play.example.org', port: 25570 });
  assert.equal(parseServerAddress(''), null);
  assert.throws(() => parseServerAddress('host:99999'), /неверно/);
});

test('готовая среда переиспользуется только при точном совпадении версий', () => {
  const state = {
    minecraftVersion: '1.21.1',
    neoForgeVersion: '21.1.235',
    versionId: 'neoforge-21.1.235'
  };

  assert.equal(matchesRuntimeState(state, '1.21.1', '21.1.235'), true);
  assert.equal(matchesRuntimeState(state, '1.21.1', '21.1.247'), false);
  assert.equal(matchesRuntimeState({ ...state, versionId: '' }, '1.21.1', '21.1.235'), false);
});

test('тайм-аут завершает зависшую операцию понятной ошибкой', async () => {
  await assert.rejects(
    withTimeout(() => new Promise(() => {}), 20, 'Тестовая операция'),
    /превышено время ожидания/
  );
});

test('сетевой запрос повторяется и затем возвращает результат', async () => {
  let attempts = 0;
  const result = await retryNetworkOperation('Тестовый запрос', async () => {
    attempts += 1;
    if (attempts < 3) throw new Error(`Сбой ${attempts}`);
    return 'ok';
  }, {
    attempts: 3,
    timeoutMs: 1000
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});
