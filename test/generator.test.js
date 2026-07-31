'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('генератор переиспользует неизменившиеся пакеты и выпускает только изменённые корзины', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-generator-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'mods'), { recursive: true });
  await fs.mkdir(path.join(source, 'config'), { recursive: true });
  await fs.writeFile(path.join(source, 'mods', 'large.jar'), Buffer.alloc(1024 * 1024, 7));
  await fs.writeFile(path.join(source, 'config', 'pack.toml'), 'enabled=true\n');
  await fs.writeFile(path.join(source, 'options.txt'), 'lang:ru_ru\n');

  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'tools', 'generate-manifest.mjs')).href;
  const { generateManifest } = await import(moduleUrl);
  const firstOutput = path.join(root, 'manifest-1.json');
  const first = await generateManifest({
    source,
    'base-url': 'https://github.com/example/pack/releases/download/pack-v1.0.0/',
    'pack-version': '1.0.0',
    assets: path.join(root, 'assets-1'),
    output: firstOutput,
    plan: path.join(root, 'plan-1.json'),
    'direct-threshold-mb': '1',
    buckets: '8'
  });
  assert.equal(first.manifest.files.find((entry) => entry.path === 'options.txt').policy, 'seed');
  assert.ok(first.plan.newAssets.length >= 2);

  const secondOutput = path.join(root, 'manifest-2.json');
  const second = await generateManifest({
    source,
    'base-url': 'https://github.com/example/pack/releases/download/pack-v1.0.1/',
    'pack-version': '1.0.1',
    assets: path.join(root, 'assets-2'),
    output: secondOutput,
    plan: path.join(root, 'plan-2.json'),
    previous: firstOutput,
    'direct-threshold-mb': '1',
    buckets: '8'
  });
  assert.equal(second.plan.newAssets.length, 0);
  assert.equal(second.plan.reusedPackages, second.plan.totalPackages);

  await fs.writeFile(path.join(source, 'config', 'pack.toml'), 'enabled=false\n');
  const third = await generateManifest({
    source,
    'base-url': 'https://github.com/example/pack/releases/download/pack-v1.0.2/',
    'pack-version': '1.0.2',
    assets: path.join(root, 'assets-3'),
    output: path.join(root, 'manifest-3.json'),
    plan: path.join(root, 'plan-3.json'),
    previous: secondOutput,
    'direct-threshold-mb': '1',
    buckets: '8'
  });
  assert.equal(third.plan.newAssets.length, 1);
  const largeFile = third.manifest.files.find((entry) => entry.path === 'mods/large.jar');
  const largePackage = third.manifest.packages.find((entry) => entry.id === largeFile.packageId);
  assert.match(largePackage.url, /pack-v1\.0\.0/);
  const configFile = third.manifest.files.find((entry) => entry.path === 'config/pack.toml');
  const configPackage = third.manifest.packages.find((entry) => entry.id === configFile.packageId);
  assert.match(configPackage.url, /pack-v1\.0\.2/);
});
