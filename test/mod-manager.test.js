'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');
const {
  listMods,
  analyzeModToggle,
  toggleMods,
  toggleMod,
  setAllMods,
  readDisabledRegistry,
  reapplyDisabledMods
} = require('../src/core/mod-manager');

function createJar(entries) {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    const chunks = [];
    archive.outputStream.on('data', (chunk) => chunks.push(chunk));
    archive.outputStream.on('error', reject);
    archive.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of Object.entries(entries)) {
      archive.addBuffer(Buffer.from(content), name, { mtime: new Date('2020-01-01T00:00:00Z'), mode: 0o100644 });
    }
    archive.end();
  });
}

async function neoForgeJar({
  version = '1.0',
  modId = 'example_mod',
  name = 'Example Mod',
  dependencies = []
} = {}) {
  const dependencyBlocks = dependencies.map((dependency) => `
[[dependencies.${modId}]]
modId="${dependency.modId}"
type="${dependency.type || 'required'}"
versionRange="[1,)"
ordering="NONE"
side="${dependency.side || 'BOTH'}"
`).join('');
  return createJar({
    'META-INF/neoforge.mods.toml': `modLoader="javafml"
loaderVersion="[4,)"
license="MIT"
[[mods]]
modId="${modId}"
version="${version}"
displayName="${name}"
description='''Тестовый мод'''
${dependencyBlocks}`,
    'META-INF/MANIFEST.MF': `Manifest-Version: 1.0\nImplementation-Version: ${version}\n`
  });
}

async function createGame(t, mods) {
  const game = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-mod-manager-'));
  t.after(() => fs.rm(game, { recursive: true, force: true }));
  await fs.mkdir(path.join(game, 'mods'), { recursive: true });
  for (const [fileName, options] of Object.entries(mods)) {
    await fs.writeFile(path.join(game, 'mods', fileName), await neoForgeJar(options));
  }
  return game;
}

test('список модов читает NeoForge-метаданные и переключает jar без удаления', async (t) => {
  const game = await createGame(t, { 'example-1.0.jar': { version: '1.0' } });

  const initial = await listMods(game, { includeIcons: false });
  assert.equal(initial.totalCount, 1);
  assert.equal(initial.enabledCount, 1);
  assert.equal(initial.mods[0].name, 'Example Mod');
  assert.equal(initial.mods[0].modId, 'example_mod');
  assert.equal(initial.mods[0].loader, 'NeoForge');
  assert.equal(initial.mods[0].version, '1.0');

  const disabled = await toggleMod(game, 'example-1.0.jar', false);
  assert.equal(disabled.enabled, false);
  await assert.rejects(fs.access(path.join(game, 'mods', 'example-1.0.jar')));
  await fs.access(path.join(game, 'mods', 'example-1.0.jar.disabled'));

  const registry = await readDisabledRegistry(game);
  assert.equal(registry.entries.length, 1);
  assert.equal(registry.entries[0].modId, 'example_mod');

  const afterDisable = await listMods(game, { includeIcons: false });
  assert.equal(afterDisable.enabledCount, 0);
  assert.equal(afterDisable.disabledCount, 1);
  assert.equal(afterDisable.mods[0].enabled, false);

  const enabled = await toggleMod(game, 'example-1.0.jar.disabled', true);
  assert.equal(enabled.enabled, true);
  await fs.access(path.join(game, 'mods', 'example-1.0.jar'));
  await assert.rejects(fs.access(path.join(game, 'mods', 'example-1.0.jar.disabled')));
  assert.equal((await readDisabledRegistry(game)).entries.length, 0);
});

test('выключенное состояние переносится на новый файл того же modId после обновления', async (t) => {
  const game = await createGame(t, { 'example-1.0.jar': { version: '1.0' } });
  await toggleMod(game, 'example-1.0.jar', false);

  await fs.rm(path.join(game, 'mods', 'example-1.0.jar.disabled'));
  await fs.writeFile(path.join(game, 'mods', 'example-2.0.jar'), await neoForgeJar({ version: '2.0' }));

  const result = await reapplyDisabledMods(game);
  assert.deepEqual(result.reapplied, ['mods/example-2.0.jar']);
  await fs.access(path.join(game, 'mods', 'example-2.0.jar.disabled'));
  await assert.rejects(fs.access(path.join(game, 'mods', 'example-2.0.jar')));
  const registry = await readDisabledRegistry(game);
  assert.equal(registry.entries[0].path, 'mods/example-2.0.jar');
});

test('анализ зависимостей находит прямые и транзитивные зависимые моды', async (t) => {
  const game = await createGame(t, {
    'core.jar': { modId: 'core_mod', name: 'Core Mod' },
    'addon.jar': {
      modId: 'addon_mod',
      name: 'Addon Mod',
      dependencies: [{ modId: 'core_mod' }]
    },
    'integration.jar': {
      modId: 'integration_mod',
      name: 'Integration Mod',
      dependencies: [{ modId: 'addon_mod' }]
    },
    'optional.jar': {
      modId: 'optional_mod',
      name: 'Optional Mod',
      dependencies: [{ modId: 'core_mod', type: 'optional' }]
    }
  });

  const snapshot = await listMods(game, { includeIcons: false });
  const addon = snapshot.mods.find((mod) => mod.modId === 'addon_mod');
  assert.deepEqual(addon.dependencies, ['core_mod']);
  const optional = snapshot.mods.find((mod) => mod.modId === 'optional_mod');
  assert.deepEqual(optional.dependencies, []);

  const analysis = await analyzeModToggle(game, 'core.jar', false);
  assert.equal(analysis.requiresConfirmation, true);
  assert.deepEqual(analysis.directDependents.map((mod) => mod.modId), ['addon_mod']);
  assert.deepEqual(analysis.dependents.map((mod) => mod.modId), ['addon_mod', 'integration_mod']);
  assert.equal(analysis.dependents[1].dependencyDepth, 2);
});

test('каскадное выключение отключает выбранный мод и все зависимые', async (t) => {
  const game = await createGame(t, {
    'core.jar': { modId: 'core_mod', name: 'Core Mod' },
    'addon.jar': { modId: 'addon_mod', name: 'Addon Mod', dependencies: [{ modId: 'core_mod' }] },
    'integration.jar': { modId: 'integration_mod', name: 'Integration Mod', dependencies: [{ modId: 'addon_mod' }] },
    'unrelated.jar': { modId: 'unrelated_mod', name: 'Unrelated Mod' }
  });
  const analysis = await analyzeModToggle(game, 'core.jar', false);
  const fileNames = [
    ...analysis.dependents.slice().reverse().map((mod) => mod.fileName),
    analysis.target.fileName
  ];
  const result = await toggleMods(game, fileNames, false);
  assert.equal(result.results.length, 3);

  const snapshot = await listMods(game, { includeIcons: false });
  assert.equal(snapshot.mods.find((mod) => mod.modId === 'core_mod').enabled, false);
  assert.equal(snapshot.mods.find((mod) => mod.modId === 'addon_mod').enabled, false);
  assert.equal(snapshot.mods.find((mod) => mod.modId === 'integration_mod').enabled, false);
  assert.equal(snapshot.mods.find((mod) => mod.modId === 'unrelated_mod').enabled, true);
});

test('кнопки включить все и выключить все меняют состояние всей папки mods', async (t) => {
  const game = await createGame(t, {
    'first.jar': { modId: 'first_mod', name: 'First Mod' },
    'second.jar': { modId: 'second_mod', name: 'Second Mod' },
    'third.jar': { modId: 'third_mod', name: 'Third Mod' }
  });

  const disabled = await setAllMods(game, false);
  assert.equal(disabled.results.length, 3);
  assert.deepEqual(disabled.summary, { enabledCount: 0, disabledCount: 3, totalCount: 3 });

  const enabled = await setAllMods(game, true);
  assert.equal(enabled.results.length, 3);
  assert.deepEqual(enabled.summary, { enabledCount: 3, disabledCount: 0, totalCount: 3 });
  assert.equal((await readDisabledRegistry(game)).entries.length, 0);
});
