# Skill Manager Agent App

## Destination

An agent-ready specification for a separate, reusable Skill Manager agent app, plus the minimal changes required for SreeStack to become its first managed Stack Repository. The map ends before implementation.

## Notes

- The Skill Manager is separate from SreeStack; SreeStack is the first real Stack Repository it manages. Caddie may be invoked from any repository; the working directory sets conversational focus rather than limiting portfolio visibility.
- The product is an Agent App: the SreeStack Operator is the user interface, backed by private deterministic tools. Only Operator Bootstrap is a user-facing shell action.
- A User Stack combines with an opted-in Project Stack to form an Effective Stack.
- SreeStack can register and manage projects centrally, while each project commits its own declaration and owns genuinely project-specific skills.
- Codex is the first harness. V1 assumes Claude can share the Canonical Installation through `.claude/skills -> ../.agents/skills`; implementation must verify that assumption before release.
- Third-party sources are pinned. Updates produce Migration Proposals and require approval before state changes.
- Persist only desired state, resolved state, and semantic reasoning that would be expensive to reconstruct. Markdown is canonical for narrative decisions; structured state may point to it.
- Upstream updates default to isolated worktree and draft-PR preparation after approval. Routine link reconciliation is an in-place operation.
- Bird's-eye portfolio scans are read-only and conversational by default. Accepted recommendations may create artifacts, worktrees, or PRs.
- Use `/grilling` and `/domain-modeling` for HITL design tickets. Keep `CONTEXT.md` free of implementation details.

## Decisions so far

- [Verify Codex and Claude skill rendering](issues/01-verify-harness-rendering.md) — Codex documents directory-symlink rendering; by owner decision v1 assumes Claude can share the Canonical Installation through `.claude/skills`, with implementation verification retained as a risk.
- [Define product and repository boundaries](issues/02-define-product-and-repository-boundaries.md) — Caddie will be a separate standalone skill repository with bundled deterministic scripts; SreeStack remains its first managed Stack Repository, and managed projects own only project-coupled skills.
- [Design declared and resolved state](issues/03-design-declared-and-resolved-state.md) — One user/project-scoped manifest format declares explicit typed sources and additive skill selections; deterministic locks pin only external resolution, while optional lineage links preserve semantic origins.
- [Design safe reconciliation](issues/04-design-safe-reconciliation.md) — Caddie maintains complete scope-local `.agents/skills` installations with ledger-owned materializations, Git-backed in-place project skills, fingerprinted drift detection, atomic journals, and preservation-first adoption and unmanagement.
- [Design upstream change intelligence](issues/05-design-upstream-change-intelligence.md) — Deterministic evidence feeds agent interpretations and minimal approval-gated proposals for updates, identity changes, drift, and lineage; only expensive semantic decisions become durable narrative records.
- [Design the portfolio control room](issues/06-design-portfolio-control-room.md) — Caddie computes focused or bird's-eye views live from all managed repositories; cwd affects ranking rather than visibility, reports stay conversational, and plain “registered projects” language replaces portfolio jargon.
- [Design agent tool contracts](issues/07-design-agent-tool-contracts.md) — One JSON agent entrypoint autonomously gathers bounded evidence, delegates semantic and authoring work through Caddie's skill flow, and permits mutations only through exact versioned, preconditioned, approval-gated plans.
- [Design cross-repository change workflow](issues/08-design-cross-repository-change-workflow.md) — Approved Change Sets prepare isolated worktrees before GitHub-first draft PR publication, respect dependency waves and exact remote state, and fall back to local branches or isolated sandboxes when Git hosting is unavailable.
- [Design bootstrap and adoption](issues/09-design-bootstrap-and-adoption.md) — One temporary fetch bootstraps Caddie into managing itself; conversational adoption connects an existing repo or minimal non-Git User Stack, safely replaces verified Vercel state, and registers projects implicitly on their first approved management action.
- [Validate the Caddie name](issues/11-validate-caddie-name.md) — A same-category project and occupied package names were found; the owner explicitly accepts the collision and keeps Caddie as the unqualified name and namespace.
- [Define the specification handoff](issues/10-define-specification-handoff.md) — The v1 handoff fixes source and composition boundaries, versioning and naming, preservation-first invariants, departure behavior, and an end-to-end acceptance suite.

## Not yet specified

The route to the destination is clear; no in-scope design fog remains.

## Out of scope

- Implementing the Manager, Operator, or bootstrap during this map.
- Building a human-facing interactive CLI or terminal picker.
- Creating a package registry, hosted service, or general dependency solver.
- Automatically merging pull requests or applying semantic migrations without user approval.
- Persisting dashboards or periodic portfolio snapshots by default.
- A public source-adapter framework, manifest inheritance/includes, or composition beyond one User Stack plus an additive Project Stack in v1.
- Licensing advice, redistribution judgments, or attribution enforcement for third-party skills; those remain repository-owner responsibilities.
