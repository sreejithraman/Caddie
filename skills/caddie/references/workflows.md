# Workflow branches

## Adoption

Use `plan.workflow: "adoption"` with exact-match Adoption evidence. Preserve modified, unknown, colliding, and permission-blocked entries. A user-scope adoption keeps each real directory under `~/.agents/skills` and adds its Claude compatibility link.

Treat legacy manager state as evidence. Adoption never removes it.

## State migration

When `locate` reports `legacy-state-present`, call `inspect` with `view: "migration"`.

- `absent`: do nothing.
- `collision`: preserve both locations, report every collision, and do not plan.
- invalid or unsupported evidence: preserve it and report the blocker.
- `ready`: call `plan` with `workflow: "state-migration"`.

Present the exact plan identifier, its source and destination paths, local-source rebasing, preconditions, and the fingerprint-bound removal of the legacy Caddie tree. Apply only after approval bound to that plan. Then run normal inspection and confirm `~/.config/caddie` is absent. Never migrate with shell moves, copies, or deletion commands, and never remove external legacy documents that the plan reports as preserved.

## Legacy manager cleanup

Use `inspect` with `view: "legacy-manager"` for `~/.agents/.skill-lock.json`.

- `absent`: do nothing.
- `unsupported`, `unverified`, or `blocked`: preserve the lock and report each finding.
- `ready` with `removalRecommended: true`: call `plan` with `workflow: "legacy-manager-cleanup"`.

Only the dedicated cleanup plan may remove the lock. Present its exact identifier, manifest and ledger preconditions, lock fingerprint, and entry classifications before requesting approval. Apply it separately from Adoption and verify both the lock's absence and the unchanged managed skills afterward. Never remove a lock containing an unmanaged installed skill or a fingerprint conflict.

## Unmanagement and cleanup

Use `unmanagement` to remove Caddie ownership and registration while retaining Materialized Skills and Agent Harness exposure.

Use `cleanup` as a separate destructive follow-up for Materialized Skills and Claude exposure, with its own exact approval. Do not use it for Caddie state migration or legacy-manager state.
