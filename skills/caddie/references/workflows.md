# Workflow branches

## Adoption

Use `plan.workflow: "adoption"` with exact-match Adoption evidence. Preserve modified, unknown, colliding, and permission-blocked entries. A user-scope adoption keeps each real directory under `~/.agents/skills` and adds its Claude compatibility link.

Treat legacy manager state as evidence. Recommend its removal after independent verification, through the approved adoption plan.

## Unmanagement and cleanup

Use `unmanagement` to remove Caddie ownership and registration while retaining Materialized Skills and Agent Harness exposure.

Use `cleanup` as a separate destructive follow-up with its own exact approval.

## Change Sandbox

Use `prepare-change-sandbox` for a non-Git owning location. Validate the prepared copy, then use `sandbox-apply` to bind its exact apply plan.

## Focused Git publication

Prefer `publish-git-change` for one repository. Bind the exact file changes, validation commands, base commit, push destination, remote branch state, and draft-PR metadata so one approval covers the focused commit, push, and PR publication. Retrying the same plan resumes its verified prepared branch.

Use `prepare-git-change` when preparation and publication need separate approval boundaries.

Reverify the Git base, head, effective push URL, and remote branch state immediately before each external write. Remote movement requires a fresh plan.

## Multi-repository Change Set

Prepare and validate every repository worktree or Change Sandbox before requesting `plan.workflow: "publication"`. Publish source waves first. After a source merges, prepare the consumer wave with `completedChanges` and matching `dependencyCommits` bound to the final merged commit.

One publication approval covers the currently dependency-free wave. Each later wave receives its own preparation and plan after its dependencies merge.

## Rediscovery

For resumed publication, gather bounded local preparation evidence and pull-request bodies, then call `inspect` with `view: "change-sets"`. Report complete and incomplete Change Sets, marker coverage, remaining changes, and dependency state before proposing the next plan.
