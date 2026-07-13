# Leave repository workflows to agents

Caddie's deterministic seam is the state it owns: Caddie Manifests, Caddie Locks, Caddie Ledgers, Materialized Skills, compatibility links, and recovery journals. Exact Caddie Plans protect mutations to that state.

Repository authoring is outside that seam. Hosting agents can create worktrees, edit files, run validations, commit, push, open pull requests, and coordinate changes across repositories using capabilities supplied by their Agent Harness. Reimplementing those capabilities inside the Caddie Tool added a second workflow engine with five protocol variants, Change Sandboxes, publication markers, dependency waves, and recovery behavior unrelated to skill-state management.

Caddie therefore leaves repository workflows to the hosting agent. The Caddie Skill may guide the agent to author and publish source changes using its normal capabilities. Once source content is final, Caddie inspects and resolves that source, then produces an immutable plan for the resulting managed-state mutation.

This decision supersedes user stories 61–75 and the corresponding repository-workflow implementation and testing decisions in the original v1 specification. Those requirements remain historical product context rather than current Caddie Tool behavior.

Filesystem defenses remain inside the Caddie Tool wherever it writes Caddie-owned state. This decision removes orchestration, not path validation, symlink safety, atomic writes, approval binding, or recovery for managed mutations.
