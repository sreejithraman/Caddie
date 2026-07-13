import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { invalid, replan } from './errors.mjs';
import { verifyGitPreparation } from './git.mjs';

const require = createRequire(import.meta.url);
const { hashValue } = require('../plans');
const execFileAsync = promisify(execFile);

export function buildPublicationPlan({ changeSetId, preparations, dependencies = [], completedChanges = [] }) {
  if (!changeSetId || !Array.isArray(preparations) || !preparations.length) {
    throw invalid('invalid-change-set', 'A Change Set id and preparations are required');
  }
  const byId = new Map(preparations.map((item) => [item.id, item]));
  if (byId.size !== preparations.length || byId.has(undefined)) throw invalid('duplicate-change-id', 'Every preparation needs a unique id');
  const completed = new Map(completedChanges.map((item) => [item.id, item.mergedCommit]));
  if (completed.size !== completedChanges.length || completed.has(undefined)) throw invalid('duplicate-change-id', 'Every completed change needs a unique id');
  for (const [id, commit] of completed) {
    if (byId.has(id) || typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw invalid('invalid-completed-change', 'Completed changes must be distinct and bind exact merged commits');
    }
  }
  const knownIds = new Set([...byId.keys(), ...completed.keys()]);
  const incoming = new Map(preparations.map(({ id }) => [id, new Set()]));
  for (const edge of dependencies) {
    if (!knownIds.has(edge.from) || !byId.has(edge.to)) throw invalid('unknown-dependency', 'Dependency references an unknown change', edge);
    incoming.get(edge.to).add(edge.from);
  }
  for (const preparation of preparations) {
    for (const dependency of incoming.get(preparation.id)) {
      if (completed.has(dependency) && preparation.dependencyCommits?.[dependency] !== completed.get(dependency)) {
        throw invalid('merged-dependency-commit-required', 'Preparation must bind each dependency final merged commit', {
          change: preparation.id, dependency, mergedCommit: completed.get(dependency),
        });
      }
    }
  }

  const remaining = new Set(byId.keys());
  const waves = [];
  while (remaining.size) {
    const ids = [...remaining].filter((id) => [...incoming.get(id)].every((dependency) => !remaining.has(dependency))).sort();
    if (!ids.length) throw invalid('dependency-cycle', 'Change Set dependencies contain a cycle');
    waves.push(ids.map((id) => publicationEntry(changeSetId, byId.get(id), [...incoming.get(id)].sort())));
    ids.forEach((id) => remaining.delete(id));
  }
  const payload = {
    version: 1,
    kind: 'publication',
    changeSetId,
    publicationAllowed: false,
    completedChanges: [...completed].map(([id, mergedCommit]) => ({ id, mergedCommit })).sort((a, b) => a.id.localeCompare(b.id)),
    waves,
  };
  return deepFreeze({ ...payload, id: hashValue(payload) });
}

export async function applyPublicationPlan(plan, approval, runtime = {}) {
  verifyPublicationPlan(plan, approval);
  const run = runtime.execFile ?? execFileAsync;
  const verify = runtime.verifyGitPreparation ?? verifyGitPreparation;
  const published = [];
  // Only the dependency-free frontier is publishable under one approval. A
  // later wave must be prepared again after its dependencies merge so its
  // locks and base commit bind the final merged source state.
  for (const wave of plan.waves.slice(0, 1)) {
    for (const entry of wave) {
      if (entry.workflow === 'review-apply-plan' || entry.workflow === 'local-branch') {
        published.push({ id: entry.id, workflow: entry.workflow, externalWrite: false });
        continue;
      }
      const preparation = entry.preparation;
      await verify(preparation);
      const liveRemoteUrls = (await run('git', [
        '-C', entry.worktree, 'remote', 'get-url', '--push', '--all', entry.destination.remote,
      ], { encoding: 'utf8' })).stdout.trim().split('\n').filter(Boolean);
      if (liveRemoteUrls.length !== 1 || liveRemoteUrls[0] !== entry.destination.remoteUrl) {
        throw replan('remote-destination-moved', 'Git remote destination changed after publication approval', {
          remote: entry.destination.remote,
          expected: entry.destination.remoteUrl,
          received: liveRemoteUrls,
        });
      }
      const actualHead = (await run('git', ['-C', entry.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
      if (actualHead !== entry.headCommit) {
        throw replan('prepared-head-moved', 'Prepared branch head changed before publication', {
          expected: entry.headCommit, received: actualHead,
        });
      }
      const lease = entry.expectedRemoteBranchCommit === null ? '' : entry.expectedRemoteBranchCommit;
      await run('git', [
        '-C', entry.worktree,
        'push', entry.destination.remote,
        `${entry.headCommit}:refs/heads/${entry.branch}`,
        `--force-with-lease=refs/heads/${entry.branch}:${lease}`,
      ], { encoding: 'utf8' });
      let pullRequestUrl = null;
      if (entry.workflow === 'github-draft-pr') {
        const result = await run('gh', [
          'pr', 'create', '--draft', '--repo', entry.destination.repositorySlug,
          '--base', entry.destination.baseBranch, '--head', entry.branch,
          '--title', entry.title, '--body', entry.bodyMarkers,
        ], { encoding: 'utf8' });
        pullRequestUrl = result.stdout.trim();
      }
      published.push({ id: entry.id, workflow: entry.workflow, externalWrite: true, pullRequestUrl });
    }
  }
  return {
    applied: true,
    planId: plan.id,
    published,
    remainingWaves: Math.max(0, plan.waves.length - 1),
    ...(plan.waves.length > 1 ? {
      requiresReplan: true,
      reason: 'merged-dependencies-must-be-reresolved',
    } : {}),
  };
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
  const pushUrl = preparation.remotePushUrl;
  const github = isGitHubRemote(pushUrl);
  const workflow = !pushUrl ? 'local-branch' : github ? 'github-draft-pr' : 'branch-push';
  if (pushUrl && !Object.hasOwn(preparation, 'expectedRemoteBranchCommit')) {
    throw invalid('remote-branch-state-required', 'Publication must bind the exact current remote branch state');
  }
  const remote = remoteName(preparation.baseRef);
  const repositorySlug = github ? githubSlug(pushUrl) : null;
  return {
    id: preparation.id,
    workflow,
    repository: preparation.repository,
    worktree: preparation.worktree,
    branch: preparation.branch,
    baseRef: preparation.baseRef,
    baseCommit: preparation.baseCommit,
    headCommit: preparation.headCommit,
    preparation: structuredClone(preparation),
    dependencies,
    requiresMergedDependencies: dependencies,
    ...(pushUrl ? {
      expectedRemoteBranchCommit: preparation.expectedRemoteBranchCommit,
      destination: {
        remote,
        remoteUrl: pushUrl,
        ...(repositorySlug ? { repositorySlug, baseBranch: baseBranch(preparation.baseRef) } : {}),
      },
    } : {}),
    ...(github ? {
      draft: true,
      title: preparation.title ?? `caddie: ${preparation.id}`,
      bodyMarkers: createPullRequestMarkers(changeSetId, preparation.id, dependencies),
    } : {}),
  };
}

function isGitHubRemote(url) {
  return githubDestination(url) !== null;
}

function verifyPublicationPlan(plan, approval) {
  if (!plan || plan.version !== 1 || plan.kind !== 'publication' || typeof plan.id !== 'string') {
    throw invalid('invalid-publication-plan', 'Publication plan is invalid');
  }
  const { id, ...payload } = plan;
  if (hashValue(payload) !== id) throw replan('altered-plan', 'Publication plan was altered');
  if (!approval || approval.version !== 1 || approval.approval !== 'explicit' || approval.planId !== id) {
    throw invalid('unapproved-plan', 'Exact explicit approval is required');
  }
}

function remoteName(baseRef) {
  const match = /^([^/]+)\/(.+)$/.exec(baseRef ?? '');
  if (!match) throw invalid('remote-base-required', 'External publication requires a remote base ref');
  return match[1];
}

function baseBranch(baseRef) {
  return baseRef.slice(baseRef.indexOf('/') + 1);
}

function githubSlug(url) {
  const destination = githubDestination(url);
  if (!destination) throw invalid('invalid-github-remote', 'Cannot derive the GitHub repository destination');
  return destination;
}

function githubDestination(url) {
  if (typeof url !== 'string') return null;
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(url);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const parts = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/').filter(Boolean);
    return parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}
