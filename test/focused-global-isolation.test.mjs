import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('a broken unrelated registered project cannot veto focused inspection', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-focused-isolation-'));
  const current = path.join(fixture, 'current');
  const broken = path.join(fixture, 'broken');
  const configHome = path.join(fixture, 'config');
  const userManifest = path.join(fixture, 'user', 'caddie.json');
  await mkdir(current, { recursive: true });
  await mkdir(broken, { recursive: true });
  await json(userManifest, { version: 1, scope: 'user', sources: {}, selections: [] });
  await json(path.join(current, 'caddie.json'), { version: 1, scope: 'project', sources: {}, selections: [] });
  await writeFile(path.join(broken, 'caddie.json'), '{not json\n');
  await json(path.join(configHome, 'caddie', 'config.json'), {
    version: 1, userManifest, registeredProjects: [current, broken],
  });

  const response = invoke({ version: 1, operation: 'inspect', input: { cwd: current, configHome } });
  assert.equal(response.ok, true);
  assert.equal(response.result.scopes.project.status, 'inspected');
  assert.deepEqual(response.result.elsewhere.projects, [{
    root: broken,
    findings: [{ type: 'coverage', scope: 'project', code: 'invalid-manifest-json', disposition: 'invalid' }],
  }]);
});

function invoke(request) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot, input: JSON.stringify(request), encoding: 'utf8',
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
