'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfflineSession, offlineUuid, validateOfflineUsername } = require('../src/core/offline-profile');

test('offline UUID совпадает с алгоритмом сервера Minecraft', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
  assert.equal(offlineUuid('Steve'), '5627dd98-e6be-3c21-b8a8-e92344183641');
});

test('offline session не содержит случайных значений', () => {
  const first = createOfflineSession('Player_1');
  const second = createOfflineSession('Player_1');
  assert.deepEqual(first, second);
  assert.equal(first.profile.id.length, 32);
  assert.equal(first.userType, 'legacy');
});

test('ник проверяется по правилам Java Edition', () => {
  assert.equal(validateOfflineUsername('Abc_123'), 'Abc_123');
  assert.throws(() => validateOfflineUsername('ab'), /от 3 до 16/);
  assert.throws(() => validateOfflineUsername('Игрок'), /от 3 до 16/);
  assert.throws(() => validateOfflineUsername('../Steve'), /от 3 до 16/);
});
