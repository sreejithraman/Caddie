import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyFingerprints,
  fingerprintDirectory,
} from '../.agents/skills/caddie/tool/src/fingerprint/index.mjs';

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-fingerprint-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

test('fingerprintDirectory is content based and independent of absolute location', async () => {
  const one = await fixture({ 'SKILL.md': '# One\n', 'scripts/run.js': 'ok\n' });
  const two = await fixture({ 'SKILL.md': '# One\n', 'scripts/run.js': 'ok\n' });

  const a = await fingerprintDirectory(one);
  const b = await fingerprintDirectory(two);

  assert.equal(a.algorithm, 'sha256-tree-v1');
  assert.equal(a.digest, b.digest);
  assert.equal(a.complete, true);
  assert.equal(a.fileCount, 2);
  assert.equal(JSON.stringify(a).includes(one), false);
});

test('classifyFingerprints distinguishes all reconciled states', () => {
  const fp = (digest, complete = true) => ({ digest, complete });
  const previous = fp('base');

  assert.equal(classifyFingerprints({ lastReconciled: previous, source: fp('base'), installation: fp('base') }).kind, 'unchanged');
  assert.equal(classifyFingerprints({ lastReconciled: previous, source: fp('new'), installation: fp('base') }).kind, 'upstream-change');
  assert.equal(classifyFingerprints({ lastReconciled: previous, source: fp('base'), installation: fp('local') }).kind, 'drift');
  assert.equal(classifyFingerprints({ lastReconciled: previous, source: fp('new'), installation: fp('local') }).kind, 'divergence');
});

test('classification exposes missing and partial evidence instead of guessing', () => {
  const result = classifyFingerprints({
    lastReconciled: { digest: 'base', complete: true },
    source: { digest: null, complete: false, findings: [{ code: 'permission-denied' }] },
    installation: null,
  });

  assert.equal(result.kind, 'insufficient-evidence');
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.missing, ['installation']);
  assert.deepEqual(result.coverage.partial, ['source']);
});
