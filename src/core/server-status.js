'use strict';

const net = require('node:net');
const DEFAULT_PROTOCOL_VERSION = 767;


function parseServerAddress(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(`minecraft://${text}`);
  } catch {
    throw new Error('Адрес сервера указан неверно. Пример: play.example.org:25565');
  }
  const port = url.port ? Number(url.port) : 25565;
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Адрес сервера указан неверно. Пример: play.example.org:25565');
  }
  return { ip: url.hostname, port };
}

function encodeVarInt(input) {
  let value = Number(input) >>> 0;
  const bytes = [];
  do {
    let current = value & 0x7f;
    value >>>= 7;
    if (value !== 0) current |= 0x80;
    bytes.push(current);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function decodeVarInt(buffer, offset = 0) {
  let value = 0;
  let position = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const current = buffer[cursor];
    value |= (current & 0x7f) << position;
    cursor += 1;
    if ((current & 0x80) === 0) {
      return { value: value >>> 0, bytes: cursor - offset };
    }
    position += 7;
    if (position >= 35) throw new Error('Сервер прислал слишком длинный VarInt.');
  }
  return null;
}

function encodeString(value) {
  const data = Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeVarInt(data.length), data]);
}

function framePacket(payload) {
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

function buildStatusRequest(host, port, protocolVersion = DEFAULT_PROTOCOL_VERSION) {
  const portBuffer = Buffer.allocUnsafe(2);
  portBuffer.writeUInt16BE(port, 0);
  const handshake = Buffer.concat([
    encodeVarInt(0),
    encodeVarInt(protocolVersion),
    encodeString(host),
    portBuffer,
    encodeVarInt(1)
  ]);
  return Buffer.concat([
    framePacket(handshake),
    framePacket(encodeVarInt(0))
  ]);
}

function parseStatusResponse(buffer) {
  const frame = decodeVarInt(buffer, 0);
  if (!frame) return null;
  const frameEnd = frame.bytes + frame.value;
  if (buffer.length < frameEnd) return null;

  let cursor = frame.bytes;
  const packetId = decodeVarInt(buffer, cursor);
  if (!packetId) return null;
  cursor += packetId.bytes;
  if (packetId.value !== 0) throw new Error(`Неожиданный пакет статуса: ${packetId.value}.`);

  const jsonLength = decodeVarInt(buffer, cursor);
  if (!jsonLength) return null;
  cursor += jsonLength.bytes;
  if (cursor + jsonLength.value > frameEnd) throw new Error('Повреждённый JSON-пакет статуса сервера.');
  const json = buffer.subarray(cursor, cursor + jsonLength.value).toString('utf8');
  return JSON.parse(json);
}

function normalizeStatus(raw, latencyMs) {
  const online = Number(raw?.players?.online);
  const max = Number(raw?.players?.max);
  return {
    reachable: true,
    online: Number.isFinite(online) && online >= 0 ? Math.floor(online) : 0,
    max: Number.isFinite(max) && max >= 0 ? Math.floor(max) : 0,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    version: String(raw?.version?.name || ''),
    checkedAt: new Date().toISOString()
  };
}

async function pingMinecraftServer(serverAddress, {
  timeoutMs = 5000,
  protocolVersion = DEFAULT_PROTOCOL_VERSION
} = {}) {
  const endpoint = parseServerAddress(serverAddress);
  if (!endpoint) throw new Error('Адрес сервера не настроен.');
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const socket = net.createConnection({ host: endpoint.ip, port: endpoint.port });

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      callback();
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(buildStatusRequest(endpoint.ip, endpoint.port, protocolVersion));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const raw = parseStatusResponse(buffer);
        if (!raw) return;
        finish(() => resolve(normalizeStatus(raw, Date.now() - startedAt)));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once('timeout', () => finish(() => reject(new Error('Сервер не ответил вовремя.'))));
    socket.once('error', (error) => finish(() => reject(error)));
    socket.once('close', () => {
      if (!settled) finish(() => reject(new Error('Сервер закрыл соединение без ответа.')));
    });
  });
}

module.exports = {
  DEFAULT_PROTOCOL_VERSION,
  parseServerAddress,
  encodeVarInt,
  decodeVarInt,
  encodeString,
  framePacket,
  buildStatusRequest,
  parseStatusResponse,
  normalizeStatus,
  pingMinecraftServer
};
