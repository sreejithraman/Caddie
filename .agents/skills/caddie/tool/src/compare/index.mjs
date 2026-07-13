function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identity(skill) {
  return skill.path ?? skill.name;
}

function completeFingerprint(skill) {
  return skill?.fingerprint?.complete === true && typeof skill.fingerprint.digest === 'string';
}

function overlap(left = [], right = []) {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / union.size;
}

function nameSimilarity(left = '', right = '') {
  if (left === right) return 1;
  const a = left.split(/[-_]/).filter(Boolean);
  const b = right.split(/[-_]/).filter(Boolean);
  const shared = a.filter((part) => b.includes(part)).length;
  return Math.max(a.length, b.length) === 0 ? 0 : shared / Math.max(a.length, b.length);
}

function baseCandidate(kind, before, after) {
  return {
    kind,
    before: before ? { name: before.name ?? null, path: before.path ?? null } : null,
    after: after ? { name: after.name ?? null, path: after.path ?? null } : null,
    semanticCertainty: 'undetermined',
  };
}

/**
 * Compares deterministic skill evidence. Candidates are deliberately phrased as
 * possibilities; deciding identity, behavior, lineage, split, or merge remains an
 * agent/user responsibility.
 */
export function compareSkillEvidence({ before = [], after = [], maxCandidates = 100 }) {
  if (!Array.isArray(before) || !Array.isArray(after)) throw new TypeError('before and after must be arrays');
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) throw new TypeError('maxCandidates must be a positive integer');

  const previous = [...before].sort((a, b) => compareText(identity(a), identity(b)));
  const current = [...after].sort((a, b) => compareText(identity(a), identity(b)));
  const currentByPath = new Map(current.map((skill) => [identity(skill), skill]));
  const matchedAfter = new Set();
  const candidates = [];
  const findings = [];

  for (const skill of [...previous, ...current]) {
    if (!completeFingerprint(skill)) {
      findings.push({ code: 'partial-fingerprint', path: skill.path ?? null, name: skill.name ?? null });
    }
  }

  const removed = [];
  for (const oldSkill of previous) {
    const newSkill = currentByPath.get(identity(oldSkill));
    if (!newSkill) {
      removed.push(oldSkill);
      continue;
    }
    matchedAfter.add(newSkill);
    if (completeFingerprint(oldSkill) && completeFingerprint(newSkill)
      && oldSkill.fingerprint.digest !== newSkill.fingerprint.digest) {
      candidates.push({
        ...baseCandidate('content-update', oldSkill, newSkill),
        requiresUserChoice: false,
        evidence: [{ type: 'same-selection-path' }, { type: 'fingerprint-changed' }],
      });
    }
  }

  const added = current.filter((skill) => !matchedAfter.has(skill));
  const pairedRemoved = new Set();
  const pairedAdded = new Set();
  const possiblePairs = [];
  for (const oldSkill of removed) {
    for (const newSkill of added) {
      const identical = completeFingerprint(oldSkill) && completeFingerprint(newSkill)
        && oldSkill.fingerprint.digest === newSkill.fingerprint.digest;
      const fileOverlap = overlap(oldSkill.files, newSkill.files);
      const names = nameSimilarity(oldSkill.name, newSkill.name);
      if (identical || fileOverlap >= 0.5 || names >= 0.5) {
        possiblePairs.push({ oldSkill, newSkill, identical, fileOverlap, names });
      }
    }
  }
  possiblePairs.sort((left, right) => {
    const leftScore = Number(left.identical) * 4 + left.fileOverlap * 2 + left.names;
    const rightScore = Number(right.identical) * 4 + right.fileOverlap * 2 + right.names;
    return rightScore - leftScore
      || compareText(identity(left.oldSkill), identity(right.oldSkill))
      || compareText(identity(left.newSkill), identity(right.newSkill));
  });

  for (const oldSkill of removed) {
    const matches = possiblePairs.filter((pair) => pair.oldSkill === oldSkill);
    if (matches.length > 1) {
      candidates.push({
        kind: 'possible-split',
        before: { name: oldSkill.name ?? null, path: oldSkill.path ?? null },
        after: matches.map(({ newSkill }) => ({ name: newSkill.name ?? null, path: newSkill.path ?? null })),
        semanticCertainty: 'undetermined',
        requiresUserChoice: true,
        alternatives: ['treat-as-split', 'treat-as-independent-changes', 'defer'],
        evidence: matches.map(({ newSkill, fileOverlap, names }) => ({
          candidatePath: newSkill.path ?? null,
          filePathOverlap: fileOverlap,
          nameTokenOverlap: names,
        })),
      });
    }
  }
  for (const newSkill of added) {
    const matches = possiblePairs.filter((pair) => pair.newSkill === newSkill);
    if (matches.length > 1) {
      candidates.push({
        kind: 'possible-merge',
        before: matches.map(({ oldSkill }) => ({ name: oldSkill.name ?? null, path: oldSkill.path ?? null })),
        after: { name: newSkill.name ?? null, path: newSkill.path ?? null },
        semanticCertainty: 'undetermined',
        requiresUserChoice: true,
        alternatives: ['treat-as-merge', 'treat-as-independent-changes', 'defer'],
        evidence: matches.map(({ oldSkill, fileOverlap, names }) => ({
          candidatePath: oldSkill.path ?? null,
          filePathOverlap: fileOverlap,
          nameTokenOverlap: names,
        })),
      });
    }
  }

  for (const pair of possiblePairs) {
    if (pairedRemoved.has(pair.oldSkill) || pairedAdded.has(pair.newSkill)) continue;
    pairedRemoved.add(pair.oldSkill);
    pairedAdded.add(pair.newSkill);
    const evidence = [];
    if (pair.identical) evidence.push({ type: 'identical-fingerprint' });
    if (pair.fileOverlap > 0) evidence.push({ type: 'file-path-overlap', ratio: pair.fileOverlap });
    if (pair.names > 0) evidence.push({ type: 'name-token-overlap', ratio: pair.names });
    candidates.push({
      ...baseCandidate('likely-rename', pair.oldSkill, pair.newSkill),
      requiresUserChoice: true,
      alternatives: ['treat-as-rename', 'treat-as-removal-and-addition', 'defer'],
      evidence,
    });
  }

  for (const skill of removed) {
    if (pairedRemoved.has(skill)) continue;
    candidates.push({
      ...baseCandidate('removal', skill, null),
      requiresUserChoice: true,
      alternatives: ['accept-removal', 'seek-lineage', 'defer'],
      evidence: [{ type: 'selection-no-longer-present' }],
    });
  }
  for (const skill of added) {
    if (pairedAdded.has(skill)) continue;
    candidates.push({
      ...baseCandidate('addition', null, skill),
      requiresUserChoice: true,
      alternatives: ['accept-addition', 'seek-lineage', 'defer'],
      evidence: [{ type: 'new-selection-present' }],
    });
  }

  candidates.sort((left, right) => compareText(left.kind, right.kind)
    || compareText(Array.isArray(left.before) ? left.before[0]?.path ?? '' : left.before?.path ?? '', Array.isArray(right.before) ? right.before[0]?.path ?? '' : right.before?.path ?? '')
    || compareText(Array.isArray(left.after) ? left.after[0]?.path ?? '' : left.after?.path ?? '', Array.isArray(right.after) ? right.after[0]?.path ?? '' : right.after?.path ?? ''));
  const returned = candidates.slice(0, maxCandidates);
  const omittedCandidates = candidates.length - returned.length;
  return {
    candidates: returned,
    coverage: {
      complete: omittedCandidates === 0 && findings.length === 0,
      reason: omittedCandidates > 0 ? 'output-bounded' : findings.length > 0 ? 'input-partial' : null,
      comparedBefore: previous.length,
      comparedAfter: current.length,
      omittedCandidates,
      findings,
    },
    interpretationPolicy: {
      semanticCertainty: 'not-determined-by-tool',
      inspectedArtifacts: 'untrusted-data',
    },
  };
}
