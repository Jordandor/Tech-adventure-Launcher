'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  matchesRuntimeState,
  parseServerAddress,
  replaceAccountLaunchPlaceholders,
  retryNetworkOperation,
  withMicrosoftLaunchArguments,
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
    schemaVersion: 2,
    minecraftVersion: '1.21.1',
    neoForgeVersion: '21.1.235',
    versionId: 'neoforge-21.1.235',
    javaExecutable: 'java/bin/javaw.exe'
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

test('игровая среда не содержит официального сетевого установщика', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'minecraft.js'), 'utf8');
  assert.doesNotMatch(source, /@xmcl\/installer|getVersionList|installNeoForged|fetchJavaRuntimeManifest|installJavaRuntimeTask/);
});


test('аргументы Microsoft получают Client ID и Xbox User ID', () => {
  const resolved = {
    id: 'neoforge-21.1.235',
    arguments: {
      game: [
        '--clientId',
        '${clientid}',
        '--xuid',
        '${auth_xuid}',
        {
          rules: [{ action: 'allow' }],
          value: ['--diagnostic', 'client=${clientid};xuid=${auth_xuid}']
        }
      ],
      jvm: []
    }
  };
  const session = {
    mode: 'microsoft',
    accessToken: 'minecraft-token',
    clientId: 'Y2xpZW50LWlk',
    xuid: '1234567890123456'
  };

  const patched = withMicrosoftLaunchArguments(resolved, session);
  assert.notEqual(patched, resolved);
  assert.deepEqual(patched.arguments.game, [
    '--clientId',
    'Y2xpZW50LWlk',
    '--xuid',
    '1234567890123456',
    {
      rules: [{ action: 'allow' }],
      value: ['--diagnostic', 'client=Y2xpZW50LWlk;xuid=1234567890123456']
    }
  ]);
  assert.equal(resolved.arguments.game[1], '${clientid}');
});

test('неполная Microsoft-сессия блокируется до запуска игры', () => {
  const resolved = { arguments: { game: ['--clientId', '${clientid}'] } };
  assert.throws(
    () => withMicrosoftLaunchArguments(resolved, {
      mode: 'microsoft',
      accessToken: 'token',
      clientId: 'client',
      xuid: ''
    }),
    /Xbox User ID/
  );
});

test('офлайн-запуск не меняет профиль версии', () => {
  const resolved = { arguments: { game: ['${clientid}', '${auth_xuid}'] } };
  assert.equal(withMicrosoftLaunchArguments(resolved, { mode: 'offline' }), resolved);
  assert.equal(
    replaceAccountLaunchPlaceholders('${clientid}:${auth_xuid}', { clientId: 'a', xuid: '1' }),
    'a:1'
  );
});
