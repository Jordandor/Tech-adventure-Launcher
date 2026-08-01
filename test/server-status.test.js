'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {
  encodeVarInt,
  decodeVarInt,
  encodeString,
  framePacket,
  parseServerAddress,
  parseStatusResponse,
  pingMinecraftServer
} = require('../src/core/server-status');

test('VarInt кодируется и декодируется', () => {
  for (const value of [0, 1, 127, 128, 255, 767, 2147483647]) {
    const encoded = encodeVarInt(value);
    assert.equal(decodeVarInt(encoded).value, value >>> 0);
  }
});

test('адрес Minecraft поддерживает порт по умолчанию', () => {
  assert.deepEqual(parseServerAddress('play.example.org'), { ip: 'play.example.org', port: 25565 });
  assert.deepEqual(parseServerAddress('127.0.0.1:25598'), { ip: '127.0.0.1', port: 25598 });
});

test('ответ статуса Minecraft разбирается', () => {
  const json = JSON.stringify({ players: { online: 7, max: 20 }, version: { name: '1.21.1' } });
  const packet = framePacket(Buffer.concat([encodeVarInt(0), encodeString(json)]));
  const parsed = parseStatusResponse(packet);
  assert.equal(parsed.players.online, 7);
  assert.equal(parsed.players.max, 20);
});

test('лаунчер получает число игроков прямым Server List Ping', async (t) => {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      const json = JSON.stringify({
        players: { online: 3, max: 20 },
        version: { name: '1.21.1', protocol: 767 },
        description: { text: 'Test' }
      });
      socket.end(framePacket(Buffer.concat([encodeVarInt(0), encodeString(json)])));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const status = await pingMinecraftServer(`127.0.0.1:${address.port}`, { timeoutMs: 2000 });
  assert.equal(status.reachable, true);
  assert.equal(status.online, 3);
  assert.equal(status.max, 20);
});
