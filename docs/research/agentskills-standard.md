# Agent Skills discovery and format standard

Research date: 2026-07-13

## Conclusions for Caddie

- Organize this skills source repository under `skills/<name>`, not under an installation/discovery directory. The Agent Skills standard defines the portable unit as a self-contained skill folder, while the Anthropic and OpenAI first-party catalogs both use a top-level `skills/` directory for repository source. ([Agent Skills overview](https://agentskills.io/home), [Anthropic skills repository](https://github.com/anthropics/skills), [OpenAI skills repository](https://github.com/openai/skills))
- Keep every runtime instruction, script, reference, asset, and dependency needed by Caddie inside `skills/caddie`. Repository contributor documents may exist outside it, but the installed skill must not depend on them. ([Agent Skills best practices](https://agentskills.io/skill-creation/best-practices))

- Treat `~/.agents/skills/` as the primary user-level interoperability root and `<project>/.agents/skills/` as the primary project-level interoperability root. The Agent Skills **format specification does not mandate installation locations**; its official client-implementation guide identifies these two `.agents/skills/` paths as the cross-client convention alongside optional client-native paths. ([Agent Skills client implementation guide](https://agentskills.io/client-implementation/adding-skills-support#where-to-scan))
- Treat `.claude/skills/` as an explicit compatibility exposure, not as the canonical Agent Skills root. The same guide describes scanning `.claude/skills/` as pragmatic compatibility used by some implementations. ([Agent Skills client implementation guide](https://agentskills.io/client-implementation/adding-skills-support#where-to-scan))
- Keep each installed skill as a child directory containing a file named exactly `SKILL.md`; unrelated files directly in a skill root are not skills. ([Agent Skills client implementation guide](https://agentskills.io/client-implementation/adding-skills-support#what-to-scan-for))
- Preserve project-over-user semantics in Caddie's cross-client model. The official implementation guide calls project-level override of a same-named user skill the universal convention. Within one scope, the standard does not prescribe whether a client-native or `.agents` copy wins, only that the client be deterministic and warn about shadowing. ([Agent Skills client implementation guide](https://agentskills.io/client-implementation/adding-skills-support#handling-name-collisions))
- Do not infer a portable precedence rule from Codex's selector behavior. Codex scans `.agents/skills` from the current directory through the repository root plus `$HOME/.agents/skills`, and its current documentation says same-named skills are not merged and may both appear in selectors. ([OpenAI Codex skills documentation](https://developers.openai.com/codex/skills#where-to-save-skills))
- Symlink handling is a client behavior, not part of the Agent Skills format specification. Codex explicitly supports symlinked skill folders and follows their targets. The official Agent Skills pages do not specify a portable symlink contract, so Caddie should verify every compatibility exposure against the target client rather than call symlinks standards-mandated. ([OpenAI Codex skills documentation](https://developers.openai.com/codex/skills#where-to-save-skills), [Agent Skills specification](https://agentskills.io/specification))

## `SKILL.md` requirements

A skill directory needs a `SKILL.md` containing YAML frontmatter followed by Markdown instructions. Only these frontmatter fields are defined:

| Field | Status | Relevant constraint |
| --- | --- | --- |
| `name` | Required | 1–64 lowercase alphanumeric/hyphen characters; no leading, trailing, or consecutive hyphens; must match the parent directory |
| `description` | Required | 1–1024 characters; describes what the skill does and when to use it |
| `license` | Optional | License name or bundled-file reference |
| `compatibility` | Optional | 1–500 characters describing environment requirements |
| `metadata` | Optional | Map from string keys to string values for properties outside the specification |
| `allowed-tools` | Optional, experimental | Space-separated pre-approved tools; support varies by client |

Source: [Agent Skills specification](https://agentskills.io/specification#frontmatter).

`owner` is **not** a standard top-level field. `metadata.owner` is structurally allowed only as arbitrary, client-defined metadata, but it has no standard Agent Skills meaning. Removing both `owner` and `metadata.owner` produces a smaller, fully conforming skill as long as `name` and `description` remain. The specification illustrates optional authorship as `metadata.author`, but does not require it. ([Agent Skills specification](https://agentskills.io/specification#metadata-field))

Invocation controls are also client-specific. Codex documents
`agents/openai.yaml` with `policy.allow_implicit_invocation: false`; the commonly
used `disable-model-invocation: true` frontmatter field is outside the portable
Agent Skills fields above. Caddie's `user-only` Invocation Policy deliberately
projects both declarations so one selected skill behaves consistently across
Agent Harnesses while its Skill Source remains unchanged. ([OpenAI Build skills](https://learn.chatgpt.com/docs/build-skills.md))

References to bundled files should be relative to the skill root. The specification recommends shallow references and the conventional optional directories `scripts/`, `references/`, and `assets/`. ([Agent Skills specification](https://agentskills.io/specification#file-references))

## Recommended topology

```text
User scope
~/.agents/skills/<name>/SKILL.md          # canonical cross-client exposure
~/.claude/skills/<name> -> ...            # Claude-only compatibility exposure

Project scope
<project>/.agents/skills/<name>/SKILL.md  # canonical cross-client exposure
<project>/.claude/skills/<name> -> ...    # Claude-only compatibility exposure, if needed
```

This topology is a Caddie design conclusion from the official guidance, not a claim that the format specification requires a particular storage or symlink layout. Authored source may live elsewhere; Caddie's managed exposure should be at the interoperability root.
