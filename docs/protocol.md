# Caddie Tool protocol

Caddie v1 uses one JSON request on standard input and emits exactly one JSON response envelope on standard output. The protocol version is `1`.

Requests contain `version`, `operation`, and operation-specific input. Supported operations are `locate`, `inspect`, `inspect-source`, `compare`, `plan`, `apply-plan`, and `recover`.

`inspect` supports focused Available Skills, explicit bird's-eye, and Adoption views. `plan` supports reconciliation plus `adoption`, `unmanagement`, `cleanup`, `sandbox-apply`, and `publication` workflow variants. Every mutating `apply-plan` request carries approval bound to the exact returned plan identifier.

Successful envelopes contain `version`, `ok: true`, `operation`, `result`, and explicit `coverage`. Failed envelopes contain `version`, `ok: false`, `operation` when known, and an `error` with a stable code, message, and one disposition: `retry`, `replan`, `needs-user`, `needs-permission`, `invalid`, or `bug`.

Diagnostics belong on standard error. Persisted formats have their own version fields and are never silently rewritten during inspection.
