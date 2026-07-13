import { invalid } from './errors.mjs';

export function buildPublicationPlan({ changeSetId, preparations, dependencies = [] }) {
  if (!changeSetId || !Array.isArray(preparations) || !preparations.length) {
    throw invalid('invalid-change-set', 'A Change Set id and preparations are required');
  }
  const byId = new Map(preparations.map((item) => [item.id, item]));
  if (byId.size !== preparations.length || byId.has(undefined)) throw invalid('duplicate-change-id', 'Every preparation needs a unique id');
  const incoming = new Map(preparations.map(({ id }) => [id, new Set()]));
  for (const edge of dependencies) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) throw invalid('unknown-dependency', 'Dependency references an unknown change', edge);
    incoming.get(edge.to).add(edge.from);
  }

  const remaining = new Set(byId.keys());
  const waves = [];
  while (remaining.size) {
    const ids = [...remaining].filter((id) => [...incoming.get(id)].every((dependency) => !remaining.has(dependency))).sort();
    if (!ids.length) throw invalid('dependency-cycle', 'Change Set dependencies contain a cycle');
    waves.push(ids.map((id) => publicationEntry(changeSetId, byId.get(id), [...incoming.get(id)].sort())));
    ids.forEach((id) => remaining.delete(id));
  }
  return { version: 1, changeSetId, publicationAllowed: false, waves };
}

export function createPullRequestMarkers(changeSetId, changeId, dependencies = []) {
  return [
    `<!-- caddie-change-set:${changeSetId} -->`,
    `<!-- caddie-change:${changeId} -->`,
    `<!-- caddie-depends-on:${dependencies.join(',')} -->`,
  ].join('\n');
}

export function parsePullRequestMarkers(body) {
  const read = (key) => body.match(new RegExp(`<!--\\s*${key}:([^>]*?)\\s*-->`))?.[1].trim() ?? null;
  const changeSetId = read('caddie-change-set');
  const changeId = read('caddie-change');
  const dependencyText = read('caddie-depends-on');
  if (!changeSetId || !changeId || dependencyText === null) return null;
  return { changeSetId, changeId, dependencies: dependencyText ? dependencyText.split(',').filter(Boolean) : [] };
}

function publicationEntry(changeSetId, preparation, dependencies) {
  if (preparation.kind === 'sandbox') {
    return { id: preparation.id, workflow: 'review-apply-plan', applyPlan: preparation.applyPlan, dependencies };
  }
  if (preparation.kind !== 'git') throw invalid('unknown-preparation-kind', `Unknown preparation kind: ${preparation.kind}`);
  const github = isGitHubRemote(preparation.remoteUrl);
  const workflow = !preparation.remoteUrl ? 'local-branch' : github ? 'github-draft-pr' : 'branch-push';
  return {
    id: preparation.id,
    workflow,
    branch: preparation.branch,
    headCommit: preparation.headCommit,
    dependencies,
    requiresMergedDependencies: dependencies,
    ...(github ? { draft: true, bodyMarkers: createPullRequestMarkers(changeSetId, preparation.id, dependencies) } : {}),
  };
}

function isGitHubRemote(url) {
  return typeof url === 'string' && /(?:github\.com[/:])/.test(url);
}
