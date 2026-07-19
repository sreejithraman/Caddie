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

Each Skill Selection may declare `enabled` as a boolean. Omitted is equivalent to `true`. `false` keeps the skill selected, resolved, installed, and updateable while asking each supported Agent Harness to disable it through that harness's native settings. Caddie records only the settings it creates as `harnessSettings` ownership in the Caddie Ledger.

Each Skill Selection may declare `derivedFrom` as a non-empty array of distinct exact `{ "source", "path" }` origins. Every origin names a source in the same manifest and a relative selection path; Git source revisions remain pinned by the Caddie Lock. A selection may also point to a durable Markdown Migration Record with a scope-relative `migrationRecord` path. Absolute paths, traversal, malformed origins, duplicate origins, and non-Markdown Migration Record pointers are invalid.
