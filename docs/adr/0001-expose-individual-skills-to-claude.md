# Make `.agents/skills` canonical and isolate Claude compatibility

Agent Skills defines a portable skill directory and `SKILL.md` format. Its client implementation guide identifies `~/.agents/skills` and `<project>/.agents/skills` as the cross-client discovery convention; it describes `.claude/skills` as pragmatic compatibility rather than a second portable root. Caddie therefore materializes complete User Skills directly beneath `~/.agents/skills` and complete Project Skills directly beneath `<project>/.agents/skills`.

Claude Code 2.1.204 did not discover skills when `.claude/skills` itself was a symlink to `.agents/skills`, but did discover the same skill through an individual `.claude/skills/<name>` directory symlink. Claude is consequently a compatibility adapter: Caddie creates one owned Claude link per selected canonical skill and never creates a Codex-specific link. Unrelated Claude entries remain untouched.

The fixed User Caddie Manifest remains the desired-state authority, while its Skill Sources may live in any local directory or pinned Git repository. Changing a source does not move installed skills. Adoption records an existing real directory at the standard root and may add its Claude link; it does not replace the directory with a symlink. User-root mutations share the machine-local `~/.agents/.caddie/user-mutation.lock` and `user-operation.json` recovery reservation.

Bootstrap installs Caddie itself as a real `~/.agents/skills/caddie` directory with fixed state under `~/.agents/.caddie`. Existing state is upgraded by the explicit migration workflow recorded in ADR 0003. The release gate verifies real standard-root discovery with installed Codex and individual-link compatibility with installed Claude Code.
