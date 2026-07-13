import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('missing Git executable yields labeled partial evidence through the public contract', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-missing-git-'));
  const emptyPath = path.join(root, 'empty-path');
  await mkdir(emptyPath);
  const result = spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot,
    input: JSON.stringify({
      version: 1,
      operation: 'inspect-source',
      input: {
        type: 'git', sourceId: 'upstream', url: path.join(root, 'source.git'),
        commit: 'a'.repeat(40), selectionPath: 'skills/example', cacheDir: path.join(root, 'cache'),
      },
    }),
    encoding: 'utf8',
    env: { ...process.env, PATH: emptyPath },
  });

  assert.equal(result.stderr, '');
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.resolution.freshness, 'unavailable');
  assert.equal(response.coverage.status, 'partial');
  assert.equal(response.coverage.reason, 'exact-commit-unavailable');
  assert.equal(response.result.findings[0].code, 'exact-commit-unavailable');
});
