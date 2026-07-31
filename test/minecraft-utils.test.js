'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseServerAddress } = require('../src/core/minecraft');

test('адрес сервера разбирается без запуска игры', () => {
  assert.deepEqual(parseServerAddress('play.example.org'), { ip: 'play.example.org', port: 25565 });
  assert.deepEqual(parseServerAddress('play.example.org:25570'), { ip: 'play.example.org', port: 25570 });
  assert.equal(parseServerAddress(''), null);
  assert.throws(() => parseServerAddress('host:99999'), /неверно/);
});
