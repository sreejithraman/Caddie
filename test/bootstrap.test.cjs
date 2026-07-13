const assert = require('node:assert/strict');
const { access, cp, mkdir, mkdtemp, readFile, readlink, realpath, stat, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

test('bootstrap installs Caddie in the standard user root with Claude compatibility', async () => {
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
  assert.deepEqual(Object.keys(ledger), ['version', 'scopeId', 'harnessLinks', 'entries']);
  assert.equal(ledger.scopeId, 'user');
  assert.equal(ledger.entries[0].source, 'caddie');
  assert.equal(typeof ledger.entries[0].fingerprint, 'string');
  const { fingerprintDirectory } = await import('../.agents/skills/caddie/tool/src/fingerprint/index.mjs');
  const canonical = path.join(home, '.agents/skills/caddie');
  const installedFingerprint = await fingerprintDirectory(canonical);
  assert.equal(ledger.entries[0].fingerprint, installedFingerprint.digest);
  assert.deepEqual(ledger.harnessLinks, [path.join(home, '.claude/skills/caddie')]);
  assert.equal(ledger.entries[0].path, canonical);
  assert.equal(
    await readlink(path.join(home, '.claude/skills/caddie')),
    path.relative(path.join(home, '.claude', 'skills'), canonical),
  );
  assert.equal(
    (await stat(path.join(canonical, 'SKILL.md'))).isFile(),
    true,
  );
  assert.equal((await stat(canonical)).isDirectory(), true);
  const installedTool = spawnSync(
    process.execPath,
    [path.join(canonical, 'tool/caddie.mjs')],
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
    [path.join(canonical, 'tool/caddie.mjs')],
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

  const installedToolPath = path.join(canonical, 'tool/caddie.mjs');
  const ledgerPath = path.join(userHome, '.agents/.caddie/ledger.json');
  const { fingerprint } = require('../.agents/skills/caddie/tool/src/apply/filesystem');
  const planned = spawnSync(process.execPath, [installedToolPath], {
    cwd: userHome,
    encoding: 'utf8',
    input: JSON.stringify({
      version: 1,
      operation: 'plan',
      input: {
        kind: 'reconcile',
        scope: { id: 'user', root: userHome },
        operations: [
          {
            type: 'materialize-skill',
            name: 'caddie',
            sourcePath: path.join(fixture.sourceRoot, '.agents/skills/caddie'),
            destinationPath: canonical,
            sourceFingerprint: installedFingerprint.digest,
            expectedDestination: { state: 'fingerprint', fingerprint: installedFingerprint.digest },
          },
          {
            type: 'write-ledger',
            path: ledgerPath,
            content: await readFile(ledgerPath, 'utf8'),
            expected: { state: 'file', fingerprint: await fingerprint(ledgerPath) },
          },
        ],
      },
    }),
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
  });
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  const planEnvelope = JSON.parse(planned.stdout);
  assert.equal(planEnvelope.ok, true, planned.stdout);
  const applied = spawnSync(process.execPath, [installedToolPath], {
    cwd: userHome,
    encoding: 'utf8',
    input: JSON.stringify({
      version: 1,
      operation: 'apply-plan',
      input: {
        plan: planEnvelope.result.plan,
        approval: { version: 1, planId: planEnvelope.result.plan.id, approval: 'explicit' },
      },
    }),
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
  });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(JSON.parse(applied.stdout).result.status, 'applied');
});

test('bootstrap migrates the exact legacy Caddie layout without touching unrelated skills', async () => {
  const fixture = await bootstrapFixture();
  await installLegacyBootstrap(fixture);
  const unrelated = path.join(fixture.home, '.agents', 'skills', 'mine');
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, 'SKILL.md'), '---\nname: mine\ndescription: Mine.\n---\n');

  const result = runBootstrap(fixture);
  assert.equal(result.status, 0, result.stderr);

  const canonical = path.join(fixture.home, '.agents', 'skills', 'caddie');
  assert.equal((await stat(canonical)).isDirectory(), true);
  assert.equal((await stat(canonical)).isSymbolicLink(), false);
  assert.equal(await realpath(path.join(fixture.home, '.claude', 'skills', 'caddie')), await realpath(canonical));
  await assert.rejects(access(path.join(fixture.userHome, '.agents', 'skills', 'caddie')));
  assert.match(await readFile(path.join(unrelated, 'SKILL.md'), 'utf8'), /name: mine/);
  const ledger = JSON.parse(await readFile(path.join(fixture.userHome, '.agents', '.caddie', 'ledger.json'), 'utf8'));
  assert.deepEqual(ledger.harnessLinks, [path.join(fixture.home, '.claude', 'skills', 'caddie')]);
  assert.equal(ledger.entries[0].path, canonical);
});

test('legacy migration recovers after process termination and resumes exactly', async () => {
  const fixture = await bootstrapFixture();
  await installLegacyBootstrap(fixture);

  const interrupted = runBootstrap(fixture, { CADDIE_BOOTSTRAP_CRASH_AFTER: '3' });
  assert.equal(interrupted.status, 97, interrupted.stderr);
  const resumed = runBootstrap(fixture);
  assert.equal(resumed.status, 0, resumed.stderr);

  const canonical = path.join(fixture.home, '.agents', 'skills', 'caddie');
  assert.equal((await stat(canonical)).isDirectory(), true);
  assert.equal((await stat(canonical)).isSymbolicLink(), false);
  assert.equal(await realpath(path.join(fixture.home, '.claude', 'skills', 'caddie')), await realpath(canonical));
  await assert.rejects(access(path.join(fixture.configHome, 'caddie', '.bootstrap-journal.json')));
});

test('bootstrap preflights every destination before mutating user state', async () => {
  const fixture = await bootstrapFixture();
  const exposure = path.join(fixture.home, '.claude', 'skills', 'caddie');
  await mkdir(path.dirname(exposure), { recursive: true });
  await symlink('../existing-skills', exposure);

  const result = runBootstrap(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /preserves existing state/);
  await assert.rejects(access(path.join(fixture.userHome, 'caddie.json')));
  await assert.rejects(access(path.join(fixture.home, '.agents', 'skills', 'caddie')));
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
      path.join(fixture.home, '.agents', 'skills', 'caddie'),
      path.join(fixture.home, '.claude', 'skills', 'caddie'),
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

async function installLegacyBootstrap(fixture) {
  const legacy = path.join(fixture.userHome, '.agents', 'skills', 'caddie');
  const codex = path.join(fixture.home, '.agents', 'skills', 'caddie');
  const claude = path.join(fixture.home, '.claude', 'skills', 'caddie');
  await cp(path.join(fixture.sourceRoot, '.agents', 'skills', 'caddie'), legacy, { recursive: true });
  await mkdir(path.dirname(codex), { recursive: true });
  await mkdir(path.dirname(claude), { recursive: true });
  await symlink(path.relative(path.dirname(codex), legacy), codex, 'dir');
  await symlink(path.relative(path.dirname(claude), legacy), claude, 'dir');
  const { fingerprintDirectory } = await import('../.agents/skills/caddie/tool/src/fingerprint/index.mjs');
  const fingerprint = (await fingerprintDirectory(legacy)).digest;
  await writeFile(path.join(fixture.userHome, 'caddie.json'), `${JSON.stringify({
    version: 1, scope: 'user', sources: { caddie: { type: 'git', url: fixture.sourceRoot, ref: fixture.commit } },
    selections: [{ source: 'caddie', path: '.agents/skills/caddie' }],
  }, null, 2)}\n`);
  await writeFile(path.join(fixture.userHome, 'caddie.lock'), `${JSON.stringify({
    version: 1, sources: { caddie: { type: 'git', url: fixture.sourceRoot, commit: fixture.commit } },
  }, null, 2)}\n`);
  await mkdir(path.join(fixture.userHome, '.agents', '.caddie'), { recursive: true });
  await writeFile(path.join(fixture.userHome, '.agents', '.caddie', 'ledger.json'), `${JSON.stringify({
    version: 1, scopeId: 'user', harnessLinks: [codex, claude],
    entries: [{ name: 'caddie', path: legacy, source: 'caddie', selectedPath: '.agents/skills/caddie', fingerprint }],
  }, null, 2)}\n`);
  await writeFile(path.join(fixture.configHome, 'caddie', 'config.json'), `${JSON.stringify({
    version: 1, userManifest: path.join(fixture.userHome, 'caddie.json'), registeredProjects: [],
  }, null, 2)}\n`);
}

function runGit(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
