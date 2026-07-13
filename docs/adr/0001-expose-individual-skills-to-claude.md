# Expose individual canonical skills at each user harness root

Claude Code 2.1.204 did not discover skills when `.claude/skills` itself was a symlink to `.agents/skills`, but did discover the same canonical skill when `.claude/skills/<name>` was an individual directory symlink. Caddie therefore keeps each harness skills directory real and creates one Caddie-owned link per selected canonical skill; it does not maintain a second skill copy.

Project Skills are already canonical beneath the project `.agents/skills`, so only Claude needs a project-local link. User Skills are canonical beneath Caddie's configured User Skills scope rather than the operating-system home. Bootstrap, Adoption, and user reconciliation therefore create matching individual links under both the actual `~/.agents/skills` and `~/.claude/skills` roots. Plans may write outside the configured User Skills scope only at those two runtime-HOME roots, and validation repeats that restriction during apply and recovery.

The release gate runs the installed Claude binary with an absent-skill control and must fail when Claude is unavailable or an exposed skill is not discovered.
