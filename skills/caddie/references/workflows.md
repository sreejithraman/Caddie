# Workflow branches

## Adoption

Use `plan.workflow: "adoption"` with exact-match Adoption evidence. Preserve modified, unknown, colliding, and permission-blocked entries. A user-scope adoption keeps each real directory under `~/.agents/skills` and adds its Claude compatibility link.

Treat legacy manager state as evidence and preserve it during Adoption.

## State migration

When `locate` reports `legacy-state-present`, call `inspect` with `view: "migration"`.

- `absent`: do nothing.
- `collision`: preserve both locations, report every collision, and do not plan.
- invalid or unsupported evidence: preserve it and report the blocker.
- `ready`: call `plan` with `workflow: "state-migration"`.

Present the source and destination paths, local-source rebasing, preconditions, and fingerprint-bound removal of the legacy Caddie tree with the Caddie Plan. Apply through that plan, then run normal inspection and confirm `~/.config/caddie` is absent. Preserve every external legacy document named by the plan.

## Legacy manager cleanup

Use `inspect` with `view: "legacy-manager"` for `~/.agents/.skill-lock.json`.

- `absent`: do nothing.
- `unsupported`, `unverified`, or `blocked`: preserve the lock and report each finding.
- `ready` with `removalRecommended: true`: call `plan` with `workflow: "legacy-manager-cleanup"`.

Use the dedicated cleanup Caddie Plan as the only lock-removal path. Present its manifest and ledger preconditions, lock fingerprint, and entry classifications. Apply it separately from Adoption when the user requested this destructive outcome, then verify both the lock's absence and the unchanged managed skills. Preserve any lock containing an unmanaged installed skill or fingerprint conflict.

## Unmanagement and cleanup

By default, use `unmanagement` to remove Caddie ownership and registration while retaining Materialized Skills and Agent Harness exposure.

When the user explicitly requests ending management and removing skills together, include the requested Materialized Skills and Claude exposure cleanup in the same complete `unmanagement` Caddie Plan. Use `cleanup` only as a destructive follow-up after an earlier Unmanagement preserved those files. Reserve state migration and legacy-manager state for their dedicated workflows.
