const assert = require('node:assert/strict');
const { access, mkdir, mkdtemp, readFile, readlink, stat, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

test('bootstrap creates a self-managed User Skills home and shared Claude exposure', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-bootstrap-'));
  const configHome = path.join(home, 'config');
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const result = spawnSync('sh', [path.join(repoRoot, 'scripts/bootstrap.sh')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      CADDIE_SOURCE_DIR: repoRoot,
      CADDIE_COMMIT: commit,
      CADDIE_REPOSITORY: 'https://example.test/caddie.git',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const userHome = path.join(configHome, 'caddie', 'user');
  const manifest = JSON.parse(await readFile(path.join(userHome, 'caddie.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(userHome, 'caddie.lock'), 'utf8'));
  const ledger = JSON.parse(
    await readFile(path.join(userHome, '.agents/.caddie/ledger.json'), 'utf8'),
  );

  assert.equal(manifest.scope, 'user');
  assert.equal(manifest.sources.caddie.type, 'git');
  assert.equal(lock.sources.caddie.commit, commit);
  assert.deepEqual(Object.keys(ledger), ['version', 'scopeId', 'entries']);
  assert.equal(ledger.scopeId, 'user');
  assert.equal(ledger.entries[0].source, 'caddie');
  assert.equal(ledger.entries[0].fingerprint.algorithm, 'sha256-tree-v1');
  assert.equal(ledger.entries[0].fingerprint.complete, true);
  const { fingerprintDirectory } = await import('../.agents/skills/caddie/tool/src/fingerprint/index.mjs');
  const installedFingerprint = await fingerprintDirectory(path.join(userHome, '.agents/skills/caddie'));
  assert.equal(ledger.entries[0].fingerprint.digest, installedFingerprint.digest);
  assert.equal(
    await readlink(path.join(userHome, '.claude/skills')),
    '../.agents/skills',
  );
  assert.equal(
    (await stat(path.join(userHome, '.agents/skills/caddie/SKILL.md'))).isFile(),
    true,
  );
  const installedTool = spawnSync(
    process.execPath,
    [path.join(userHome, '.agents/skills/caddie/tool/caddie.mjs')],
    {
      cwd: userHome,
      encoding: 'utf8',
      input: JSON.stringify({ version: 1, operation: 'locate', input: { cwd: userHome, configHome } }),
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
    },
  );
  assert.equal(installedTool.status, 0, installedTool.stderr);
  assert.equal(JSON.parse(installedTool.stdout).ok, true);
});

test('bootstrap preflights every destination before mutating user state', async () => {
  const fixture = await bootstrapFixture();
  const exposure = path.join(fixture.userHome, '.claude', 'skills');
  await mkdir(path.dirname(exposure), { recursive: true });
  await symlink('../existing-skills', exposure);

  const result = runBootstrap(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /preserves existing state/);
  await assert.rejects(access(path.join(fixture.userHome, 'caddie.json')));
  await assert.rejects(access(path.join(fixture.userHome, '.agents', 'skills', 'caddie')));
  assert.equal(await readlink(exposure), '../existing-skills');
});

test('bootstrap rolls back every published artifact after an interrupted atomic publication', async () => {
  for (const failAfter of [1, 3, 6]) {
    const fixture = await bootstrapFixture();
    const result = runBootstrap(fixture, { CADDIE_BOOTSTRAP_FAIL_AFTER: String(failAfter) });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Injected bootstrap failure/);
    for (const candidate of [
      path.join(fixture.userHome, 'caddie.json'),
      path.join(fixture.userHome, 'caddie.lock'),
      path.join(fixture.userHome, '.agents', 'skills', 'caddie'),
      path.join(fixture.userHome, '.claude', 'skills'),
      path.join(fixture.userHome, '.agents', '.caddie', 'ledger.json'),
      path.join(fixture.configHome, 'caddie', 'config.json'),
    ]) await assert.rejects(access(candidate));
  }
});

async function bootstrapFixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-bootstrap-failure-'));
  const configHome = path.join(home, 'config');
  return {
    home,
    configHome,
    userHome: path.join(configHome, 'caddie', 'user'),
    commit: '0123456789abcdef0123456789abcdef01234567',
  };
}

function runBootstrap(fixture, extraEnv = {}) {
  return spawnSync('sh', [path.join(repoRoot, 'scripts/bootstrap.sh')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture.home,
      XDG_CONFIG_HOME: fixture.configHome,
      CADDIE_SOURCE_DIR: repoRoot,
      CADDIE_COMMIT: fixture.commit,
      CADDIE_REPOSITORY: 'https://example.test/caddie.git',
      ...extraEnv,
    },
  });
}
