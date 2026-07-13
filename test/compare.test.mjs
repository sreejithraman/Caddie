import assert from 'node:assert/strict';
import test from 'node:test';

import { compareSkillEvidence } from '../.agents/skills/caddie/tool/src/compare/index.mjs';

function skill(name, path, digest, files = []) {
  return { name, path, fingerprint: { digest, complete: true }, files };
}

test('same-path byte changes remain evidence until semantic behavior is assessed', () => {
  const result = compareSkillEvidence({
    before: [skill('alpha', 'skills/alpha', 'old')],
    after: [skill('alpha', 'skills/alpha', 'new')],
  });

  assert.equal(result.candidates[0].kind, 'content-change');
  assert.equal(result.candidates[0].semanticCertainty, 'undetermined');
  assert.equal(result.candidates[0].requiresUserChoice, true);
  assert.deepEqual(result.candidates[0].alternatives, [
    'confirm-routine-content-update', 'treat-as-behavior-change', 'defer',
  ]);
});

test('confirmed semantic assessments distinguish routine updates from behavior migrations', () => {
  const before = [skill('alpha', 'skills/alpha', 'old')];
  const after = [skill('alpha', 'skills/alpha', 'new')];
  const routine = compareSkillEvidence({
    before,
    after,
    semanticAssessments: [{ path: 'skills/alpha', kind: 'routine-content-update', confirmed: true }],
  });
  const behavior = compareSkillEvidence({
    before,
    after,
    semanticAssessments: [{ path: 'skills/alpha', kind: 'behavior-change', confirmed: true }],
  });

  assert.deepEqual(routine.candidates[0], {
    kind: 'content-update',
    before: { name: 'alpha', path: 'skills/alpha' },
    after: { name: 'alpha', path: 'skills/alpha' },
    semanticCertainty: 'confirmed-by-caller',
    semanticAssessment: 'routine-content-update',
    requiresUserChoice: false,
    evidence: [{ type: 'same-selection-path' }, { type: 'fingerprint-changed' }],
  });
  assert.equal(behavior.candidates[0].kind, 'behavior-change');
  assert.equal(behavior.candidates[0].semanticCertainty, 'confirmed-by-caller');
  assert.equal(behavior.candidates[0].requiresUserChoice, true);
  assert.deepEqual(behavior.candidates[0].alternatives, ['accept-semantic-migration', 'keep-current-selection', 'defer']);

  assert.throws(() => compareSkillEvidence({
    before,
    after,
    semanticAssessments: [{ path: 'skills/alpha', kind: 'routine-content-update', confirmed: false }],
  }), /confirmed path and supported kind/);
});

test('compare reports likely rename evidence and alternatives', () => {
  const result = compareSkillEvidence({
    before: [skill('to-prd', 'skills/to-prd', 'same', ['SKILL.md', 'scripts/create.js'])],
    after: [skill('to-spec', 'skills/to-spec', 'same', ['SKILL.md', 'scripts/create.js'])],
  });

  const rename = result.candidates.find((candidate) => candidate.kind === 'likely-rename');
  assert.ok(rename);
  assert.equal(rename.semanticCertainty, 'undetermined');
  assert.equal(rename.requiresUserChoice, true);
  assert.deepEqual(rename.alternatives, ['treat-as-rename', 'treat-as-removal-and-addition', 'defer']);
  assert.ok(rename.evidence.some((item) => item.type === 'identical-fingerprint'));
});

test('compare output is bounded and coverage says candidates were omitted', () => {
  const result = compareSkillEvidence({
    before: [skill('a', 'a', '1'), skill('b', 'b', '2')],
    after: [skill('x', 'x', '1'), skill('y', 'y', '2')],
    maxCandidates: 1,
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'output-bounded');
  assert.ok(result.coverage.omittedCandidates > 0);
});

test('compare flags one-to-many and many-to-one evidence as choices, not conclusions', () => {
  const split = compareSkillEvidence({
    before: [skill('author', 'author', 'old', ['SKILL.md', 'shared.md'])],
    after: [
      skill('author-docs', 'author-docs', 'docs', ['SKILL.md', 'shared.md']),
      skill('author-code', 'author-code', 'code', ['SKILL.md', 'shared.md']),
    ],
  });
  const merge = compareSkillEvidence({
    before: [
      skill('review-docs', 'review-docs', 'docs', ['SKILL.md', 'shared.md']),
      skill('review-code', 'review-code', 'code', ['SKILL.md', 'shared.md']),
    ],
    after: [skill('review', 'review', 'new', ['SKILL.md', 'shared.md'])],
  });

  assert.equal(split.candidates.some((candidate) => candidate.kind === 'possible-split' && candidate.requiresUserChoice), true);
  assert.equal(merge.candidates.some((candidate) => candidate.kind === 'possible-merge' && candidate.requiresUserChoice), true);
});
