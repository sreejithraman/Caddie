import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('focused inspection counts relevant findings in other registered projects', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-elsewhere-'));
  const current = path.join(fixture, 'current');
  const other = path.join(fixture, 'other');
  const home = path.join(fixture, 'home');
  await mkdir(current, { recursive: true });
  await mkdir(other, { recursive: true });
  await json(path.join(home, '.agents', '.caddie', 'manifest.json'), { version: 1, scope: 'user', sources: {}, selections: [] });
  await json(path.join(home, '.agents', '.caddie', 'registry.json'), { version: 1, registeredProjects: [current, other] });
  await json(path.join(current, '.agents', '.caddie', 'manifest.json'), { version: 1, scope: 'project', sources: {}, selections: [] });
  await json(path.join(other, '.agents', '.caddie', 'manifest.json'), { version: 999, scope: 'project', sources: {}, selections: [] });

  const envelope = invoke({
    version: 1,
    operation: 'inspect',
    input: { cwd: current, home },
  });

  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.result.elsewhere, {
    registeredProjects: 1,
    projectsWithFindings: 1,
    relevantFindings: 1,
    projects: [{
      root: other,
      findings: [{
        type: 'coverage',
        scope: 'project',
        code: 'unsupported-manifest-version',
        path: path.join(other, '.agents', '.caddie', 'manifest.json'),
        supported: [1],
        received: 999,
      }],
    }],
  });
});

function invoke(request) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot,
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
