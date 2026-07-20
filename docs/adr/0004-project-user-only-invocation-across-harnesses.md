# Project user-only invocation across Agent Harnesses

Agent Harnesses express explicit-only skill invocation differently. Codex uses
`agents/openai.yaml` with `policy.allow_implicit_invocation: false`; other
harnesses commonly use `disable-model-invocation: true` in `SKILL.md`.
Preserving source bytes therefore does not guarantee that a user's invocation
choice is consistent across every harness that discovers the same canonical
skill.

Caddie adds an optional `invocation: "user-only"` field to a Skill Selection.
The field is a cross-harness **Invocation Policy**, not source authorship. When
present, Caddie projects the selected skill into a disposable effective source:

- `SKILL.md` has `disable-model-invocation: true`.
- `agents/openai.yaml` has `policy.allow_implicit_invocation: false`.

The original Skill Source is never modified. The effective projected directory
is fingerprinted, materialized, recorded in the Caddie Ledger, and used for
future reconciliation, so an unchanged source and policy remain `unchanged`
rather than appearing as Drift or Divergence. Exact plans continue to copy one
fully prepared source directory; projection occurs before planning and is bound
by the same disposable-source lease and fingerprint checks as exact Git
materialization.

An absent Invocation Policy preserves source behavior exactly. Caddie reports
the source declarations for each harness so the Caddie Skill can identify a
one-sided declaration and propose `user-only`; the Tool does not infer or apply
that semantic choice automatically.

This decision extends ADR 0001's Agent Harness compatibility model from
discovery links to invocation metadata. It does not move repository authoring
inside the Caddie Tool and therefore does not supersede ADR 0002.
