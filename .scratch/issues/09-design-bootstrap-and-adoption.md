# Design bootstrap and adoption

Type: prototype
Status: resolved
Blocked by: 01, 02, 04, 07

## Question

What is the smallest one-time bootstrap and conversational adoption flow that lets a new user create or choose a Stack Repository, import an existing Vercel-managed environment, and begin managing projects through the Operator?

## Answer

Bootstrap is the only required user-facing shell action. It temporarily fetches and validates the single-skill Caddie repository, materializes it into `~/.agents/skills/caddie`, connects Claude to the Canonical Installation, and seeds only enough ownership state to invoke Caddie. The first Caddie conversation then creates or connects the user-scoped Stack Manifest and registers Caddie itself as its first external Git selection (`path: "."`), so the normal manifest, Resolution Lock, and ledger replace bootstrap state. Caddie thereafter updates itself through the same candidate, plan, approval, and materialization workflow as any managed skill; the final swap executes from the scope operation directory rather than the directory being replaced.

When a user already has a skills repository, Caddie discovers candidate skills, asks which belong in the User Stack, proposes a user-scoped manifest and external lock without moving authoring sources, inspects existing harness directories, and submits one exact adoption plan. For a fresh user without a repository, Caddie defaults to a minimal non-Git User Stack home at `~/.config/caddie/user/`; later it can migrate that state and any authored skills into Git without disturbing the Canonical Installation.

Legacy adoption begins with a read-only scan of installed skills, Vercel metadata, candidate authoring sources, and upstream matches. Caddie classifies exact, modified, stale, and unknown entries. Exact matches may be preselected; modified and unknown content is preserved until resolved. Vercel `.skill-lock.json` is migration evidence only. After Caddie independently resolves and verifies every adopted entry, the approved plan recommends and preselects deletion of the obsolete Vercel lock, preserving it only in the transient operation journal until the transaction succeeds. Caddie then becomes the sole active manager for adopted entries; later third-party installer changes appear as drift.

Merely asking a read-only question inside a repository does not register it. The first approved project-management action implicitly includes machine-local registration, with no separate ceremony. A project `caddie.json` and `caddie.lock` are created only when a Project Stack is needed; a registered repository that consumes only the User Stack may have no committed Caddie files. Project-owned Git-backed skills already under `.agents/skills` are discovered as in-place skills, while external selections use normal materialization.

Every adoption path gathers facts and intent before producing one preconditioned plan. Existing Caddie-name collisions, real Claude directories, unmanaged skills, or missing permissions block only the affected takeover choices and are never silently replaced.
