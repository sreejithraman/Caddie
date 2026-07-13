# Design upstream change intelligence

Type: prototype
Status: resolved
Blocked by: 03

## Question

What evidence and agent interaction should distinguish ordinary updates, renames, splits, merges, and behavioral changes while keeping Migration Proposals simple, reviewable, and approval-gated?

## Answer

Caddie separates every assessment into four layers: deterministic facts, agent interpretation, a proposed user choice, and the minimal durable result. Facts include Git paths and commits, names, content hashes, router/reference changes, ledger fingerprints, declared lineage, and cross-project usage. The Operator interprets those facts semantically but never changes content or durable state merely because a relationship appears likely.

An ordinary same-name/path content update changes the Resolution Lock and Materialized Skill only after approval; it needs no Migration Record. Renames with behavior changes present the probable successor, affected references, and meaningful differences. High-confidence proposals may recommend and preselect migration, but must also offer keeping the old revision pinned, removal without replacement, or treating the candidate as unrelated.

Splits and merges always require an explicit workflow choice and normally warrant a short Migration Record because the selected capability graph changes. A same-name/path skill whose triggers, tools, or completion contract changed is treated as a compatibility review rather than a routine update. Users may accept it, keep the prior commit pinned, or replace the selection.

Installed-copy drift is not an upstream update. Caddie preserves it and offers comparison, restoration, or carrying the improvement to its owning source through an approved authoring workflow. Declared `derivedFrom` lineage enables repeatable multi-origin monitoring. When lineage is absent, Caddie may infer probable origins and reusable improvements from names, structure, content similarity, references, and cross-project evidence, but persists lineage only after confirmation.

Migration Proposals remain conversational by default. The manifest and lock are the only routine durable changes. A Markdown Migration Record is created only when semantic reasoning would be expensive to reconstruct, such as a split, merge, ambiguous successor, or consequential behavior change. No confidence taxonomy, evidence graph, or permanent report is required in v1.
