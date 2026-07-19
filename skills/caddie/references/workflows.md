# Workflow branches

## Skill enablement

Use `plan.workflow: "skill-enablement"` with the exact scope, `{ "source", "path" }` Skill Selection, and an `enabled` boolean. Caddie derives the skill name from resolved selection or Ledger evidence.

- Omitted manifest state and `true` both mean enabled. The workflow writes the canonical form by omitting `enabled` when enabling.
- `false` keeps the Skill Selection resolved, installed, updateable, and linked for compatibility. It asks Codex and Claude Code to disable the skill through their native settings.
- `true` removes only disablement recorded as Caddie-owned in the Caddie Ledger; external harness policy remains unchanged.
- A native setting that already provides the desired disablement remains unowned. A conflicting setting or drift in a Caddie-owned setting blocks planning.
- Richer Claude invocation modes and other harness policy remain native settings outside the Caddie Manifest.
- Reconciliation derives enablement from the desired Caddie Manifest so initial materialization and later updates configure harnesses atomically.

Present the manifest change, native settings paths, ownership effects, and harness reload expectations in the Caddie Plan. This branch is complete when post-apply `inspect` reports the requested `enabled` value and the closest native harness surface confirms the same availability. Restart or reload Codex when its current session predates the setting.

## Adoption

Use `plan.workflow: "adoption"` with exact-match Adoption evidence. Preserve modified, unknown, colliding, and permission-blocked entries. A user-scope adoption keeps each real directory under `~/.agents/skills` and adds its Claude compatibility link.

Treat legacy manager state as evidence owned by its dedicated cleanup branch.

This branch is complete when post-apply inspection records every approved exact match while every modified, unknown, colliding, and permission-blocked installation is unchanged.

## State migration

When `locate` reports `legacy-state-present`, call `inspect` with `view: "migration"`.

- `absent`: do nothing.
- `collision`: preserve both locations, report every collision, and do not plan.
- invalid or unsupported evidence: preserve it and report the blocker.
- `ready`: call `plan` with `workflow: "state-migration"`.

Present the source and destination paths, local-source rebasing, preconditions, and fingerprint-bound removal of the legacy Caddie tree with the Caddie Plan. Apply through that plan, then run normal inspection and confirm `~/.config/caddie` is absent. Preserve every external legacy document named by the plan.

This branch is complete when normal inspection reads the migrated fixed-root state, `~/.config/caddie` is absent, and every preserved external document still matches its pre-migration evidence.

## Legacy manager cleanup

Use `inspect` with `view: "legacy-manager"` for `~/.agents/.skill-lock.json`.

- `absent`: do nothing.
- `unsupported`, `unverified`, or `blocked`: preserve the lock and report each finding.
- `ready` with `removalRecommended: true`: call `plan` with `workflow: "legacy-manager-cleanup"`.

Use the dedicated cleanup Caddie Plan as the only lock-removal path. Present its manifest and ledger preconditions, lock fingerprint, and entry classifications. Apply it separately from Adoption when the user requested this destructive outcome, then verify both the lock's absence and the unchanged managed skills. Preserve any lock containing an unmanaged installed skill or fingerprint conflict.

This branch is complete when inspection confirms the lock is absent and every managed skill still matches its pre-cleanup evidence.

## Unmanagement and cleanup

By default, use `unmanagement` to remove Caddie ownership and registration while retaining Materialized Skills and Agent Harness exposure.

When the user explicitly requests ending management and removing skills together, include the requested Materialized Skills and Claude exposure cleanup in the same complete `unmanagement` Caddie Plan. Use `cleanup` only as a destructive follow-up after an earlier Unmanagement preserved those files. Reserve state migration and legacy-manager state for their dedicated workflows.

When combined Unmanagement removes a disabled skill, remove its Caddie-owned native harness disablement before removing the Caddie Ledger. Preservation-only Unmanagement leaves native harness policy in place and relinquishes ownership with the rest of the Ledger.

Unmanagement is complete when Caddie ownership and registration are absent while Materialized Skills and Agent Harness exposure remain. Cleanup is complete when only the exactly approved matching skills and exposure are absent.
