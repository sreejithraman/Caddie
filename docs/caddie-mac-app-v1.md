# Caddie Mac App v1

## Status

Decision-complete implementation specification for the first personal-use release.

The source decisions are [Wayfind the Caddie Mac App](https://github.com/sreejithraman/Caddie/issues/25), its child issues, and ADRs 0005–0007. [CONTEXT.md](../CONTEXT.md) defines the domain language.

## Product promise

The Caddie Mac App keeps selected User Skills current from registered local sources. It detects local changes, applies only deterministic work covered by Reconciliation Authorization, supports manual sync, and makes blocked work hard to miss.

The app is the main status and notification surface. The Caddie Tool remains the source of truth for inspection, authorization, plans, writes, verification, Recovery, Attention, Activity, and Caddie Snapshots.

The app earns its install by joining machine-wide observation, safe routine reconciliation, visible status, and user-started help in one Mac menu.

## First-release scope

The first release:

- runs only on macOS;
- targets macOS 13 or later;
- keeps eligible User Skills current from registered local Git checkouts;
- shows manual Ready Work for eligible changes without Reconciliation Authorization;
- shows Project Skill status without updating Project Skills automatically;
- supports manual Sync now;
- owns durable Attention display and notification delivery;
- opens user-reviewed Codex or Claude Agent Handoff; and
- installs, updates, and repairs one compatible Caddie Release.

The first release does not:

- fetch, pull, switch, merge, or change a Git repository;
- update a Project Skill without a user action;
- manage non-Git local sources automatically;
- edit skills or repository files;
- discover or sell skills;
- start, send work to, or supervise Codex or Claude without a user action;
- support Windows or Linux;
- use a daemon or launch agent; or
- use the Mac App Store or App Sandbox.

## System shape

```text
Codex or Claude                         macOS
      |                                  |
 Caddie Skill                       Caddie Mac App
      |                                  |
      +---------- status/cycle/act -------+
                         |
                   Caddie Tool
                         |
            User and project Caddie state
```

The Caddie Skill and Caddie Mac App are callers. They do not call each other. Both invoke one app-owned Caddie Tool through the same version 2 child-process Interface.

The Skill handles conversation, semantic interpretation, and user approval. The app handles macOS events, scheduling, presentation, notifications, deep links, and its own lifecycle. The Tool hides all management rules behind `status`, `cycle`, and `act`.

## Runtime and file access

Build one native Swift menu bar app with `MenuBarExtra`. Set `LSUIElement` so the app has no Dock or app-switcher item. Register that main app with `SMAppService.mainApp` after Bootstrap. Show the login setting and direct the user to Login Items settings when macOS requires approval.

Keep the app unsandboxed. It uses the current user's normal file rights and macOS privacy controls. Never request Full Disk Access.

Use a folder picker when the user adds a new local Skill Source. Existing registered paths remain valid without being added again. When macOS denies one path, show Grant Access for that exact folder. Preserve the source registration and installed skills while the path is unavailable.

## Menu experience

Use the source-first menu from prototype Variant C.

The main list shows each registered source with:

- source name and exact checkout;
- current branch;
- selected skill count;
- current, Ready, updating, or Attention state;
- automatic-update policy; and
- the next useful action.

Opening a source shows its selected skills and all Attention. Each source card shows its open Attention count and highest-priority item.

Show Recovery and Tool-wide Attention above sources. Keep Project Skills in a separate status-only section. Opening the menu reads the cached Caddie Snapshot and last-check time; it does not start inspection.

The menu includes:

- Sync now;
- Pause Automatic Updates or Resume Automatic Updates;
- Start at login;
- Install updates automatically;
- notification settings;
- Check for Updates;
- Remove Caddie App; and
- Quit.

## Observation and scheduling

The app is the only background worker. If it is closed, no automatic check runs. The next launch performs a catch-up inspection.

Install watches from the Tool-issued watch set. For User Skills, watch:

- each exact registered local source checkout;
- its managed Materialized Skills;
- the User Caddie State Root; and
- Caddie-owned Agent Harness settings.

Treat File System Events as Observation Hints, never proof.

Run Local Source Inspection:

- when the app starts;
- when the Mac wakes;
- two seconds after relevant file events settle;
- after macOS reports dropped events or a changed watch root; and
- after source registration or source settings change.

Do not poll on a timer. Refresh Project Skill status only at app start, wake, or Sync now.

Run one cycle at a time. If another hint arrives during a cycle, mark the scheduler dirty and run once more afterward. After 30 seconds of constant events, inspect in `observe-only` mode. Do not reconcile until the source has a two-second quiet period.

Caddie's own writes may create events. Let the required verification cycle consume them. An unchanged result ends the run.

Sync now inspects all local sources and refreshes Project Skill status. It applies only User Skill changes already covered by Reconciliation Authorization.

## Reconciliation Authorization

Reconciliation Authorization is an explicit standing grant for one User Skill Selection. Store it in the User Caddie Manifest after an approved install or reconciliation proves a clean baseline.

The grant remains active until the user turns it off. Changing the source, selected path, or approved Git branch cancels it. New descendant commits on the approved branch do not.

Automatic reconciliation requires all of these facts:

- the source is one exact local Git checkout;
- the selected skill matches committed content;
- the checkout remains on the approved branch;
- the current commit descends from the last accepted commit;
- the selected path and skill identity have not changed;
- the skill passes normal validation with complete fingerprints;
- the Materialized Skill matches its last Caddie Ledger fingerprint;
- the Caddie Lock and Caddie Ledger match the accepted baseline;
- owned harness links and settings remain unchanged; and
- there is no Drift, Divergence, collision, missing content, or incomplete evidence.

Uncommitted changes inside the selected skill block automatic work. Unrelated dirty files elsewhere in the checkout do not. A disabled selected skill remains eligible and stays disabled.

The Tool may use read-only local Git checks for branch, commit, ancestry, and selected-path status. It may not contact a remote or change repository state.

An authorized reconciliation may only:

- replace the existing User Materialized Skill with the exact inspected content;
- update its Caddie Lock and Caddie Ledger records;
- preserve its current harness exposure, Skill Enablement, and Invocation Policy; and
- record the accepted source commit, update time, and installed fingerprint.

Reconcile each Skill Selection independently. One local blocker does not stop another eligible selection, even when both use the same source.

Without Reconciliation Authorization, show exact Ready Work and an Update action. One manual approval does not create standing authorization.

## App–Tool Interface

Use one versioned JSON request on standard input and one versioned JSON response on standard output. Diagnostics use standard error. The common request contains protocol version, request ID, caller kind, operation, and operation input. Caller kind never grants write authority.

### `status`

Return the last committed Caddie Snapshot. Do not inspect, run Git, prune, update freshness, or write. Return `uninitialized` before the first completed cycle. A concurrent `cycle` or `act` may leave `status` serving the prior committed Snapshot.

Time limit: five seconds.

### `cycle`

Accept one Observation Hint, Tool-issued subject or watch IDs, and one mode:

- `observe-only`; or
- `authorized-user-reconciliation`.

The app chooses mode from scheduler and Reconciliation Pause state. The Tool still decides eligibility and allowed effects.

Order each cycle:

1. Check Recovery.
2. Resolve hints to registered state.
3. Inspect local evidence.
4. Classify each Skill Selection.
5. Derive and apply independently eligible authorized User Skill work.
6. Verify each write.
7. Refresh Attention and Activity.
8. Commit and return one complete Caddie Snapshot.

`observe-only` cannot apply a plan. Project Skills cannot use standing authorization. Observation Hints and caller-supplied IDs never count as proof.

Time limit: two minutes.

### `act`

Use three closed forms:

- `request` submits domain intent and receives Tool-created pending actions;
- `invoke` performs one opaque Tool-created action with exact approval when required; and
- `report-effect` records whether the app delivered a notification or opened Agent Handoff.

`revoke-reconciliation` is the one immediate `request` exception. It reduces access, needs no source check, and does not create a pending action. All other state-changing intent follows `request` then `invoke`.

Callers never submit filesystem writes, harness-setting writes, or raw Caddie Plan operations. The Tool stores each immutable plan and returns an opaque action ID, bound state revision, exact human-facing effects, preconditions, preservation rules, Recovery effect, and approval prompt.

Retain pending actions until invoked, cancelled, superseded, or 30 days old. Always recheck live preconditions.

Time limit: five seconds.

### Snapshot and errors

Every successful call returns one full bounded Caddie Snapshot with:

- compatibility and coverage;
- revision, freshness, and full summary counts;
- Skill Sources and watch status;
- User and Project Skill status;
- Ready Work and Reconciliation Authorization;
- open and recent Attention;
- recent Activity;
- pending actions and outside effects; and
- the full Tool-issued watch set.

Use bounded pages and Tool-owned continuation tokens for large detail lists. The app may cache a Snapshot but may not merge domain changes or become a second truth.

Require idempotency IDs for `cycle` and `act`. Repeating the same ID and body returns the same logical result. Reusing an ID with different input is invalid.

One User Caddie State lock orders `cycle` and `act` from both callers. Lock contention returns `retry` with a delay.

Keep error dispositions `retry`, `replan`, `needs-user`, `needs-permission`, `invalid`, and `bug`. Expected domain states return a successful Snapshot with Ready Work, Attention, or pending actions.

On timeout, request graceful exit, wait ten seconds, then stop the process. Retry once after ten seconds. Any interrupted mutation uses Recovery.

## Attention and Activity

The Tool owns durable Attention in the User Caddie State Root. The app displays it and delivers notifications.

One Attention item represents one unresolved cause for one subject. Subjects are a Skill Selection, Skill Source, Tool, or Recovery. Its stable key combines subject identity, failure code, and blocking-condition identity. Time, display text, and retry count do not change identity.

Repeated proof of the same cause refreshes the item without opening or notifying another one. A shared source failure creates one source item with affected skills. A skill-only failure creates one skill item.

Attention states are:

1. Open.
2. Opened in Agent, still unresolved.
3. Resolved by Proof.

Users cannot dismiss an item or mark it fixed. A later inspection or verified Recovery must prove resolution. Keep resolved records for 30 days, capped at the 100 most recent. A returning proved-resolved cause opens a linked new occurrence.

Ready Work is not Attention. Verified reconciliation is Activity.

Retry inspects only the affected subject. It bypasses stable-failure suppression, not safety checks. The same blocker refreshes the existing item without another notification.

Interrupted mutation creates Recovery Attention with exact Finish and Roll back actions. Reconciliation Authorization cannot choose either action. The user must approve one, and proof must resolve the item.

## Notifications

Ask for notification permission when the first Attention item opens, after a short explanation in the app. Denial remains an app setting, not Attention. Keep all Attention visible with a Settings link.

Send one silent notification when an item opens or moves to a higher priority. Clicking opens that item in Caddie. Notifications contain no Retry or Agent Handoff actions. Per-item mute lasts until resolution.

Notify on resolution only when the user previously used Retry, Finish, Roll back, or Agent Handoff. Keep silent self-recovery in Activity.

Use stable delivery IDs. The app reports delivered, failed, or unavailable through `act`.

## Agent Handoff

Offer Agent Handoff only after a user click and only when the item has an exact readable registered checkout.

Use these provider links:

- Codex: `codex://threads/new?prompt=...&path=...`
- Claude: `claude://code/new?q=...&folder=...`

The Tool builds one bounded, self-contained prompt with Attention ID, source and skill identity, exact work folder, approved and current branch, expected and observed state, stable error code and disposition, last check, and requested task. Do not include source content, secrets, or unrelated evidence. Do not write a packet into the repository.

The app shows available providers, remembers the last choice, and opens a new filled unsent composer. The provider owns sign-in, folder confirmation, permissions, sending, and the run.

Record provider and open time only. Do not infer a thread ID, sent state, run status, or fix. Later Local Source Inspection must prove resolution. Tool, Recovery, and missing-source Attention show manual steps instead of Agent Handoff.

## Reconciliation Pause

Show the global Reconciliation Pause as Pause Automatic Updates.

The pause stops standing-authorized reconciliation without removing per-skill grants. Inspection, status, the Caddie Skill, and explicitly approved work remain available.

A wrong branch, dirty selected path, missing source, or denied folder pauses only that Skill Selection. A Tool trust or compatibility failure, invalid Recovery, failed verification, unowned write, or corrupt shared state starts the global pause.

Restart does not clear a safety-triggered pause. Resume requires successful full inspection and a user click.

The `resume-reconciliation` invoke may use the two-minute cycle limit because it must prove one full clean inspection. Its action request keeps the five-second `act` limit.

Presentation or notification failure does not block correct reconciliation when durable Attention remains accurate and visible.

## Release ownership and compatibility

One signed Caddie Release contains:

- the Caddie Mac App;
- a private Node 22-or-newer runtime;
- the Caddie Tool;
- the source Caddie Skill; and
- one compatibility declaration for the set.

The app owns release installation, versioned private runtime directories, activation, and the Tool Launch Record. The Tool remains the only writer of Caddie skill-management state. It reconciles the installed Caddie Skill from the active release. The app never writes that Skill directly.

The Skill reads the Tool Launch Record instead of running a nested Tool. The record binds exact active and last-good Node and Tool paths, versions, and fingerprints. The app never searches `PATH`.

Stage and verify a new private runtime before switching the Tool Launch Record. Existing Tool calls finish from their immutable older directories. Keep the active Tool, last-good Tool, and any older Tool with a live process.

Each release supports one release boundary. The new Tool accepts the prior Skill, the new Skill can use the last-good Tool, and state written during activation stays readable by the last-good Tool. Keep the version 1 request adapter for one compatibility release; route it into the same management module.

The versioned declaration in `skills/caddie/tool/src/adapter/compatibility.mjs` sets the end marker. Tool protocol 2 is the last version that accepts protocol 1 Skill requests. Tool protocol 3 must remove that bridge once protocol 2 is the oldest supported Skill contract.

This bridge is a narrow, one-release exception. The frozen prior Skill may still submit its old Caddie Plan request shape, including its allow-listed filesystem operations. The management-owned legacy lane applies the old validation, exact plan binding, approval, apply, and Recovery rules. It rejects unknown operations, new fields, internal plan intent, and direct Agent Harness settings writes. Protocol 2 and app callers can never enter this lane.

If the new Tool cannot start or its first `status` fails, restore the last-good Tool before any skill or state change. Later failures use Attention and Recovery.

## Installation, updates, and removal

Distribute one Developer ID-signed, Hardened Runtime-enabled, notarized Caddie Release in a stapled disk image.

Use a Homebrew Cask with `auto_updates true` as the main install path. Offer the same disk image as the fallback. Support `/Applications/Caddie.app` and `~/Applications/Caddie.app`. Stop Bootstrap and show move instructions when the app runs from a mounted disk image, Downloads, App Translocation, or another temporary path.

Use Sparkle 2 for normal app updates. Host the release on GitHub Releases and the HTTPS appcast on GitHub Pages. Check and download in the background. Install automatically by default only when no Tool call or Recovery is active, then relaunch. Keep the setting visible.

After launch, stage the release's private runtime under Application Support, verify it, call `status`, switch the Tool Launch Record, then reconcile the Caddie Skill.

Bootstrap adopts fresh or existing Caddie state in place. It never moves or recreates User Skills, Project Skills, Skill Sources, Registered Projects, or a Caddie State Root. Unfinished Recovery stops setup for a Finish or Roll back choice. Other state migration remains an exact reviewed Tool action.

If an updated app cannot launch, repair it with Homebrew or install a prior signed GitHub release. Do not add an app rollback worker.

App Removal unregisters the login item and quits. Homebrew may remove the app, or the user may move it to Trash. Preserve the Caddie Skill, last-good Tool, managed skills, `~/.agents/.caddie`, and every project `.agents/.caddie`. Homebrew `--zap` may remove app preferences, caches, private runtimes, and the Tool Launch Record, but never a Caddie State Root.

Development builds use a separate bundle ID and Application Support directory, with login and automatic app updates off by default.

## Release verification and rollout

macOS is the only release verification platform. The exact signed release must pass:

1. The Tool suite, version 2 contract through in-process and child-process Adapters, and real Codex and Claude discovery.
2. Fresh, current, legacy, unfinished-Recovery, malformed, and unsupported-newer state fixtures.
3. Current and prior Skill, Tool, protocol, and state compatibility.
4. Failure injection for Tool trust, launch, timeout, output, process death at durable steps, contention, races, permission loss, uncertain file events, Tool activation, app update, notifications, and Agent Handoff.
5. Signed-package checks for code signing, Hardened Runtime, notarization, stapling, Sparkle signature, Homebrew and disk-image install, login, access, update, fallback, removal, reinstall, and state preservation.
6. Observe-only use on the owner's real setup, compared with current Caddie.
7. One low-risk User Skill proving one eligible automatic update and one blocked unsafe change.

Further User Skills opt in one at a time. A separate disposable live canary is not required.

Use the owner's current Mac for personal acceptance. Before claiming public macOS 13 support, repeat the acceptance check on macOS 13.

Attach a private-data-safe Release Verification Record to the exact GitHub Release. Missing required proof blocks live reconciliation. Run the full packaged check for the first release and changes to installation, update, state, compatibility, or Recovery. Routine UI or Skill changes may use a shorter signed-release smoke check.

## Implementation order

1. Build the version 2 management module, state formats, Reconciliation Authorization, Local Source Inspection, Caddie Snapshot, Attention, Activity, pending actions, idempotency, and Reconciliation Pause.
2. Add the version 1 adapter and run the same contract through in-process and child-process Adapters.
3. Build the Caddie Release layout, private runtime staging, Tool Launch Record, compatibility checks, live-process retention, and last-good fallback.
4. Build the Swift menu app, Tool process Adapter, scheduler, File System Events Adapter, login item, and source-first status UI.
5. Add Ready Work, Attention, notifications, Retry, Recovery actions, Reconciliation Authorization controls, and Agent Handoff.
6. Add Bootstrap adoption, Homebrew Cask, disk image, Sparkle, signing, notarization, App Removal, and repair paths.
7. Add macOS release automation, failure injection, packaged checks, Release Verification Record generation, and the live rollout gates.

Each slice must leave the current Caddie Skill workflow working. Do not enable live standing-authorized writes until the complete release gate passes.

## First-release acceptance

The first release is complete when:

- an existing user can install the app without moving skills, sources, projects, or Caddie state;
- the app starts at login and catches changes made while it was closed;
- source cards show accurate saved state without inspecting on menu open;
- one authorized eligible User Skill updates and verifies after its source settles;
- unsafe changes remain untouched with correct Attention;
- manual Sync now and exact Ready Work function;
- Project Skills remain status-only;
- Retry, Finish, Roll back, notifications, and Agent Handoff follow their contracts;
- Tool update, fallback, Sparkle update, App Removal, and reinstall preserve state;
- Pause Automatic Updates and the system stop rules work; and
- the exact signed release has a complete Release Verification Record.
