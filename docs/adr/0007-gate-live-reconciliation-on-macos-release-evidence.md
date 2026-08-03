# Gate live reconciliation on macOS release evidence

## Status

Accepted.

## Context

The current Caddie Skill and Tool already support user-triggered inspection, exact plans, approval, apply, verification, and Recovery. Their tests use isolated homes and projects, and the release gate verifies discovery with installed Codex and Claude. The current GitHub job runs the Tool tests on Linux, while the stricter Agent Harness gate runs only when called on a machine with both clients.

The Mac app adds new risk at a smaller set of seams: app-triggered standing authorization, file observation, child-process control, Tool activation, app updates, login, folder access, notifications, and Agent Handoff. Repeating every existing Caddie workflow by hand would add cost without better proof. Allowing the new automatic path to write live User Skills without testing these seams would leave the main new risks unchecked.

## Decision

Make macOS the only release verification platform. Run the full Tool suite on macOS and add the Mac app, App–Tool, packaged-release, and real Agent Harness checks there. Linux results do not form part of the release contract.

Keep the deep Caddie management module as the main test surface. Run the same version 2 `status`, `cycle`, and `act` contract through an in-process Adapter and the real child-process Adapter. Keep real Codex and Claude discovery in the release gate. Add app tests at the file-events, Tool-process, Tool-release, login-item, folder-access, notification, Agent Handoff, update, clock, and ID seams. Production and test Adapters must cross the same Interfaces.

Every release that may reconcile live User Skills needs a Release Verification Record bound to its commit, release ID, app version, Tool version and fingerprint, Node version and fingerprint, Skill version, protocol versions, state-format range, signed artifact hash, and appcast entry. Missing required evidence blocks live reconciliation.

### Automated state and compatibility gate

Test Bootstrap with:

- no prior Caddie state;
- the current installed Caddie state;
- the supported legacy state root;
- unfinished Recovery;
- malformed state; and
- an unsupported newer state version.

The first three cases must preserve or adopt state as specified. Unfinished Recovery must offer exact Finish and Roll back choices. Malformed or unsupported state must remain unchanged and block unsafe work.

Test the current and prior supported Skill, Tool, protocol, and state pairings. A new Tool must serve the prior Skill, a new Skill must remain usable with the last-good Tool, and the last-good Tool must read any state written before new release activation completes.

### Failure gate

Inject and verify at least:

- missing, untrusted, or fingerprint-mismatched Tool files;
- child-process launch failure, timeout, invalid or incomplete JSON, and ignored graceful stop;
- process death after each durable mutation or Tool-release switch step;
- lock contention and concurrent calls from the Skill and app;
- source or destination changes after inspection;
- folder permission loss;
- dropped, grouped, or root-changed file events;
- failure before and after Tool Launch Record activation;
- app update while Tool work is active; and
- notification or Agent Handoff delivery failure.

After process death, restart must find either a proved clean result or one valid Recovery with exact Finish and Roll back actions. Failure injection must prove expected paths changed and unrelated paths did not.

### Packaged-release gate

Use the exact signed release distributed to users. Verify Developer ID signatures, Hardened Runtime, notarization, stapling, Sparkle's update signature, and release hashes. Exercise Homebrew Cask and disk-image installation, both supported Applications folders, first launch, login-item registration and revocation, exact-folder access and denial, Sparkle update from the prior release, Tool fallback, App Removal, reinstall, and preserved user and project Caddie State Roots.

For personal rollout, run the real workflow on the owner's current Mac and macOS version. Before claiming public macOS 13 support, run the same acceptance check on macOS 13. Run the full packaged check for the first release and any later change to installation, update, state, compatibility, or Recovery. Routine UI or Skill releases may use a shorter signed-release smoke check when their changes cannot affect those paths.

### Live rollout gate

Start the signed release against the owner's existing setup in `observe-only` mode. Compare its Caddie Snapshot with a current Caddie Skill inspection. Cover app launch, login, sleep and wake, one committed local source change, one blocked folder, and one uncertain file-event signal. Repeated observation must make no managed-state changes.

Then grant Reconciliation Authorization to one low-risk existing User Skill. Prove one eligible committed change reconciles and verifies, and prove one unsafe change remains unchanged with correct Attention. Further User Skills opt in one at a time. Project Skills remain status-only. A separate disposable live canary is not required for the personal rollout.

### Pause and stop rules

Provide a global Reconciliation Pause, shown in the app as **Pause Automatic Updates**. It stops standing-authorized writes without removing any per-skill Reconciliation Authorization. Inspection, status, the Caddie Skill, and explicitly approved work remain available.

A wrong branch, dirty selected path, missing source, or denied folder pauses only the affected Skill Selection and creates or refreshes its Attention. Other independently eligible selections may continue.

A Tool trust or compatibility failure, invalid Recovery, failed verification, unowned write, or corrupt shared state starts a global Reconciliation Pause. Restarting the app does not clear it. Resume requires a successful full inspection and an explicit user action. A presentation or notification failure does not block correct reconciliation when durable Attention remains accurate and visible in the app.

### Evidence

Attach the Release Verification Record to the exact GitHub Release. Record commands or workflows, expected and observed results, before-and-after fingerprints, intended path effects, proof that unrelated inspected paths stayed unchanged, remaining Attention or Recovery, and links to automated runs. Remove real repository paths, Skill content, credentials, and other private data.

## Consequences

The rollout tests only the new app authority and lifecycle risks by hand while retaining the current Tool suite as the broad safety proof. One signed build moves through automated, packaged, observe-only, and low-risk live gates before wider opt-in.

Release work now needs a macOS runner, real Codex and Claude checks, signed-package verification, failure hooks at durable steps, and a repeatable manual record. Some faults pause more work than their immediate subject, but only when Caddie cannot trust shared execution or state.
