# Caddie Tool protocol

Caddie v1 uses one JSON request on standard input and emits exactly one JSON response envelope on standard output. The protocol version is `1`.

Requests contain `version`, `operation`, and operation-specific input. Supported operations are `locate`, `inspect`, `inspect-source`, `compare`, `plan`, `apply-plan`, and `recover`.

`inspect` supports focused Available Skills, explicit bird's-eye, and Adoption views. Exact locked Git inspection may retain a content-bound disposable materialization for reconciliation. `plan` supports reconciliation plus `adoption`, `unmanagement`, `cleanup`, `publish-git-change`, `prepare-git-change`, `prepare-change-sandbox`, `sandbox-apply`, and `publication` workflow variants. `publish-git-change` binds exact changes, validation commands, base commit, push URL, remote branch state, and draft-PR metadata; one exact approval authorizes its focused commit, leased push, and draft PR, and retrying that plan resumes the same verified branch. Publication plans for already prepared Change Sets bind the repository, remote destination, exact base and head commits, and expected remote branch state. One approval publishes only the dependency-free wave. Later waves must be prepared and planned again after their dependencies merge so consumer locks bind final merged commits. Every mutating `apply-plan` request carries approval bound to the exact returned plan identifier.

Successful envelopes contain `version`, `ok: true`, `operation`, `result`, and explicit `coverage`. Failed envelopes contain `version`, `ok: false`, `operation` when known, and an `error` with a stable code, message, and one disposition: `retry`, `replan`, `needs-user`, `needs-permission`, `invalid`, or `bug`.

Diagnostics belong on standard error. Persisted formats have their own version fields and are never silently rewritten during inspection.

User-scope Adoption and reconciliation plans include individual links from the actual runtime-HOME Codex and Claude skill roots to the configured canonical User Skills. Project Skills remain canonical in the project `.agents/skills` and receive only the Claude compatibility link. These fixed harness paths are bound by the immutable plan and revalidated during apply and recovery.

`npm run test:release` is the harness and end-to-end release gate. It requires installed Codex and Claude Code binaries rather than silently skipping harness discovery; the compatibility decision is recorded in [ADR 0001](adr/0001-expose-individual-skills-to-claude.md).

Bounded `inspect-source` evidence includes a deterministic `sha256:` cache reference. When file entries remain, coverage also includes a continuation cursor bound to the exact source fingerprint and the original evidence limits. Continue with the same request and limits plus `cursor`; changed content requires replanning and changed limits are invalid.
