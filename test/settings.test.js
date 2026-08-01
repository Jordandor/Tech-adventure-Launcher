'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  SettingsStore,
  normalizeSettings,
  migrateSavedSettings,
  normalizeMinecraftSkinUrl
} = require('../src/core/settings');

const defaults = {
  packName: 'Tech Adventure',
  minecraftVersion: '1.21.1',
  neoForgeVersion: '21.1.235',
  manifestUrl: 'https://raw.githubusercontent.com/Jordandor/Tech-adventure/main/pack-manifest.json',
  runtimeManifestUrl: 'https://raw.githubusercontent.com/Jordandor/Tech-adventure-Runtime/main/runtime-manifest-v2.json',
  serverAddress: '',
  minMemoryMb: 4096,
  maxMemoryMb: 8192,
  gameDirectory: '',
  customJavaPath: '',
  closeLauncherOnGameStart: false,
  autoUpdateLauncher: true,
  updateRepository: 'Jordandor/Tech-adventure-Launcher'
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

test('пустые служебные ссылки восстанавливаются из новых значений по умолчанию', () => {
  const result = normalizeSettings(
    { manifestUrl: '', runtimeManifestUrl: '', updateRepository: '' },
    defaults,
    defaultGameDirectory
  );

  assert.equal(result.manifestUrl, defaults.manifestUrl);
  assert.equal(result.runtimeManifestUrl, defaults.runtimeManifestUrl);
  assert.equal(result.updateRepository, defaults.updateRepository);
});

test('устаревшая версия NeoForge мигрирует на 21.1.235', () => {
  const migrated = migrateSavedSettings({
    neoForgeVersion: '21.1.247',
    manifestUrl: '',
    runtimeManifestUrl: '',
    updateRepository: ''
  }, defaults);

  assert.equal(migrated.neoForgeVersion, '21.1.235');
  assert.equal(Object.hasOwn(migrated, 'manifestUrl'), false);
  assert.equal(Object.hasOwn(migrated, 'runtimeManifestUrl'), false);
  assert.equal(Object.hasOwn(migrated, 'updateRepository'), false);
});


test('старый Prism runtime-манифест мигрирует на стандартный runtime v2', () => {
  const migrated = migrateSavedSettings({
    runtimeManifestUrl: 'https://raw.githubusercontent.com/Jordandor/Tech-adventure-Runtime/main/runtime-manifest.json'
  }, defaults);

  assert.equal(migrated.runtimeManifestUrl, defaults.runtimeManifestUrl);
});

test('лицо скина Microsoft сохраняется только с textures.minecraft.net', () => {
  const skinUrl = 'https://textures.minecraft.net/texture/abcdef123456';
  const result = normalizeSettings({
    lastMicrosoftProfile: {
      name: 'Player',
      id: '1234567890abcdef1234567890abcdef',
      skins: [{ state: 'ACTIVE', url: skinUrl }]
    }
  }, defaults, defaultGameDirectory);

  assert.equal(result.lastMicrosoftProfile.skinUrl, skinUrl);
  assert.equal(normalizeMinecraftSkinUrl('https://example.org/skin.png'), '');
  assert.equal(
    normalizeMinecraftSkinUrl('http://textures.minecraft.net/texture/test'),
    'https://textures.minecraft.net/texture/test'
  );
});

test('SettingsStore сохраняет миграцию старых настроек', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-settings-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const defaultsPath = path.join(directory, 'defaults.json');
  const settingsPath = path.join(directory, 'settings.json');
  await fs.writeFile(defaultsPath, JSON.stringify(defaults));
  await fs.writeFile(settingsPath, JSON.stringify({
    neoForgeVersion: '21.1.247',
    manifestUrl: '',
    runtimeManifestUrl: '',
    updateRepository: '',
    maxMemoryMb: 12288
  }));

  const store = new SettingsStore({
    defaultsPath,
    settingsPath,
    defaultGameDirectory
  });
  const loaded = await store.load();

  assert.equal(loaded.neoForgeVersion, '21.1.235');
  assert.equal(loaded.manifestUrl, defaults.manifestUrl);
  assert.equal(loaded.runtimeManifestUrl, defaults.runtimeManifestUrl);
  assert.equal(loaded.updateRepository, defaults.updateRepository);
  assert.equal(loaded.maxMemoryMb, 12288);

  const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.equal(persisted.neoForgeVersion, '21.1.235');
});

test('для каждой сборки сохраняется отдельная игровая папка', () => {
  const result = normalizeSettings({
    activePackId: 'tech-adventure',
    gameDirectory: '/tmp/tech-adventure',
    packDirectories: { another: '/tmp/another-pack' }
  }, { ...defaults, activePackId: 'tech-adventure' }, defaultGameDirectory);

  assert.equal(result.activePackId, 'tech-adventure');
  assert.equal(result.packDirectories['tech-adventure'], path.resolve('/tmp/tech-adventure'));
  assert.equal(result.packDirectories.another, path.resolve('/tmp/another-pack'));
});
