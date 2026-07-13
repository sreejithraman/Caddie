const assert = require('node:assert/strict');
const { cp, mkdtemp, mkdir, rm, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

test('installed Claude Code discovers a skill exposed by an individual directory symlink', async (t) => {
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') {
    if (process.env.CADDIE_REQUIRE_CLAUDE === '1') assert.fail('Claude Code is required by the release gate');
    t.skip('Claude Code is not installed');
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);

  const home = await mkdtemp(path.join(tmpdir(), 'caddie-claude-harness-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const args = [
    '-p', '--no-session-persistence', '--tools', '', '--max-budget-usd', '0.000001',
    '/caddie Reply with only caddie.',
  ];
  const control = spawnSync('claude', args, { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.match(`${control.stdout}${control.stderr}`, /Unknown command:\s*\/caddie/);

  const exposure = path.join(home, '.claude', 'skills', 'caddie');
  await mkdir(path.dirname(exposure), { recursive: true });
  await symlink(path.join(repoRoot, '.agents', 'skills', 'caddie'), exposure, 'dir');

  const result = spawnSync('claude', args, { encoding: 'utf8', env: { ...process.env, HOME: home } });
  const output = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(output, /Unknown command:\s*\/caddie/);
});

test('installed Codex discovers a real skill in the standard user root', async (t) => {
  const probe = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') {
    if (process.env.CADDIE_REQUIRE_CODEX === '1') assert.fail('Codex is required by the release gate');
    t.skip('Codex is not installed');
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);

  const home = await mkdtemp(path.join(tmpdir(), 'caddie-codex-harness-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home };
  const args = ['debug', 'prompt-input', 'Use caddie.'];
  const control = spawnSync('codex', args, { cwd: home, encoding: 'utf8', env });
  assert.equal(control.status, 0, control.stderr);
  assert.doesNotMatch(control.stdout, /- caddie:/);

  const exposure = path.join(home, '.agents', 'skills', 'caddie');
  await mkdir(path.dirname(exposure), { recursive: true });
  await cp(path.join(repoRoot, '.agents', 'skills', 'caddie'), exposure, { recursive: true });

  const result = spawnSync('codex', args, { cwd: home, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- caddie:/);
  assert.match(result.stdout, /\.agents\/skills\/caddie\/SKILL\.md/);
});
