# Design safe reconciliation

Type: grilling
Status: resolved
Blocked by: 01, 03

## Question

How should deterministic tools materialize pinned sources and reconcile global and project harness links idempotently while preserving unmanaged content, handling collisions, and supporting clean unmanagement?

## Answer

Each scope has one Canonical Installation under `.agents/skills`, containing complete skill directories rather than links to source repositories. Caddie materializes selected user-level and external project skills one directory at a time. Git-backed project-owned skills may instead live directly and be committed under the project's `.agents/skills`; Caddie treats them as in-place skills and never materializes over them. Generated external entries are ignored precisely while committed in-place entries remain tracked.

Claude shares the Canonical Installation through a scope-level `.claude/skills` directory symlink. V1 assumes Claude follows that link. Caddie records only links it created and never replaces an existing real directory or unrelated link without an approved migration.

Scope-local operational state lives under `.agents/.caddie/`. `ledger.json` lists only Caddie-owned materialized entries with source/path provenance and the deterministic tree fingerprint recorded at the last successful synchronization, plus managed harness exposures. `.agents/.caddie/operation/` is a transient same-filesystem journal containing the approved plan, staged directories, and previous entries during mutation. Installed skill directories contain no Caddie metadata.

Caddie compares the ledger baseline with both current source and installation fingerprints. One-sided changes reveal direction; equal new trees can refresh the baseline; different changes on both sides block replacement and receive agent-assisted two-way review. Modified times may optimize scanning but never authorize overwrite or removal. No durable snapshot store is maintained. Git is recommended for history and three-way reconstruction, while non-Git local sources remain manageable through fingerprints with explicitly degraded historical recovery.

Initial takeover is a read-only batch adoption proposal. Exact source or Vercel-lock matches may be preselected; modified and unknown skills are preserved for review. Authoring sources are explicit and separate from generated installations, except for Git-backed in-place project skills. An installed-only skill may be copied and verified into a chosen source before ownership transfers.

Synchronization is preflighted and atomic per user/project scope: resolve and stage all changes, validate names and fingerprints, reject unmanaged or desired-name collisions, move prior managed entries into the transient journal, place staged directories, verify the full result, and write the ledger last. Mutations are serialized per scope while read-only scans may run concurrently. An interrupted operation can be finished, inspected, or rolled back from the journal. A failure in one scope does not roll back a separately verified scope.

Caddie updates or removes only ledger-owned materialized entries. Managed clean entries may update or be removed when no longer desired; drifted entries are preserved. Unmanagement preserves installed copies and working Claude exposure by default, while explicit cleanup removes only unchanged owned content and proposes committed manifest/lock removal through normal Git review. Internal skill filesystem links receive normal copy semantics; Caddie is not a skill sandbox.
