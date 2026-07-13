# Codex and Claude skill rendering

Researched 2026-07-12 against current official documentation. “Documented” below means the linked vendor documentation states the behavior; “observed” means read-only inspection of this machine; “unverified” means Caddie must not depend on it yet.

## Direct answer

Codex is a safe first symlink renderer. Claude is a safe first renderer only if Caddie copies/materializes each skill directory (or treats symlinking as an explicitly experimental capability), because Anthropic does not document symlink traversal.

| Concern | Codex | Claude Code |
| --- | --- | --- |
| Global/user location | `$HOME/.agents/skills/<skill>/SKILL.md` | `~/.claude/skills/<skill>/SKILL.md` |
| Project discovery | `.agents/skills` from CWD through repository root | `.claude/skills` in the starting directory and parents through repository root; nested directories are discovered on demand when Claude works there |
| Other scope | `/etc/codex/skills`, plus bundled system skills | enterprise-managed and plugin skills; `.claude/skills` in `--add-dir` directories |
| Directory symlinks | Explicitly supported; Codex follows the target | Not stated in Anthropic documentation; unverified |
| Same-name behavior | No merge; both skills can appear in selectors. No winner/precedence is documented. | Enterprise overrides personal; personal overrides project. Plugin skills are namespaced. A skill overrides a legacy command with the same name. |
| Refresh | Skill changes are detected automatically; restart if absent. Config enable/disable changes require restart. | Existing watched skill directories update live for add/edit/remove. If the top-level skills directory did not exist at session start, restart is required. An invoked skill body is not reread later in that conversation unless reinvoked. |
| Minimum shared shape | Directory containing `SKILL.md`; YAML `name` and `description` required by Codex | Directory containing `SKILL.md`; Claude recommends `description`, permits omitted `name`, and follows the Agent Skills standard |

Sources: [OpenAI, Build skills](https://developers.openai.com/codex/skills) and [Anthropic, Extend Claude with skills](https://code.claude.com/docs/en/skills).

## Renderer constraints

1. Keep one canonical skill directory, but render separately into `.agents/skills/<rendered-name>` and `.claude/skills/<rendered-name>`.
2. Require a shared portable core: a directory entrypoint named exactly `SKILL.md`, valid YAML frontmatter, and non-empty `name` and `description`. Use lowercase letters, digits, and hyphens for portable names; keep the directory name equal to `name` so selectors and explicit invocation remain predictable.
3. For Codex, a managed directory symlink to the canonical skill is supported. For Claude v1, materialize/copy the complete skill directory until Anthropic documents symlinks or a disposable end-to-end test establishes a versioned compatibility guarantee.
4. Reject duplicate effective names before rendering. Do not try to encode “project overrides global” for Codex: official docs say duplicates coexist, not that one wins. Claude’s surprising documented precedence (personal over project) is another reason Caddie should detect collisions itself rather than rely on harness resolution.
5. Reconcile atomically at the directory level and report restart guidance. Do not promise instant refresh: Codex explicitly retains restart as fallback; Claude needs restart when a newly created top-level skills directory was absent at session start.
6. Treat vendor extensions as optional overlays. Claude-specific fields such as `context`, invocation controls, dynamic shell injection, and `${CLAUDE_SKILL_DIR}`, and Codex `agents/openai.yaml`, must not be assumed portable. A first shared renderer should emit only the common core unless a skill declares a harness-specific variant.
7. Validate relative references after render. Supporting files/scripts are allowed by both harnesses, so copying only `SKILL.md` is insufficient.

## Evidence and limits

### Documented facts

- OpenAI documents all Codex paths, upward repository scanning, duplicate coexistence, automatic change detection, and support for symlinked skill folders in one page.
- Anthropic documents personal/project/plugin paths, repository-parent and nested discovery, `--add-dir` skill discovery, precedence, and precise live-watch behavior in one page.
- Both vendors identify Agent Skills as their shared base format. Codex requires `name` and `description`; adopting that stricter requirement produces a compatible shared core.

### Local observations

- Installed versions during inspection were `codex-cli 0.144.1` and Claude Code `2.1.204`.
- `~/.claude/skills` currently contains many directory symlinks targeting `~/.agents/skills`, including `research`, `wayfinder`, and `domain-modeling`. This demonstrates the existing layout, not Claude compatibility; no harness state was changed and no live behavioral test was run.

### Uncertainties

- Anthropic’s skill documentation does not say whether symlinked skill directories or symlinked `SKILL.md` files are followed, watched correctly, or supported across platforms.
- OpenAI documents duplicate coexistence but no deterministic selector ordering or invocation disambiguation for equal names.
- Neither page promises identical handling of every nonstandard YAML field. Vendor-specific frontmatter therefore needs explicit compatibility testing.
- Refresh claims concern discovery metadata. Claude separately states that an already invoked skill remains in conversation context and is not reread on later turns; updating its file does not retroactively replace that loaded body.

## Recommendation

Ship Codex as the first thin symlink renderer. Claude can be included in the first version behind a materializing renderer, but should not be described as another safe symlink renderer yet. Add a disposable Claude symlink/watch compatibility test before optimizing Claude to symlinks; test directory links, file links, target edits, link replacement, broken links, duplicate names, and session restart boundaries.
