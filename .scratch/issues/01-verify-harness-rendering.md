# Verify Codex and Claude skill rendering

Type: research
Status: resolved
Blocked by:

## Question

What global and project-local discovery locations, symlink behavior, precedence rules, refresh behavior, and `SKILL.md` compatibility constraints must the first Codex and Claude renderers satisfy?

## Answer

Codex can be the first thin symlink renderer: OpenAI explicitly documents `$HOME/.agents/skills`, upward project discovery through `.agents/skills`, non-merging duplicate names, automatic refresh with restart fallback, and followed directory symlinks.

Claude can join v1 only with a materializing/copy renderer, or with symlinking marked experimental. Anthropic documents `~/.claude/skills`, project/parent/nested discovery, enterprise > personal > project precedence, and live directory watching, but does not document symlink support. Caddie should detect collisions itself and require the stricter shared `SKILL.md` core (`name` plus `description`) rather than rely on different harness precedence rules.

Full evidence, sources, constraints, local observations, and remaining uncertainties: [Codex and Claude skill rendering](../research/harness-skill-rendering.md).

## Product decision after research

The owner subsequently chose to assume Claude follows the shared skills symlink for v1. The specification therefore uses `.agents/skills` as the Canonical Installation and `.claude/skills -> ../.agents/skills` as the Claude exposure, while retaining the research uncertainty as an implementation-time verification risk rather than introducing a second materializing renderer.
