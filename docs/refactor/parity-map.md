# Refactor behavior parity

This map fixes the behavior that refactor work must keep. A refactor may change
private structure. It must not change these interfaces, stored forms, safety
rules, or user flows.

For each pass, record:

- the current behavior;
- the private structure that will change; and
- the focused check plus the full gate that proves parity.

Treat a Tool protocol change, stored-format change, dependency upgrade,
framework move, or release-compatibility change as a separate migration. Do not
hide one in a refactor.

## Current baseline

The local baseline recorded on 2026-08-20 is:

- `swift test --package-path app/CaddieReleaseRuntime` passed 132 tests.
- `npm test` passed 306 tests and skipped 2 after `npm ci` installed the locked
  development packages. All vendor checks passed.
- The real Agent Harness gate, macOS release draft, signed-package checks, and
  live rollout checks have not run. Do not claim release qualification from
  this baseline.

Before the first production refactor, run:

```sh
npm ci
npm test
swift test --package-path app/CaddieReleaseRuntime
```

Record the test counts, skipped tests, Node version, Swift version, commit, and
clean-tree state. Use `npm run test:release` only on a Mac with installed Codex
and Claude Code. Use `npm run verify:mac -- --output release-verification.json`
for a macOS draft. That draft does not replace the signed-package and human
checks in [ADR 0007](../adr/0007-gate-live-reconciliation-on-macos-release-evidence.md).

## Fixed behavior

| Area | Current behavior to keep | Focused parity check |
| --- | --- | --- |
| Tool protocol 2 | The Caddie Skill and Caddie Mac App use `status`, `cycle`, and `act`. Requests bind version, request ID, caller, operation, and input. `cycle` and `act` bind idempotency. `status` reads the last committed Caddie Snapshot without inspection or a write. | `node --test test/management-v2-*.test.mjs test/adapter-contract.test.mjs` |
| Tool protocol 1 | The prior Caddie Skill may use only the fixed v1 operation set. The bridge keeps v1 plan validation, approval binding, apply, and Recovery rules. Protocol 2 callers cannot enter this lane. Tool protocol 2 is the last version with this bridge; protocol 3 must remove it. | `node --test test/tool-contract.test.mjs test/v1-acceptance.test.mjs test/safe-mutations.test.js` |
| Persisted v1 scope state | Caddie Manifest, Caddie Lock, Caddie Ledger, and Caddie Registry stay at version 1 and at the fixed Caddie State Roots. Inspection does not rewrite them. State migration stays explicit and preservation-first. | `node --test test/standard-layout.test.mjs test/state-migration.test.mjs test/registry-tool.test.mjs` |
| Persisted v2 management state | `management-v2.json` stays version 2. The Tool checks the whole file before use and writes it atomically. Malformed and newer state stay unchanged. The inventory projection remains separate and bound to a Caddie Snapshot revision. Prior state and receipt fixtures remain readable. | `node --test test/management-v2-*.test.mjs` |
| Caddie Plan apply and Recovery | Every write uses an immutable approved plan, rechecks preconditions, records recovery before publishing owned state, writes the Caddie Ledger last where required, and ends in a proved result or exact Finish and Roll back choices. Unowned and unrelated paths stay unchanged. | `node --test test/safe-mutations.test.js test/skill-rename.test.mjs test/state-migration.test.mjs test/user-skill-adoption.test.mjs` |
| Adapter parity | In-process and child-process Adapters serve the same protocol 2 results and Tool errors. The child-process Adapter also keeps its fixed time, output, stop, and retry bounds. | `node --test test/adapter-contract.test.mjs` |
| Caddie Snapshot and paging | The Tool owns the full Caddie Snapshot. Detail lists stay bounded. Continuation tokens bind the revision, field, and offset; changed Snapshots make old tokens stale and changed tokens invalid. The app decodes the saved state and matching inventory projection without joining domain state itself. | `node --test test/management-v2-*.test.mjs && swift test --package-path app/CaddieReleaseRuntime --filter PreviewSnapshotTests` |
| Caddie Release runtime | One checked Caddie Release binds the app, private Node, Tool, source Skill, protocol range, and state range. Activation switches the Tool Launch Record only after stage checks and the first `status`. Failure before managed-state work restores the last-good Tool. Cleanup keeps active, last-good, and leased releases. | `node --test test/release-launcher.test.mjs && swift test --package-path app/CaddieReleaseRuntime --filter CaddieReleaseRuntimeTests` |
| Caddie Mac App flows | Opening the menu reads cached state. Scheduling keeps one cycle active and coalesces hints. Pause Automatic Updates stops standing-authorized writes, not inspection or explicit work. Actions remain request, invoke, then outside-effect reporting. Notifications and Agent Handoff need a user action and durable Tool state. Bootstrap, login, and App Removal preserve Caddie State Roots. | `swift test --package-path app/CaddieReleaseRuntime` |

Run `npm test` after every Tool pass and the full Swift command after every app
or shared-contract pass. Run both for changes at the App–Tool Interface.

## Stored-form fixtures

Keep these fixtures as fixed reads during refactors:

- `test/fixtures/prior-v2-management-state.json`;
- `test/fixtures/prior-v2-agent-handoff-receipt.json`; and
- `test/fixtures/c5115ad-artifact-manifest.json`.

Add a golden request or response only when the current tests do not bind a
public serialized form. Prefer field and behavior checks when byte order is not
part of the interface.

## Pass record

Use this short form in each refactor pull request:

```text
Current behavior:
Private structural change:
Focused parity check:
Full gate:
Migration work left out:
```

Stop the pass if the focused check changes a public response, stored file, path
effect, error code or disposition, Caddie Snapshot count, user-visible action,
or release binding. Either restore parity or open a separate migration with its
own spec and compatibility checks.
