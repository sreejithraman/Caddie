# Define the specification handoff

Type: grilling
Status: resolved
Blocked by: 06, 08, 09

## Question

What decisions, scenarios, compatibility commitments, safety invariants, and acceptance criteria must the final agent-ready specification contain before implementation can begin?

## Answer

The implementation specification must synthesize the resolved map tickets as normative product behavior, not merely link to them. It must define the User Stack, Project Stack, Effective Stack, Stack Manifest, Resolution Lock, Canonical Installation, ledger, operation journal, registered-project registry, Migration Proposal and Record, Change Set, and Change Sandbox using the shared domain language in `CONTEXT.md`.

Caddie v1 supports only explicit `local` and `git` sources. The implementation should keep Git-specific behavior behind an internal seam, but v1 has no public source-adapter or plugin contract. Composition is limited to one User Stack plus an optional additive Project Stack: manifests have no inheritance, includes, shared fragments, or general dependency-solving behavior.

Caddie is distributed as a Git-hosted skill repository with no required package-registry release. Releases use semantic versions. The Stack Manifest, Resolution Lock, ledger, plan, and agent-tool protocol carry their own explicit format versions. Inspection never silently rewrites an older format; required migrations are exact, approval-gated plans. Before Caddie 1.0, minor releases may break compatibility; after 1.0, incompatible persisted-format or agent-contract changes require a major release.

Public artifacts are named `caddie.json` (Caddie Manifest), `caddie.lock` (Caddie Lock), `.agents/.caddie/ledger.json` (Caddie Ledger), and `bootstrap` (the repository's sole user-facing script). Installation documentation may expose a one-command bootstrap that obtains a pinned release; the hosting URL and exact shell spelling are release details rather than persisted contracts.

Licensing policy, redistribution judgments, and attribution enforcement are repository-owner responsibilities and are outside Caddie's product boundary. Caddie faithfully preserves selected skill contents and source identity; it does not act as a license checker.

Unmanaging a project removes Caddie's registration and ownership state while preserving its installed skill copies and working harness exposure by default. Removing those artifacts is a separate explicit cleanup operation, so departure from Caddie cannot silently break the harness.

The specification must make the preservation-first safety invariants testable: read-only operations do not mutate or register; mutations require an immutable versioned plan bound to exact preconditions and approval; installed or authored content is never silently overwritten or deleted; name collisions fail; scope mutations are atomic and serialized; interrupted operations are recoverable; Git edits occur in isolated worktrees based on a freshly fetched exact base; partial or stale evidence is labeled; and semantic migrations never apply automatically.

V1 is accepted only when an end-to-end suite demonstrates bootstrap into an empty user setup, safe adoption of SreeStack, User and Project Stack composition, exact complete copies under `.agents/skills` with Claude sharing that tree through `.claude/skills`, non-Git drift detection, an upstream identity change such as `to-prd` to `to-spec`, an approval-gated isolated-worktree update, interrupted-operation recovery, a bird's-eye report across registered projects, and project unmanagement that leaves installed skills usable.
