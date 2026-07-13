const assert = require('node:assert/strict');
const { access, cp, mkdir, mkdtemp, readFile, readlink, realpath, rename, stat, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

test('bootstrap installs Caddie, its state, and Claude compatibility under the user home', async () => {
  const fixture = await bootstrapFixture();
  const result = runBootstrap(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fixture.home);

  const stateRoot = path.join(fixture.home, '.agents', '.caddie');
  const manifest = JSON.parse(await readFile(path.join(stateRoot, 'manifest.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(stateRoot, 'lock.json'), 'utf8'));
  const ledger = JSON.parse(await readFile(path.join(stateRoot, 'ledger.json'), 'utf8'));
  const registry = JSON.parse(await readFile(path.join(stateRoot, 'registry.json'), 'utf8'));
  const canonical = path.join(fixture.home, '.agents', 'skills', 'caddie');
  const exposure = path.join(fixture.home, '.claude', 'skills', 'caddie');

  assert.equal(manifest.scope, 'user');
  assert.deepEqual(manifest.selections, [{ source: 'caddie', path: 'skills/caddie' }]);
  assert.equal(lock.sources.caddie.commit, fixture.commit);
  assert.deepEqual(registry, { version: 1, registeredProjects: [] });
  assert.equal(ledger.scopeId, 'user');
  assert.equal(ledger.entries[0].path, canonical);
  assert.deepEqual(ledger.harnessLinks, [exposure]);
  assert.equal(await realpath(exposure), await realpath(canonical));
  assert.equal(await readlink(exposure), path.relative(path.dirname(exposure), canonical));

  const installed = invoke(path.join(canonical, 'tool', 'caddie.mjs'), 'inspect', {
    cwd: fixture.home,
    cacheHome: path.join(fixture.home, 'cache'),
  }, fixture);
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.deepEqual(installed.result.availableSkills.map(({ name }) => name), ['caddie']);
});

test('bootstrap preflights every destination before publishing anything', async () => {
  const fixture = await bootstrapFixture();
  const exposure = path.join(fixture.home, '.claude', 'skills', 'caddie');
  await mkdir(path.dirname(exposure), { recursive: true });
  await symlink('../existing-skills', exposure);

  const result = runBootstrap(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /preserves existing state/);
  await assert.rejects(access(path.join(fixture.home, '.agents', '.caddie', 'manifest.json')));
  await assert.rejects(access(path.join(fixture.home, '.agents', 'skills', 'caddie')));
  assert.equal(await readlink(exposure), '../existing-skills');
});

test('bootstrap rolls back every published artifact after a handled interruption', async () => {
  const fixture = await bootstrapFixture();
  const result = runBootstrap(fixture, { CADDIE_BOOTSTRAP_FAIL_AFTER: '3' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Injected bootstrap failure/);
  for (const candidate of artifactPaths(fixture)) await assert.rejects(access(candidate));
});

test('bootstrap resumes exact partial publication after process termination', async () => {
  const fixture = await bootstrapFixture();
  const interrupted = runBootstrap(fixture, { CADDIE_BOOTSTRAP_CRASH_AFTER: '3' });
  assert.equal(interrupted.status, 97, interrupted.stderr);
  assert.equal((await stat(path.join(fixture.home, '.agents', '.caddie', '.bootstrap-journal.json'))).isFile(), true);

  const resumed = runBootstrap(fixture);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(await readFile(path.join(fixture.home, '.agents', '.caddie', 'ledger.json'), 'utf8')).entries[0].name, 'caddie');
});

test('bootstrap refuses a state ancestor replaced by a symlink during recovery', async () => {
  const fixture = await bootstrapFixture();
  const interrupted = runBootstrap(fixture, { CADDIE_BOOTSTRAP_CRASH_AFTER: '3' });
  assert.equal(interrupted.status, 97, interrupted.stderr);
  const agents = path.join(fixture.home, '.agents');
  const displaced = path.join(fixture.home, 'displaced-agents');
  await rename(agents, displaced);
  await symlink(displaced, agents, 'dir');

  const resumed = runBootstrap(fixture);
  assert.equal(resumed.status, 2);
  assert.match(resumed.stderr, /real directory parent/);
  assert.equal((await stat(path.join(displaced, 'skills', 'caddie'))).isDirectory(), true);
});

async function bootstrapFixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-bootstrap-'));
  const configHome = path.join(home, 'config');
  const sourceRoot = path.join(home, 'source');
  await mkdir(path.join(sourceRoot, 'skills'), { recursive: true });
  await cp(path.join(repoRoot, 'skills', 'caddie'), path.join(sourceRoot, 'skills', 'caddie'), { recursive: true });
  runGit(sourceRoot, ['init', '--initial-branch=main']);
  runGit(sourceRoot, ['add', '--all']);
  runGit(sourceRoot, ['-c', 'user.name=Caddie Fixture', '-c', 'user.email=caddie@example.test', 'commit', '-m', 'fixture']);
  const commit = runGit(sourceRoot, ['rev-parse', 'HEAD']).stdout.trim();
  return { home, configHome, sourceRoot, commit };
}

function runBootstrap(fixture, extraEnv = {}) {
  return spawnSync('sh', [path.join(repoRoot, 'scripts', 'bootstrap.sh')], {
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

function invoke(tool, operation, input, fixture) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: fixture.home,
    encoding: 'utf8',
    input: JSON.stringify({ version: 1, operation, input }),
    env: { ...process.env, HOME: fixture.home, XDG_CONFIG_HOME: fixture.configHome },
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function artifactPaths(fixture) {
  const state = path.join(fixture.home, '.agents', '.caddie');
  return [
    path.join(fixture.home, '.agents', 'skills', 'caddie'),
    path.join(fixture.home, '.claude', 'skills', 'caddie'),
    path.join(state, 'manifest.json'),
    path.join(state, 'lock.json'),
    path.join(state, 'ledger.json'),
    path.join(state, 'registry.json'),
  ];
}

function runGit(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
