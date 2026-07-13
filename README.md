# Caddie

Caddie is an agent-first manager for skills across user and project scopes, made available to multiple agent harnesses.

It is designed to give an agent a bird's-eye view of a user's skill environment: where skills come from, which exact revisions are selected, what is installed, what has drifted, and which projects need attention. Caddie combines a conversational agent skill with deterministic tooling for inspection, reconciliation, and safe change planning.

## Status

Caddie v1 is under active implementation.

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
- Store complete skill copies in canonical skill directories; use harness-specific links only when a harness cannot read the canonical directory directly.
- Recommend Git without requiring it.
- Keep desired state, resolved state, and expensive semantic decisions durable; compute routine reports live.

The GitHub v1 specification is the normative implementation source.

## Agent Tool

The deterministic tool accepts one versioned JSON request on standard input:

```sh
printf '%s\n' '{"version":1,"operation":"locate","input":{"cwd":"/path/to/project"}}' | node bin/caddie-tool.mjs
```

The Caddie Skill is in `.agents/skills/caddie`. Bootstrap is the only intended human-facing shell action; normal management remains conversational and approval-gated.

See [the protocol](docs/protocol.md) and [persisted formats](docs/formats.md).

## License

MIT
