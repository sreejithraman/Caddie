# Caddie

Caddie is an agent-first manager for skills shared across users, projects, and agent harnesses.

It is designed to give an agent a bird's-eye view of a user's skill environment: where skills come from, which exact revisions are selected, what is installed, what has drifted, and which projects need attention. Caddie combines a conversational agent skill with deterministic tooling for inspection, reconciliation, and safe change planning.

## Status

Caddie is currently specified but not yet implemented.

- [Caddie v1 specification](https://github.com/sreejithraman/Caddie/issues/1)
- [First implementation ticket](https://github.com/sreejithraman/Caddie/issues/2)

The specification is divided into agent-ready tracer-bullet tickets with native dependency relationships. Work can proceed from any unblocked ticket in the GitHub issue frontier.

## Intended experience

- Keep User Skills available across projects.
- Add project-owned capabilities through Project Skills.
- Expose one canonical `.agents/skills` installation to Codex and Claude.
- Select complete skills from local or pinned Git sources.
- Detect upstream changes, local drift, renames, and derived skill lineage.
- Review an exact plan before Caddie mutates managed state.
- Prepare repository changes in isolated worktrees and draft pull requests.
- Inspect every registered project from one conversational bird's-eye view.

Caddie is an Agent App, not a human-facing package-manager CLI. Its scripts are tools for the agent; bootstrap is the only intended direct shell interaction.

## Design principles

- Preserve authored and installed content unless the user explicitly approves its removal.
- Separate deterministic evidence, agent interpretation, user choice, and durable state.
- Store complete skill copies in canonical skill directories; use symlinks only to share that installation between harnesses.
- Recommend Git without requiring it.
- Keep desired state, resolved state, and expensive semantic decisions durable; compute routine reports live.

The GitHub v1 specification is the normative implementation source.

## License

MIT
