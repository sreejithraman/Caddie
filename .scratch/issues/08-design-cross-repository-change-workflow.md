# Design cross-repository change workflow

Type: grilling
Status: resolved
Blocked by: 05, 06, 07

## Question

How should accepted recommendations become isolated worktrees, validated commits, and coordinated draft PRs across the Stack Repository and affected managed projects without broadening authorization implicitly?

## Answer

An accepted cross-repository recommendation becomes one Change Set containing repository-local transactions. Caddie prepares and validates every repository before publishing anything, then requests one scoped approval covering the explicitly listed commits, pushes, and draft PRs. Authority already explicit in the user's originating request may carry through the exact plan without a redundant prompt; adding a repository, remote, branch, or effect requires replanning.

Every Git-backed edit occurs in a Caddie-managed worktree under the disposable cache, never in a primary working directory. Caddie fetches and defaults the base to the exact current commit at `origin/main` unless the repository or approved plan specifies another remote/branch; a missing default is surfaced rather than guessed. Existing dirty worktrees are preserved. Relevant selected uncommitted changes may be fingerprinted and carried only through an explicit plan. Branches default to `caddie/<slug>`, with one focused commit per affected repository and collision-safe resume-or-new behavior.

GitHub is the only automated draft-PR host in v1. Host-neutral Git repositories may still receive worktrees, branches, commits, and authorized pushes. A repository without a remote stops at a local committed branch. A non-Git directory remains fully inspectable/manageable and uses a Change Sandbox for approved content work, followed by the normal preconditioned apply journal; Caddie explains that history, PRs, and strong attribution are unavailable and recommends Git without requiring it.

Independent repositories publish together. When a consumer lock depends on a source repository's final merged commit, publication occurs in waves: publish the source PR, wait for its separately authorized merge, fetch the final commit, regenerate and revalidate dependent locks, then publish consumer PRs. Temporary feature-branch commits are not used as durable consumer pins unless explicitly accepted.

Each draft PR contains concise human-readable Change Set and dependency information plus a stable hidden Caddie marker. This permits recovery from GitHub after conversations, caches, or worktrees disappear without creating a tracking issue or committed umbrella report. Caddie has no daemon in v1; later waves resume on an explicit request or a normal Caddie inspection that discovers newly unblocked marked work.

Remote publication cannot be globally atomic. Already opened draft PRs remain valid if a later repository fails; Caddie reports partial completion and replans only the incomplete work. Human or bot commits added to a Caddie branch are preserved, fetched, and treated as changed preconditions. Caddie never resets or force-pushes them by default; it replans against current remote state, retains the existing PR when safe, or proposes a new branch when reconciliation is ambiguous.
