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

Present the human-readable Caddie Plan title, its source and destination paths, local-source rebasing, preconditions, and the fingerprint-bound removal of the legacy Caddie tree. Keep the exact identifier as the internal approval binding. Apply only after approval of the titled Caddie Plan. Then run normal inspection and confirm `~/.config/caddie` is absent. Never migrate with shell moves, copies, or deletion commands, and never remove external legacy documents that the Caddie Plan reports as preserved.

## Legacy manager cleanup

Use `inspect` with `view: "legacy-manager"` for `~/.agents/.skill-lock.json`.

- `absent`: do nothing.
- `unsupported`, `unverified`, or `blocked`: preserve the lock and report each finding.
- `ready` with `removalRecommended: true`: call `plan` with `workflow: "legacy-manager-cleanup"`.

Only the dedicated cleanup Caddie Plan may remove the lock. Present its human-readable title, manifest and ledger preconditions, lock fingerprint, and entry classifications before requesting approval; keep its exact identifier internal. Apply it separately from Adoption and only when the user requested this destructive outcome, then verify both the lock's absence and the unchanged managed skills. Never remove a lock containing an unmanaged installed skill or a fingerprint conflict.

## Unmanagement and cleanup

By default, use `unmanagement` to remove Caddie ownership and registration while retaining Materialized Skills and Agent Harness exposure.

When the user explicitly requests ending management and removing skills together, include the requested Materialized Skills and Claude exposure cleanup in the same complete `unmanagement` Caddie Plan and ask for one approval. Use `cleanup` only as a destructive follow-up after an earlier Unmanagement preserved those files. Do not use either workflow for Caddie state migration or legacy-manager state.
