'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createMinecraftClientId,
  getOrCreateMinecraftClientId,
  isValidMinecraftClientId,
  normalizeXboxUserId,
  MINECRAFT_CLIENT_ID_FILE
} = require('../src/core/auth');

test('Client ID Minecraft имеет стабильный UUID в Base64', () => {
  const clientId = createMinecraftClientId();
  assert.equal(isValidMinecraftClientId(clientId), true);
  assert.match(Buffer.from(clientId, 'base64').toString('utf8'), /^[0-9a-f-]{36}$/i);
});

test('Client ID сохраняется и переиспользуется между запусками', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dekodev-client-id-'));
  try {
    const first = await getOrCreateMinecraftClientId(directory);
    const second = await getOrCreateMinecraftClientId(directory);
    assert.equal(second, first);
    assert.equal(
      (await fs.readFile(path.join(directory, MINECRAFT_CLIENT_ID_FILE), 'utf8')).trim(),
      first
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Microsoft-сессия использует MSA и запрашивает XUID без обязательного xid', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'core', 'auth.js'), 'utf8');
  assert.match(source, /userType:\s*'msa'/);
  assert.match(source, /getXboxToken\(MINECRAFT_XSTS_RELYING_PARTY\)/);
  assert.doesNotMatch(source, /userType:\s*'mojang'/);
});


test('отсутствующий необязательный XUID заменяется на безопасное значение 0', () => {
  assert.equal(normalizeXboxUserId('2535000000000000'), '2535000000000000');
  assert.equal(normalizeXboxUserId(''), '0');
  assert.equal(normalizeXboxUserId(null), '0');
  assert.equal(normalizeXboxUserId('not-a-number'), '0');
});
