import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { invalid, replan } from './errors.mjs';

const execFileAsync = promisify(execFile);

export async function prepareGitChange(options) {
  const repository = path.resolve(required(options.repository, 'repository'));
  const slug = validateSlug(options.slug);
  if (typeof options.author !== 'function') throw invalid('author-required', 'A focused author function is required');
  if (typeof options.validate !== 'function') throw invalid('validation-required', 'A parent-owned validation function is required');

  const branch = `caddie/${slug}`;
  const base = await resolveExactBase(repository, options);
  const workspaceRoot = options.workspaceRoot
    ? path.resolve(options.workspaceRoot)
    : await mkdtemp(path.join(tmpdir(), 'caddie-worktrees-'));
  await mkdir(workspaceRoot, { recursive: true });
  const worktree = path.join(workspaceRoot, slug);

  try {
    await git(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    throw replan('branch-already-exists', `Focused branch already exists: ${branch}`, { repository, branch });
  } catch (error) {
    if (error instanceof Error && error.code === 'branch-already-exists') throw error;
    if (error?.gitExitCode !== 1) throw error;
  }

  let added = false;
  try {
    await git(repository, ['worktree', 'add', '--detach', worktree, base.commit]);
    added = true;
    await git(worktree, ['switch', '-c', branch]);
    await options.author({ directory: worktree, repository, branch, baseCommit: base.commit });
    await options.validate({ directory: worktree, repository, branch, baseCommit: base.commit });
    await git(worktree, ['add', '--all']);
    const staged = await git(worktree, ['diff', '--cached', '--name-only']);
    if (!staged.stdout.trim()) throw invalid('empty-change', 'Authoring produced no focused change', { repository });
    await git(worktree, [
      '-c', `user.name=${options.authorName ?? 'Caddie'}`,
      '-c', `user.email=${options.authorEmail ?? 'caddie@localhost'}`,
      'commit', '-m', options.message ?? `caddie: ${slug}`,
    ]);
    const headCommit = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    const commitCount = Number((await git(worktree, ['rev-list', '--count', `${base.commit}..${headCommit}`])).stdout.trim());
    if (commitCount !== 1) throw replan('non-focused-history', 'Prepared branch must contain exactly one focused commit', { commitCount });
    const remoteUrl = await optionalGit(repository, ['remote', 'get-url', 'origin']);
    return {
      kind: 'git',
      repository,
      worktree,
      branch,
      baseRef: base.ref,
      baseCommit: base.commit,
      headCommit,
      changedFiles: staged.stdout.trim().split('\n'),
      remote: base.remote,
      remoteUrl: remoteUrl?.stdout.trim() || null,
    };
  } catch (error) {
    // Failed authoring or validation may itself contain valuable local work. Preserve
    // it by default; cleanup is an explicit opt-in for disposable automation.
    if (added && options.cleanupFailedWorktree === true) {
      await optionalGit(repository, ['worktree', 'remove', '--force', worktree]);
      await optionalGit(repository, ['branch', '-D', branch]);
      await rm(worktree, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function verifyGitPreparation(preparation) {
  if (preparation.kind !== 'git') throw invalid('not-git-preparation', 'Expected a Git preparation');
  const head = (await git(preparation.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  if (head !== preparation.headCommit) {
    throw replan('prepared-head-moved', 'Prepared branch head changed after validation', {
      expected: preparation.headCommit, received: head,
    });
  }
  if (preparation.remote) {
    const remoteHead = await readRemoteHead(preparation.repository, preparation.baseRef);
    if (remoteHead !== preparation.baseCommit) {
      throw replan('remote-head-moved', 'Remote base changed after preparation', {
        ref: preparation.baseRef, expected: preparation.baseCommit, received: remoteHead,
      });
    }
  }
  return true;
}

async function resolveExactBase(repository, options) {
  const explicit = options.baseRef !== undefined;
  const ref = options.baseRef ?? 'origin/main';
  const remoteMatch = /^([^/]+)\/(.+)$/.exec(ref);
  if (remoteMatch) {
    const [, remote, remoteRef] = remoteMatch;
    try {
      await git(repository, ['fetch', '--no-tags', remote, remoteRef]);
    } catch (error) {
      throw replan('base-unavailable', `Cannot fetch required base ${ref}`, { ref, cause: error.message });
    }
    const commit = (await git(repository, ['rev-parse', 'FETCH_HEAD^{commit}'])).stdout.trim();
    if (options.expectedBaseCommit && commit !== options.expectedBaseCommit) {
      throw replan('base-moved', 'Fetched base does not match the approved exact commit', {
        ref, expected: options.expectedBaseCommit, received: commit,
      });
    }
    return { ref, commit, remote: true };
  }
  if (!explicit) throw replan('base-unavailable', 'origin/main is required unless another base is explicitly selected');
  let commit;
  try {
    commit = (await git(repository, ['rev-parse', `${ref}^{commit}`])).stdout.trim();
  } catch (error) {
    throw replan('base-unavailable', `Explicit base is unavailable: ${ref}`, { ref, cause: error.message });
  }
  if (options.expectedBaseCommit && commit !== options.expectedBaseCommit) {
    throw replan('base-moved', 'Explicit base does not match the approved exact commit', {
      ref, expected: options.expectedBaseCommit, received: commit,
    });
  }
  return { ref, commit, remote: false };
}

async function readRemoteHead(repository, baseRef) {
  const match = /^([^/]+)\/(.+)$/.exec(baseRef);
  if (!match) return null;
  const result = await git(repository, ['ls-remote', match[1], `refs/heads/${match[2]}`]);
  const line = result.stdout.trim();
  if (!line) throw replan('remote-base-unavailable', `Remote base disappeared: ${baseRef}`, { baseRef });
  return line.split(/\s+/)[0];
}

async function git(directory, args) {
  try {
    return await execFileAsync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  } catch (error) {
    error.gitExitCode = error.code;
    throw error;
  }
}

async function optionalGit(directory, args) {
  try { return await git(directory, args); } catch { return null; }
}

function required(value, name) {
  if (typeof value !== 'string' || !value) throw invalid(`${name}-required`, `${name} is required`);
  return value;
}

function validateSlug(value) {
  const slug = required(value, 'slug');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw invalid('invalid-slug', 'Slug must contain lowercase letters, numbers, and single hyphens');
  }
  return slug;
}
