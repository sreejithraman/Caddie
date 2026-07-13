import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'bin', 'caddie-tool.mjs');

test('a later public inspection reconstructs an incomplete Change Set from local and PR markers', () => {
  const result = invoke('inspect', {
    view: 'change-sets',
    localChanges: [{
      changeSetId: 'skills-update', changeId: 'consumer', dependencies: ['source'],
      preparation: { kind: 'git', headCommit: 'b'.repeat(40), worktree: '/tmp/consumer' },
    }],
    pullRequests: [{
      url: 'https://github.com/example/source/pull/1', state: 'merged', mergedCommit: 'a'.repeat(40),
      body: '<!-- caddie-change-set:skills-update -->\n<!-- caddie-change:source -->\n<!-- caddie-depends-on: -->',
    }, {
      url: 'https://github.com/example/consumer/pull/2', state: 'open',
      body: 'Context.\n<!-- caddie-change-set:skills-update -->\n<!-- caddie-change:consumer -->\n<!-- caddie-depends-on:source -->',
    }],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.changeSets[0].status, 'incomplete');
  assert.deepEqual(result.result.changeSets[0].remainingChanges, ['consumer']);
  assert.equal(result.result.changeSets[0].changes.find(({ id }) => id === 'source').pullRequest.mergedCommit, 'a'.repeat(40));
  assert.equal(result.result.changeSets[0].changes.find(({ id }) => id === 'consumer').local, true);
  assert.equal(result.coverage.status, 'complete');
});

test('malformed Caddie markers produce explicit partial coverage', () => {
  const result = invoke('inspect', {
    view: 'change-sets',
    pullRequests: [{ url: 'https://example.test/pr', body: '<!-- caddie-change-set:broken -->' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.issues[0].code, 'invalid-pull-request-markers');
});

test('dependency-only Change Set evidence remains visible as an incomplete placeholder', () => {
  const response = invoke('inspect', {
      view: 'change-sets',
      localChanges: [],
      pullRequests: [{
        url: 'https://example.test/consumer/1',
        state: 'open',
        body: '<!-- caddie-change-set:dependency-set -->\n<!-- caddie-change:consumer -->\n<!-- caddie-depends-on:source -->',
      }],
  });

  assert.equal(response.ok, true);
  assert.deepEqual(response.result.changeSets[0].changes.map(({ id, referencedOnly }) => [id, referencedOnly]), [
    ['consumer', false],
    ['source', true],
  ]);
  assert.deepEqual(response.result.changeSets[0].remainingChanges, ['consumer', 'source']);
});

function invoke(operation, input) {
  const result = spawnSync(process.execPath, [tool], {
    cwd: root, encoding: 'utf8', input: JSON.stringify({ version: 1, operation, input }),
  });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}
