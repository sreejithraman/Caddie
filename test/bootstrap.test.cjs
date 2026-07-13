const assert = require('node:assert/strict');
const { access, cp, mkdir, mkdtemp, readFile, readlink, stat, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

test('bootstrap creates a self-managed User Skills home and shared Claude exposure', async () => {
  const fixture = await bootstrapFixture();
  const { home, configHome, commit } = fixture;
  const result = runBootstrap(fixture);

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
  const selfInspection = spawnSync(
    process.execPath,
    [path.join(userHome, '.agents/skills/caddie/tool/caddie.mjs')],
    {
      cwd: userHome,
      encoding: 'utf8',
      input: JSON.stringify({
        version: 1,
        operation: 'inspect',
        input: { cwd: userHome, configHome, cacheHome: path.join(home, 'cache') },
      }),
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
    },
  );
  assert.equal(selfInspection.status, 0, selfInspection.stderr || selfInspection.stdout);
  const inspected = JSON.parse(selfInspection.stdout);
  assert.equal(inspected.result.availableSkills[0].name, 'caddie');
  assert.equal(inspected.coverage.issues.some((issue) => issue.code === 'git-lock-invalid'), false);
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

test('bootstrap recovers exact partial publication after process termination', async () => {
  const fixture = await bootstrapFixture();
  const interrupted = runBootstrap(fixture, { CADDIE_BOOTSTRAP_CRASH_AFTER: '3' });
  assert.equal(interrupted.status, 97);
  assert.equal(
    await stat(path.join(fixture.configHome, 'caddie', '.bootstrap-journal.json')).then((value) => value.isFile()),
    true,
  );

  const resumed = runBootstrap(fixture);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(
    JSON.parse(await readFile(path.join(fixture.userHome, '.agents', '.caddie', 'ledger.json'), 'utf8')).entries[0].name,
    'caddie',
  );
});

test('a concurrent bootstrap loser preserves the active owner journal', async () => {
  const fixture = await bootstrapFixture();
  const caddieHome = path.join(fixture.configHome, 'caddie');
  await mkdir(caddieHome, { recursive: true });
  const owner = { pid: process.pid, nonce: 'active-owner', acquiredAt: new Date().toISOString() };
  const journal = { version: 2, owner, expected: {} };
  await writeFile(path.join(caddieHome, '.bootstrap.lock'), JSON.stringify(owner));
  await writeFile(path.join(caddieHome, '.bootstrap-journal.json'), JSON.stringify(journal));

  const result = runBootstrap(fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Another bootstrap is active/);
  assert.deepEqual(JSON.parse(await readFile(path.join(caddieHome, '.bootstrap-journal.json'), 'utf8')), journal);
});

test('bootstrap rejects a symlinked state home before writing a lock or journal', async () => {
  const fixture = await bootstrapFixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'caddie-bootstrap-outside-'));
  await mkdir(fixture.configHome, { recursive: true });
  await symlink(outside, path.join(fixture.configHome, 'caddie'));

  const result = runBootstrap(fixture);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /real directory parent/);
  assert.deepEqual(await require('node:fs/promises').readdir(outside), []);
});

test('bootstrap rejects final-component lock and journal symlinks without touching their targets', async () => {
  for (const name of ['.bootstrap.lock', '.bootstrap-journal.json']) {
    const fixture = await bootstrapFixture();
    const caddieHome = path.join(fixture.configHome, 'caddie');
    const outside = path.join(fixture.home, `${name.slice(1)}-outside.json`);
    await mkdir(caddieHome, { recursive: true });
    await writeFile(outside, '{"preserve":true}\n');
    await symlink(outside, path.join(caddieHome, name));

    const result = runBootstrap(fixture);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /real regular file/);
    assert.equal(await readFile(outside, 'utf8'), '{"preserve":true}\n');
  }
});

async function bootstrapFixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-bootstrap-failure-'));
  const configHome = path.join(home, 'config');
  const sourceRoot = path.join(home, 'source');
  await mkdir(path.join(sourceRoot, '.agents', 'skills'), { recursive: true });
  await cp(path.join(repoRoot, '.agents', 'skills', 'caddie'), path.join(sourceRoot, '.agents', 'skills', 'caddie'), { recursive: true });
  runGit(sourceRoot, ['init', '--initial-branch=main']);
  runGit(sourceRoot, ['add', '--all']);
  runGit(sourceRoot, ['-c', 'user.name=Caddie Fixture', '-c', 'user.email=caddie@example.test', 'commit', '-m', 'fixture']);
  const commit = runGit(sourceRoot, ['rev-parse', 'HEAD']).stdout.trim();
  return {
    home,
    configHome,
    sourceRoot,
    userHome: path.join(configHome, 'caddie', 'user'),
    commit,
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
      CADDIE_SOURCE_DIR: fixture.sourceRoot,
      CADDIE_COMMIT: fixture.commit,
      CADDIE_REPOSITORY: fixture.sourceRoot,
      ...extraEnv,
    },
  });
}

function runGit(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
