# Persisted formats

All Caddie v1 persisted JSON formats use `version: 1`.

- `.agents/.caddie/manifest.json` is the Caddie Manifest and desired-state authority. It declares a `user` or `project` scope, deduplicated local or Git Skill Sources, and explicit Skill Selections.
- `.agents/.caddie/lock.json` is the deterministic Caddie Lock. It pins external Git selections to exact commits and contains no timestamps, transient installation metadata, or local-content hashes.
- `.agents/.caddie/ledger.json` is the scope Caddie Ledger. It records Materialized Skills at the canonical cross-client root, Claude compatibility links, and harness-native Skill Enablement settings Caddie owns, with source identity, selected path, and last reconciled fingerprint.
- `.agents/.caddie/registry.json` is user-only state containing Registered Projects.
- `.agents/.caddie/operation-journal.json`, the `operations/` directory, and coordination files are transient recovery state.

For User Skills, `.agents/.caddie` is beneath runtime HOME. For Project Skills, it is beneath the project root. Disposable source evidence belongs in the conventional cache directory. Ordinary active state is never stored under `~/.config/caddie`.

The explicit migration workflow recognizes the earlier v1 `~/.config/caddie/config.json` layout. It copies the supported manifest, lock, ledger, and registry data into the fixed user state root, rebases relative local-source paths so they retain their meaning, binds the complete legacy tree fingerprint, and removes that tree only in the approved plan. Existing destination state, malformed input, unsupported versions, or changed preconditions produce a no-op and require review or replanning.

Unsupported versions are inspectable as bounded evidence and are not migrated implicitly.

Ordinary reconciliation adds or updates Ledger ownership. A Skill Rename replaces the exact old per-skill ownership with its new identity in one complete Ledger write. The Ledger does not retain rename history; the immutable Caddie Plan binds the accepted old and new identities and fingerprints, while an optional Migration Record keeps costly semantic reasoning.

## Version 2 management state

`~/.agents/.caddie/management-v2.json` stores the last committed Caddie Snapshot and the Tool state behind it. Its top-level `version` is `2`. It holds Reconciliation Authorization, Attention, Activity, pending actions, outside effects, idempotency receipts, and Reconciliation Pause. The Tool checks the whole document before use and replaces it with one atomic write. Malformed state and unsupported newer versions stop management work without changing the file.

Recent durable lists hold at most 100 records. Resolved Attention and recent Activity expire after 30 days. Open Attention has a separate 100-item safety limit and never gets pruned as history. At that limit, the Tool pauses new work until proof resolves an item.

Snapshot detail lists keep at most 10,000 records each in durable state. Responses show 100 records per list and include signed continuation tokens plus partial coverage when more records remain. Tokens bind the Snapshot revision, field, and offset. The Tool checks the full prospective Snapshot against the 16 MiB state limit, with write-result room held back, before it changes a managed skill.

The active idempotency result cache holds 100 results. When an old result for a write or outside effect leaves that cache, Caddie keeps a compact request tombstone. A matching old retry then fails safely instead of running again. The tombstone store holds 20,000 entries and stops new compaction before it could forget a mutating request.

Version 2 Reconciliation Authorization binds fingerprints for both the version 1 Caddie Lock and Caddie Ledger. Authorized apply writes the existing Lock schema and the updated Ledger in the same Caddie Plan. Lock or Ledger changes outside that plan block automatic work.

Each Skill Selection may declare `enabled` as a boolean. Omitted is equivalent to `true`. `false` keeps the skill selected, resolved, installed, and updateable while asking each supported Agent Harness to disable it through that harness's native settings. Caddie records only the settings it creates as `harnessSettings` ownership in the Caddie Ledger.

Each Skill Selection may declare `derivedFrom` as a non-empty array of distinct exact `{ "source", "path" }` origins. Every origin names a source in the same manifest and a relative selection path; Git source revisions remain pinned by the Caddie Lock. A selection may also point to a durable Markdown Migration Record with a scope-relative `migrationRecord` path. Absolute paths, traversal, malformed origins, duplicate origins, and non-Markdown Migration Record pointers are invalid.

Each Skill Selection may also declare `invocation: "user-only"`. Caddie projects
that Invocation Policy into the harness-specific metadata of a disposable
effective source before fingerprinting and materialization. An absent policy
preserves the selected source bytes and invocation behavior unchanged.

## Caddie Release files

The app reads `caddie-release.json` at the root of each Caddie Release. Version 1 names one safe release ID and the app, private Node, Tool, and source Skill artifacts. Each artifact binds a relative path, version, and SHA-256 fingerprint. The compatibility declaration binds Tool protocol 2, Skill protocols 1 and 2, and the readable state-format range. The app rejects missing fields, unsafe paths, symbolic links, bad fingerprints, and incompatible ranges before it runs the Tool.

The app copies checked releases to its `Releases/<release-id>` Application Support folder. It writes `Tool Launch Record.json` there as one atomic version 1 record. The record has a rising revision and complete `active` and `lastGood` bindings. Each binding contains the exact release root, release ID, absolute Node, Tool, and source Skill paths, their versions and fingerprints, and the same compatibility declaration. Activation changes only `active`. A separate post-reconciliation check promotes that exact active binding to `lastGood`.

Files in `Leases/` bind one running Tool process ID to one release ID. The Skill launcher and app share the `Release Lifecycle.lock` claim while resolving, leasing, switching, or cleaning releases. The launcher transfers that claim to the private Node process before the Tool loads, then releases it only after the Tool PID lease is durable. Cleanup keeps the active release, the last-good release, and every release with a live lease. A malformed lease or release stops cleanup.

Stale-claim takeover uses a separate, atomically published `Release Lifecycle.takeover` claim. Caddie does not remove an orphaned takeover claim on its own: a PID can be reused, and an unchecked removal could let two lifecycle writers overlap. The app exposes the exact owner, nonce, path, time, and current PID evidence for a repair flow that runs only while every Caddie process is stopped.
