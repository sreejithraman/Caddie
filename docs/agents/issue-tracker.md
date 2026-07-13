# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for operations and infer the repository from the local remote.

## Conventions

- Create, read, comment on, label, and close work with the corresponding `gh issue` commands.
- Read comments and labels when fetching an issue.
- GitHub Issues and pull requests share one number space; resolve ambiguous references before acting.
- External pull requests are not currently a triage request surface.

## Skill operations

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, read that issue and its comments.

Wayfinder uses a `wayfinder:map` issue, child issues with `wayfinder:<type>` labels, native sub-issue and dependency relationships when available, assignment as the claim, and issue comments plus closure as the resolution. If native relationships are unavailable, use task-list and `Blocked by:` fallbacks in issue bodies.
