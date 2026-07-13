import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { invalid, replan } from './errors.mjs';
import { verifyGitPreparation } from './git.mjs';
import { verifyChangeSandboxPlan } from './sandbox.mjs';

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
  verifyPublicationPlan(plan, approval, runtime);
  const run = runtime.execFile ?? execFileAsync;
  const verify = runtime.verifyGitPreparation ?? verifyGitPreparation;
  const verifySandbox = runtime.verifyChangeSandboxPlan ?? verifyChangeSandboxPlan;
  const published = [];
  const checks = [];
  // Only the dependency-free frontier is publishable under one approval. A
  // later wave must be prepared again after its dependencies merge so its
  // locks and base commit bind the final merged source state.
  for (const wave of plan.waves.slice(0, 1)) {
    for (const entry of wave) {
      if (entry.workflow === 'review-apply-plan' || entry.workflow === 'local-branch') {
        if (entry.workflow === 'review-apply-plan') await verifySandbox(entry.applyPlan);
        else await preflightLocalGitEntry(entry, run, verify);
        checks.push({ entry, externalWrite: false });
        continue;
      }
      checks.push(await preflightPublicationEntry(entry, run, verify));
    }
  }

  // Nothing external is written until every prepared repository in the
  // Change Set has passed its current-state checks.
  for (const laterWave of plan.waves.slice(1)) {
    for (const entry of laterWave) {
      if (entry.workflow === 'review-apply-plan') await verifySandbox(entry.applyPlan);
      else if (entry.workflow === 'local-branch') await preflightLocalGitEntry(entry, run, verify);
      else await preflightPublicationEntry(entry, run, verify, { inspectPullRequest: false });
    }
  }

  for (const check of checks) {
    const { entry } = check;
    if (!check.externalWrite) {
      published.push({ id: entry.id, workflow: entry.workflow, externalWrite: false });
      continue;
    }
    try {
      if (!check.alreadyPushed) {
        const lease = entry.expectedRemoteBranchCommit === null ? '' : entry.expectedRemoteBranchCommit;
        await run('git', [
          '-C', entry.worktree,
          'push', entry.destination.remoteUrl,
          `${entry.headCommit}:refs/heads/${entry.branch}`,
          `--force-with-lease=refs/heads/${entry.branch}:${lease}`,
        ], { encoding: 'utf8' });
      }
      let pullRequestUrl = check.pullRequestUrl;
      if (entry.workflow === 'github-draft-pr' && !pullRequestUrl) {
        const result = await run('gh', [
          'pr', 'create', '--draft', '--repo', entry.destination.repositorySlug,
          '--base', entry.destination.baseBranch, '--head', entry.branch,
          '--title', entry.title, '--body', entry.bodyMarkers,
        ], { encoding: 'utf8' });
        pullRequestUrl = result.stdout.trim();
      }
      published.push({ id: entry.id, workflow: entry.workflow, externalWrite: true, pullRequestUrl });
    } catch (error) {
      throw replan('publication-interrupted', 'Publication stopped after an external write; retry the same exact plan to resume safely', {
        completed: published,
        failed: entry.id,
        cause: error.message,
      });
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

async function preflightLocalGitEntry(entry, run, verify) {
  await verify(entry.preparation);
  const actualHead = (await run('git', ['-C', entry.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
  if (actualHead !== entry.headCommit) {
    throw replan('prepared-head-moved', 'Prepared branch head changed before publication', {
      expected: entry.headCommit, received: actualHead,
    });
  }
}

async function preflightPublicationEntry(entry, run, verify, options = {}) {
  await verify(entry.preparation);
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
  const remoteLine = (await run('git', [
    'ls-remote', '--', entry.destination.remoteUrl, `refs/heads/${entry.branch}`,
  ], { encoding: 'utf8' })).stdout.trim();
  const remoteHead = remoteLine ? remoteLine.split(/\s+/)[0] : null;
  const expected = entry.expectedRemoteBranchCommit;
  if (remoteHead !== expected && remoteHead !== entry.headCommit) {
    throw replan('remote-branch-moved', 'Remote publication branch changed after approval', {
      branch: entry.branch, expected, received: remoteHead,
    });
  }
  let pullRequestUrl = null;
  if (entry.workflow === 'github-draft-pr' && options.inspectPullRequest !== false) {
    const response = await run('gh', [
      'pr', 'list', '--repo', entry.destination.repositorySlug,
      '--head', entry.branch, '--state', 'open', '--json', 'url,title,body,isDraft',
    ], { encoding: 'utf8' });
    let existing;
    try { [existing] = JSON.parse(response.stdout || '[]'); } catch {
      throw replan('github-evidence-invalid', 'GitHub returned invalid pull-request evidence');
    }
    if (existing) {
      const actualMarkers = parsePullRequestMarkers(existing.body ?? '');
      const expectedMarkers = parsePullRequestMarkers(entry.bodyMarkers);
      if (JSON.stringify(actualMarkers) !== JSON.stringify(expectedMarkers) || existing.isDraft !== true) {
        throw replan('pull-request-collision', 'An existing pull request for the branch does not match the approved publication');
      }
      pullRequestUrl = existing.url;
    }
  }
  return { entry, externalWrite: true, alreadyPushed: remoteHead === entry.headCommit, pullRequestUrl };
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

export function reconstructChangeSets({ pullRequests = [], localChanges = [] } = {}) {
  if (!Array.isArray(pullRequests) || !Array.isArray(localChanges)) {
    throw invalid('invalid-change-set-evidence', 'Change Set evidence must provide pullRequests and localChanges arrays');
  }
  const groups = new Map();
  const findings = [];
  const mergeChangeEvidence = (changeSetId, changeId, value) => {
    if (!groups.has(changeSetId)) groups.set(changeSetId, new Map());
    const changes = groups.get(changeSetId);
    const current = changes.get(changeId) ?? { id: changeId, dependencies: [] };
    changes.set(changeId, {
      ...current,
      ...value,
      referencedOnly: false,
      dependencies: [...new Set([...(current.dependencies ?? []), ...(value.dependencies ?? [])])].sort(),
    });
  };
  for (const item of localChanges) {
    if (!item || typeof item.changeSetId !== 'string' || typeof item.changeId !== 'string') {
      findings.push({ code: 'invalid-local-change-evidence' });
      continue;
    }
    mergeChangeEvidence(item.changeSetId, item.changeId, {
      local: true,
      preparation: item.preparation ?? null,
      dependencies: Array.isArray(item.dependencies) ? item.dependencies : [],
    });
  }
  for (const pullRequest of pullRequests) {
    const body = typeof pullRequest?.body === 'string' ? pullRequest.body : '';
    const markers = parsePullRequestMarkers(body);
    if (!markers) {
      if (body.includes('caddie-change-set:')) findings.push({ code: 'invalid-pull-request-markers', url: pullRequest?.url ?? null });
      continue;
    }
    mergeChangeEvidence(markers.changeSetId, markers.changeId, {
      pullRequest: {
        url: pullRequest.url ?? null,
        state: pullRequest.state ?? 'unknown',
        mergedCommit: pullRequest.mergedCommit ?? null,
      },
      dependencies: markers.dependencies,
    });
  }
  for (const changes of groups.values()) {
    const dependencyIds = new Set([...changes.values()].flatMap((change) => change.dependencies ?? []));
    for (const dependencyId of dependencyIds) {
      if (!changes.has(dependencyId)) {
        changes.set(dependencyId, { id: dependencyId, dependencies: [], referencedOnly: true });
      }
    }
  }
  const changeSets = [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([id, changes]) => {
    const listed = [...changes.values()].sort((left, right) => left.id.localeCompare(right.id));
    const incomplete = listed.filter((change) => change.pullRequest?.state !== 'merged');
    return {
      id,
      status: incomplete.length === 0 ? 'complete' : 'incomplete',
      changes: listed,
      remainingChanges: incomplete.map(({ id: changeId }) => changeId),
    };
  });
  return {
    changeSets,
    coverage: {
      complete: findings.length === 0,
      reason: findings.length ? 'change-set-evidence-partial' : null,
      findings,
    },
  };
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
  const remote = pushUrl ? remoteName(preparation.baseRef) : null;
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

function verifyPublicationPlan(plan, approval, runtime = {}) {
  if (!plan || plan.version !== 1 || plan.kind !== 'publication' || typeof plan.id !== 'string') {
    throw invalid('invalid-publication-plan', 'Publication plan is invalid');
  }
  const { id, ...payload } = plan;
  if (hashValue(payload) !== id) throw replan('altered-plan', 'Publication plan was altered');
  const explicit = approval?.approval === 'explicit';
  const derived = approval?.approval === 'derived-from-approved-workflow'
    && typeof runtime.approvedParentPlanId === 'string'
    && approval.parentPlanId === runtime.approvedParentPlanId;
  if (!approval || approval.version !== 1 || (!explicit && !derived) || approval.planId !== id) {
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
