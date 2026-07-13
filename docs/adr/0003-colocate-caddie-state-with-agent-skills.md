# Colocate Caddie state with Agent Skills

Caddie stores all ordinary state for a scope beside that scope's Agent Skills installation:

- User Skills: `~/.agents/.caddie`
- Project Skills: `<project>/.agents/.caddie`

Each scope owns `manifest.json`, `lock.json`, and `ledger.json`. The user scope additionally owns `registry.json` and user-wide coordination state. Materialized skills remain direct children of `.agents/skills`; Claude compatibility remains a set of individual links under `.claude/skills`. Disposable source checkouts remain in the operating system cache or temporary directory.

This fixed layout removes the machine configuration indirection that allowed the User Skills manifest to live in an arbitrary repository. Authored local skills may still live anywhere and are represented as ordinary local Skill Sources. A skill-source repository does not need to know about Caddie or contain Caddie state.

Existing v1 state under `~/.config/caddie` is migrated only through an immutable, explicitly approved Caddie Plan. Migration validates the supported legacy documents, preserves external source trees, rebases relative local-source paths, refuses destination collisions, and binds the complete legacy tree before removal. Inspection never migrates implicitly, and bootstrap never overwrites an existing installation.

Legacy manager state is not Caddie state. In particular, Vercel Labs' `~/.agents/.skill-lock.json` is inspected separately and may be removed only by a dedicated cleanup plan after every entry is classified as exactly Caddie-managed or obsolete. Adoption never deletes it.

This decision supersedes the configurable User Skills manifest and operating-system configuration-directory portions of the v1 specification and ADR 0001. It does not change the canonical Agent Skills roots or Claude compatibility decision.
