# Caddie Tool protocol

Caddie v1 uses one JSON request on standard input and emits exactly one JSON response envelope on standard output. The protocol version is `1`.

Requests contain `version`, `operation`, and operation-specific input. Supported operations are `locate`, `inspect`, `inspect-source`, `compare`, `plan`, `apply-plan`, and `recover`.

`inspect` supports focused Available Skills, explicit bird's-eye, Adoption, `migration`, and `legacy-manager` views. Exact locked Git inspection may retain a content-bound disposable materialization for reconciliation. `plan` supports reconciliation plus `skill-enablement`, `adoption`, `unmanagement`, `cleanup`, `state-migration`, and `legacy-manager-cleanup` workflow variants. Every mutating `apply-plan` request carries approval bound to the exact returned plan identifier.

The protocol manages only Caddie-owned state. Repository authoring, worktrees, validation commands, commits, pushes, and pull requests remain ordinary agent work and are not Caddie Tool operations. See [ADR 0002](adr/0002-leave-repository-workflows-to-agents.md).

Successful envelopes contain `version`, `ok: true`, `operation`, `result`, and explicit `coverage`. Failed envelopes contain `version`, `ok: false`, `operation` when known, and an `error` with a stable code, message, and one disposition: `retry`, `replan`, `needs-user`, `needs-permission`, `invalid`, or `bug`.

Diagnostics belong on standard error. Persisted formats have their own version fields and are never silently rewritten during inspection.

User reconciliation materializes complete skills directly beneath the runtime HOME `~/.agents/skills`; project reconciliation materializes them beneath `<project>/.agents/skills`. Adoption records exact existing directories at those locations without relocating them. Both scopes add only individual Claude compatibility links under the matching `.claude/skills` root. These fixed paths are bound by the immutable plan and revalidated during apply and recovery.

Skill Enablement is declared on the exact Skill Selection with an optional `enabled` boolean; inspection resolves omission to `true`. The `skill-enablement` workflow changes that declaration and delegates enforcement to native Agent Harness settings. `false` writes a Caddie-owned Codex `[[skills.config]]` entry with `enabled = false` and a Claude `skillOverrides` value of `"off"`; project scope uses `.claude/settings.local.json`, while Codex remains user-configured. `true` removes only Caddie-owned disablement. Existing external settings that already disable a skill are preserved unowned, and conflicting or drifted settings block the plan. Harness-specific invocation modes remain outside Caddie's model.

Every materialized or adopted skill must have valid Agent Skills `name` and `description` fields and valid values for any standard optional fields it declares. Client-specific frontmatter extensions are preserved unchanged and reported as `extensionFields`; they do not make otherwise valid upstream skills unavailable. During inspection, a Project Skill deterministically shadows a same-named User Skill; the effective skill list contains the project selection and `shadowedSkills` preserves explicit evidence of both selections.

All Caddie mutations at the standard user root, user Claude compatibility root, or user registry serialize on one runtime-HOME lock and reserve recovery before publishing the scope journal. The fixed coordination files are `~/.agents/.caddie/user-mutation.lock` and `user-operation.json`; they are machine-local state, not plan effects. Ordinary exposure never replaces existing regular Claude content.

Migration and legacy-manager cleanup are deliberately separate. `state-migration` is the only workflow allowed to remove the fixed legacy Caddie state root after copying supported state. `legacy-manager-cleanup` is the only workflow allowed to remove `~/.agents/.skill-lock.json`, and only when every entry is proven to be either represented by the current Caddie ledger with an exact installed fingerprint or obsolete because no installation remains. Malformed, conflicting, or unmanaged live entries block removal.

`npm run test:release` is the harness and end-to-end release gate. It requires installed Codex and Claude Code binaries rather than silently skipping harness discovery; the compatibility decision is recorded in [ADR 0001](adr/0001-expose-individual-skills-to-claude.md).

Bounded `inspect-source` evidence includes a deterministic `sha256:` cache reference. When file entries remain, coverage also includes a continuation cursor bound to the exact source fingerprint and the original evidence limits. Continue with the same request and limits plus `cursor`; changed content requires replanning and changed limits are invalid.
