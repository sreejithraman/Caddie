const assert = require('node:assert/strict');
const { mkdtemp, readFile, readlink, stat } = require('node:fs/promises');
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
  assert.equal(ledger.materialized.caddie.source, 'caddie');
  assert.equal(
    await readlink(path.join(userHome, '.claude/skills')),
    '../.agents/skills',
  );
  assert.equal(
    (await stat(path.join(userHome, '.agents/skills/caddie/SKILL.md'))).isFile(),
    true,
  );
});
