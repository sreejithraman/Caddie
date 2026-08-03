import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Homebrew Cask uses one auto-updating app and zap never names Caddie State', async () => {
  const cask = await readFile('packaging/homebrew/Caddie.rb.template', 'utf8');
  assert.match(cask, /auto_updates true/);
  assert.match(cask, /app "Caddie\.app"/);
  assert.doesNotMatch(cask, /Application Support\/Caddie/);
  assert.doesNotMatch(cask, /\.agents/);
  assert.doesNotMatch(cask, /(?:^|\/)\.caddie(?:\/|"|$)/m);
});

test('Cask renderer binds the exact disk image digest and GitHub Release URL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'caddie-cask-'));
  try {
    const dmg = path.join(root, 'Caddie.dmg');
    const output = path.join(root, 'Caddie.rb');
    await writeFile(dmg, 'same signed release bytes');
    const result = spawnSync(process.execPath, [
      'scripts/render-caddie-cask.mjs', '1.2.3', dmg,
      'https://github.com/sreejithraman/Caddie/releases/download/v1.2.3/Caddie-1.2.3.dmg', output,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const cask = await readFile(output, 'utf8');
    assert.match(cask, /version "1\.2\.3"/);
    assert.match(cask, /sha256 "[a-f0-9]{64}"/);
    assert.match(cask, /releases\/download\/v1\.2\.3\/Caddie-1\.2\.3\.dmg/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Cask renderer rejects every non-canonical release URL and version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'caddie-cask-invalid-'));
  try {
    const dmg = path.join(root, 'Caddie.dmg');
    await writeFile(dmg, 'release bytes');
    const invalid = [
      ['1.2.3', 'https://user@github.com/sreejithraman/Caddie/releases/download/v1.2.3/Caddie-1.2.3.dmg'],
      ['1.2.3', 'https://github.com/sreejithraman/Caddie/releases/download/v1.2.3/Caddie-1.2.3.dmg?x=1'],
      ['1.2.3', 'https://github.com/sreejithraman/Caddie/releases/download/v1.2.3/Caddie-1.2.3.dmg#x'],
      ['1.2.3', 'https://github.com/other/Caddie/releases/download/v1.2.3/Caddie-1.2.3.dmg'],
      ['1.2.3', 'https://github.com/sreejithraman/Caddie/releases/download/v9.9.9/Caddie-1.2.3.dmg'],
      ['01.2.3', 'https://github.com/sreejithraman/Caddie/releases/download/v01.2.3/Caddie-01.2.3.dmg'],
      ['1.2.3\nname', 'https://github.com/sreejithraman/Caddie/releases/download/v1.2.3/Caddie-1.2.3.dmg'],
    ];
    for (const [version, url] of invalid) {
      const result = spawnSync(process.execPath, [
        'scripts/render-caddie-cask.mjs', version, dmg, url, path.join(root, `${Math.random()}.rb`),
      ], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, `${version} ${url}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mac app build has separate local and signed release modes', async () => {
  const build = await readFile('scripts/build-caddie-menu-app.sh', 'utf8');
  assert.match(build, /--development/);
  assert.match(build, /app\.caddie\.CaddieMenuApp\.dev/);
  assert.match(build, /--release/);
  assert.match(build, /CADDIE_CODE_SIGN_IDENTITY/);
  assert.match(build, /CADDIE_APP_VERSION/);
  assert.match(build, /CADDIE_BUILD_NUMBER/);
  assert.match(build, /Set :CFBundleShortVersionString/);
  assert.match(build, /Set :CFBundleVersion/);
  assert.match(build, /bundle_stage=\$\(mktemp -d/);
  assert.match(build, /rm -rf -- "\$final_app_path"/);
  assert.match(build, /mv "\$app_path" "\$final_app_path"/);
  assert.match(build, /codesign --force --options runtime --timestamp/);
  assert.ok(build.indexOf('Set :CFBundleShortVersionString') < build.indexOf('codesign --force --options runtime'));
  assert.ok(build.indexOf('Set :CFBundleVersion') < build.indexOf('codesign --force --options runtime'));
});

test('release build rejects malformed bundle versions before building or signing', () => {
  const invalid = [
    ['01.2.3', '4'],
    ['1.2', '4'],
    ['1.2.3', '0'],
    ['1.2.3', '4; touch /tmp/no'],
  ];
  for (const [version, build] of invalid) {
    const result = spawnSync('scripts/build-caddie-menu-app.sh', ['--release'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CADDIE_CODE_SIGN_IDENTITY: '-',
        CADDIE_APP_VERSION: version,
        CADDIE_BUILD_NUMBER: build,
      },
    });
    assert.equal(result.status, 2, `${version} ${build}\n${result.stderr}`);
  }
});

test('Mac app rebuild cannot keep a stale bundle file', { skip: process.platform !== 'darwin' }, async () => {
  let result = spawnSync('scripts/build-caddie-menu-app.sh', ['--development'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const marker = 'app/CaddieReleaseRuntime/.build/Caddie.app/Contents/stale-marker';
  await writeFile(marker, 'must not survive');
  result = spawnSync('scripts/build-caddie-menu-app.sh', ['--development'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('dry-run disk image packaging refuses overwrite and has one Applications target', async () => {
  const pack = await readFile('scripts/package-caddie-dry-run.sh', 'utf8');
  assert.match(pack, /\[\[ ! -e "\$output_path" \]\]/);
  assert.match(pack, /ditto "\$app_path" "\$stage\/Caddie\.app"/);
  assert.match(pack, /ln -s \/Applications "\$stage\/Applications"/);
  assert.match(pack, /hdiutil create/);
  assert.match(pack, /CFBundleShortVersionString/);
  assert.match(pack, /does not match package version/);
  assert.doesNotMatch(pack, /notarytool|stapler|gh release/);
});

test('dry-run packaging rejects a bundle and file version mismatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'caddie-package-version-'));
  try {
    const app = path.join(root, 'Caddie.app');
    const contents = path.join(app, 'Contents');
    const output = path.join(root, 'output');
    await mkdir(contents, { recursive: true });
    await mkdir(output);
    await writeFile(path.join(contents, 'Info.plist'), await readFile('app/CaddieReleaseRuntime/CaddieMenuApp-Info.plist'));
    const result = spawnSync('scripts/package-caddie-dry-run.sh', [app, '1.2.3', output], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /version 0\.1\.0 does not match package version 1\.2\.3/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
