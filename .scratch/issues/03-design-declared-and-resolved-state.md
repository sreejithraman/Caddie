# Design declared and resolved state

Type: grilling
Status: resolved
Blocked by: 02

## Question

What is the smallest manifest, lock, source-selection, scope, and narrative-reference model that can reproduce Global, Project, and Effective Stacks without encoding agent judgment unnecessarily?

## Answer

Caddie uses one root-level `caddie.json` Stack Manifest format with `scope: "user"` or `scope: "project"`. A user-scoped manifest declares the User Stack rendered into user-level harness locations. A project-scoped manifest declares the additive Project Stack rendered into that repository's harness locations. Caddie combines them locally into the Effective Stack; it never commits a merged personal/project artifact.

Every selected skill is an explicit `{ "source", "path" }` object referring to a named typed source. Sources are `local` or `git`; committed local sources must remain inside the containing Git repository. Git sources may declare an optional moving `ref`, defaulting to the remote default branch. A Resolution Lock pins external sources to exact commits and selected or lineage-referenced skill hashes. Local skills are versioned by their containing Git repository and use disposable fingerprints for rendering freshness rather than committed hashes.

Project manifests are additive in v1. Equal rendered names are errors rather than harness-dependent overrides. Each adjacent `caddie.lock` resolves only its own manifest, so project locks never absorb a user's User Stack. Locks are deterministic and exclude timestamps, absolute paths, installation locations, and machine metadata.

A project-owned skill may declare `derivedFrom` as an array of source/path references. The lock retains the exact bases, while an optional `decision` path points to Markdown when semantic composition needs durable explanation. Caddie must also infer and propose undeclared lineage from managed-copy history, content similarity, names, and repository evidence; metadata improves future analysis but is not a prerequisite.

Machine-specific state consists of one config file under the standard user config root, containing the user-manifest location and registered project paths. Upstream checkouts, worktrees, analysis, and rendering fingerprints live under a completely disposable cache root. The accepted product namespace is Caddie, so normal paths are `~/.config/caddie/config.json` and `~/.cache/caddie/` when XDG overrides are absent.
