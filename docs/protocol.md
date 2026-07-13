# Caddie Tool protocol

Caddie v1 uses one JSON request on standard input and emits exactly one JSON response envelope on standard output. The protocol version is `1`.

Requests contain `version`, `operation`, and operation-specific input. Supported operations are `locate`, `inspect`, `inspect-source`, `compare`, `plan`, `apply-plan`, and `recover`.

`inspect` supports focused Available Skills, explicit bird's-eye, and Adoption views. Exact locked Git inspection may retain a content-bound disposable materialization for reconciliation. `plan` supports reconciliation plus `adoption`, `unmanagement`, `cleanup`, `prepare-git-change`, `prepare-change-sandbox`, `sandbox-apply`, and `publication` workflow variants. Publication plans bind the repository, remote destination, exact base and head commits, and expected remote branch state; their approved `apply-plan` path revalidates that evidence before a leased push or GitHub draft-PR creation. One approval publishes only the dependency-free wave. Later waves must be prepared and planned again after their dependencies merge so consumer locks bind final merged commits. Every mutating `apply-plan` request carries approval bound to the exact returned plan identifier.

Successful envelopes contain `version`, `ok: true`, `operation`, `result`, and explicit `coverage`. Failed envelopes contain `version`, `ok: false`, `operation` when known, and an `error` with a stable code, message, and one disposition: `retry`, `replan`, `needs-user`, `needs-permission`, `invalid`, or `bug`.

Diagnostics belong on standard error. Persisted formats have their own version fields and are never silently rewritten during inspection.
