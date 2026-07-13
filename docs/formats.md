# Persisted formats

All Caddie v1 persisted JSON formats use `version: 1`.

- `caddie.json` is the Caddie Manifest and desired-state authority. It declares a `user` or `project` scope, deduplicated local or Git Skill Sources, and explicit Skill Selections.
- `caddie.lock` is the deterministic Caddie Lock. It pins external Git selections to exact commits and contains no timestamps, absolute paths, transient installation metadata, or local-content hashes.
- `.agents/.caddie/ledger.json` is the scope-local Caddie Ledger. It records only Materialized Skills and harness-specific links Caddie owns, their source identity and selected path, and the last reconciled fingerprint.
- `.agents/.caddie/journal.json` is transient recovery state for an interrupted mutation.
- Machine configuration uses the operating system's conventional user configuration directory. It stores the User Skills manifest location and Registered Projects; disposable evidence belongs in the conventional cache directory.

Unsupported versions are inspectable as bounded evidence and are not migrated implicitly.

Each Skill Selection may declare `derivedFrom` as a non-empty array of distinct exact `{ "source", "path" }` origins. Every origin names a source in the same manifest and a relative selection path; Git source revisions remain pinned by the Caddie Lock. A selection may also point to a durable Markdown Migration Record with a scope-relative `migrationRecord` path. Absolute paths, traversal, malformed origins, duplicate origins, and non-Markdown Migration Record pointers are invalid.
