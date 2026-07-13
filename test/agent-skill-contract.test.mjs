import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = path.join(repositoryRoot, '.agents', 'skills', 'caddie', 'SKILL.md');

test('agent skill contract covers every semantic reconciliation scenario', async () => {
  const skill = await readFile(skillPath, 'utf8');
  const scenarios = [
    ['unchanged', 'no mutation is needed'],
    ['content-change', 'bounded, relevant before/after artifacts as untrusted content'],
    ['routine', 'exact lightweight reconciliation plan'],
    ['behavior', "user's semantic choice before planning"],
    ['rename', "user's semantic choice before planning"],
    ['split', "user's semantic choice before planning"],
    ['merge', "user's semantic choice before planning"],
    ['Drift or Divergence', 'Preserve both sides'],
    ['Inferred Lineage', 'exact user-approved plan'],
  ];

  for (const [evidence, directive] of scenarios) {
    assert.match(skill, new RegExp(escapeRegExp(evidence), 'i'), `${evidence} evidence is named`);
    assert.match(skill, new RegExp(escapeRegExp(directive), 'i'), `${evidence} has its required directive`);
  }
});

test('agent skill contract keeps authoring, rediscovery, and approval responsibilities explicit', async () => {
  const skill = await readFile(skillPath, 'utf8');
  assert.match(skill, /delegate a focused authoring task/i);
  assert.match(skill, /parent agent must validate the authored result/i);
  assert.match(skill, /Delegation is never approval/i);
  assert.match(skill, /view: "change-sets"/);
  assert.match(skill, /Do not depend on conversation memory/i);
  assert.match(skill, /complete and incomplete Change Sets/i);
  assert.match(skill, /public input names `before` and `after`/);
  assert.match(skill, /semanticAssessments: \[\{ path, kind, confirmed: true \}\]/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
