'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');
const {
  listMods,
  toggleMod,
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

async function exampleJar(version) {
  return createJar({
    'META-INF/neoforge.mods.toml': `modLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n[[mods]]\nmodId="example_mod"\nversion="${version}"\ndisplayName="Example Mod"\ndescription='''Тестовый мод'''\n`,
    'META-INF/MANIFEST.MF': `Manifest-Version: 1.0\nImplementation-Version: ${version}\n`
  });
}

test('список модов читает NeoForge-метаданные и переключает jar без удаления', async (t) => {
  const game = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-mod-manager-'));
  t.after(() => fs.rm(game, { recursive: true, force: true }));
  await fs.mkdir(path.join(game, 'mods'), { recursive: true });
  await fs.writeFile(path.join(game, 'mods', 'example-1.0.jar'), await exampleJar('1.0'));

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
  const game = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-mod-reapply-'));
  t.after(() => fs.rm(game, { recursive: true, force: true }));
  await fs.mkdir(path.join(game, 'mods'), { recursive: true });
  await fs.writeFile(path.join(game, 'mods', 'example-1.0.jar'), await exampleJar('1.0'));
  await toggleMod(game, 'example-1.0.jar', false);

  await fs.rm(path.join(game, 'mods', 'example-1.0.jar.disabled'));
  await fs.writeFile(path.join(game, 'mods', 'example-2.0.jar'), await exampleJar('2.0'));

  const result = await reapplyDisabledMods(game);
  assert.deepEqual(result.reapplied, ['mods/example-2.0.jar']);
  await fs.access(path.join(game, 'mods', 'example-2.0.jar.disabled'));
  await assert.rejects(fs.access(path.join(game, 'mods', 'example-2.0.jar')));
  const registry = await readDisabledRegistry(game);
  assert.equal(registry.entries[0].path, 'mods/example-2.0.jar');
});
