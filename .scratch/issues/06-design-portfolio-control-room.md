# Design the portfolio control room

Type: prototype
Status: resolved
Blocked by: 03, 04

## Question

What should the SreeStack Operator inspect and present from a Stack Repository to give a useful bird's-eye view across registered projects without creating a central database or persistent dashboard?

## Answer

Caddie may be invoked from any repository and may inspect every registered project. The working directory is a default ranking focus, never a visibility or authority boundary. Explicit intent wins: a request about the current project leads with findings affecting that project, while a bird's-eye request shows all managed repositories regardless of where it originated. An unmanaged current project receives a registration offer but can still request the complete cross-project view.

Caddie computes views live from the user-scoped manifest and lock, machine-local project registry, each project manifest and lock, scope ledgers and Canonical Installations, Git state, and explicitly fetched upstream metadata. It does not maintain a central database, dashboard, or periodic inventory snapshot. It may know where skills are selected, installed, drifted, related, or outdated; it must not claim actual usage without evidence from a real usage source.

Focused reviews include relevant local findings, cross-project findings that affect the current project, and a brief footer when unrelated findings exist elsewhere, such as “Two findings exist in other registered projects.” The user can expand to the full bird's-eye view immediately. Caddie should use plain language such as “managed repositories” and “registered projects”; “portfolio” is not domain terminology.

Findings cover source updates and migrations, installed drift, broken harness exposure, rendered-name conflicts, stale registrations, probable lineage, duplicated or reusable project skills, user-scoped skills enabled by only a narrow set of projects, and project references affected by upstream changes. The Operator ranks them conversationally by impact, confidence, scope, and immediacy; severity scores do not become persisted schema.

Reports remain conversational by default. Caddie creates no durable artifact until the user accepts a recommendation or explicitly asks to preserve the analysis. Accepted work follows the normal manifest, lock, optional Migration Record, worktree, and draft-PR boundaries.
