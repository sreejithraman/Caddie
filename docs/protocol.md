# Caddie Tool protocol

Caddie v1 uses one JSON request on standard input and emits exactly one JSON response envelope on standard output. The protocol version is `1`.

Requests contain `version`, `operation`, and operation-specific input. Supported operations are `locate`, `inspect`, `inspect-source`, `compare`, `plan`, `apply-plan`, and `recover`.

`inspect` supports focused Available Skills, explicit bird's-eye, and Adoption views. Exact locked Git inspection may retain a content-bound disposable materialization for reconciliation. `plan` supports reconciliation plus `adoption`, `unmanagement`, `cleanup`, `publish-git-change`, `prepare-git-change`, `prepare-change-sandbox`, `sandbox-apply`, and `publication` workflow variants. `publish-git-change` binds exact changes, validation commands, base commit, push URL, remote branch state, and draft-PR metadata; one exact approval authorizes its focused commit, leased push, and draft PR, and retrying that plan resumes the same verified branch. Publication plans for already prepared Change Sets bind the repository, remote destination, exact base and head commits, and expected remote branch state. One approval publishes only the dependency-free wave. Later waves must be prepared and planned again after their dependencies merge so consumer locks bind final merged commits. Every mutating `apply-plan` request carries approval bound to the exact returned plan identifier.

Successful envelopes contain `version`, `ok: true`, `operation`, `result`, and explicit `coverage`. Failed envelopes contain `version`, `ok: false`, `operation` when known, and an `error` with a stable code, message, and one disposition: `retry`, `replan`, `needs-user`, `needs-permission`, `invalid`, or `bug`.

Diagnostics belong on standard error. Persisted formats have their own version fields and are never silently rewritten during inspection.

User reconciliation materializes complete skills directly beneath the runtime HOME `~/.agents/skills`; project reconciliation materializes them beneath `<project>/.agents/skills`. Adoption records exact existing directories at those locations without relocating them. Both scopes add only individual Claude compatibility links under the matching `.claude/skills` root. These fixed paths are bound by the immutable plan and revalidated during apply and recovery.

Every materialized or adopted skill must have Agent Skills-conforming `SKILL.md` frontmatter. During inspection, a Project Skill deterministically shadows a same-named User Skill; the effective skill list contains the project selection and `shadowedSkills` preserves explicit evidence of both selections.

All Caddie mutations at the standard user root or user Claude compatibility root serialize on one runtime-HOME lock and reserve recovery before publishing the scope journal, even when their User Skills manifests live in different repositories. The fixed coordination files are `~/.agents/.caddie/user-mutation.lock` and `user-operation.json`; they are machine-local state, not plan effects. Ordinary exposure never replaces existing regular Claude content.

`npm run test:release` is the harness and end-to-end release gate. It requires installed Codex and Claude Code binaries rather than silently skipping harness discovery; the compatibility decision is recorded in [ADR 0001](adr/0001-expose-individual-skills-to-claude.md).

Bounded `inspect-source` evidence includes a deterministic `sha256:` cache reference. When file entries remain, coverage also includes a continuation cursor bound to the exact source fingerprint and the original evidence limits. Continue with the same request and limits plus `cursor`; changed content requires replanning and changed limits are invalid.
