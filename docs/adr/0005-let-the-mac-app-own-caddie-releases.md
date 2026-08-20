# Let the Mac app own Caddie releases

## Status

Accepted.

## Context

The current bootstrap copies the Caddie Skill and its nested Tool into `~/.agents/skills/caddie`. A normal Caddie update would therefore replace the directory from which the running Tool loaded its code. The current apply path can rename and replace that directory, but no test proves that a running Tool can finish or recover after replacing itself. The Tool also uses dynamic imports, which may read files after the replacement starts.

The Mac app needs one exact Tool path, a private Node runtime, a safe update path, and a last-good Tool when a new release cannot start. Keeping a second Tool in the app while the Skill keeps its nested Tool would create two active engines and two update paths.

## Decision

The Caddie Mac App is required. One signed Caddie Release contains the Mac app, its private Node runtime, the Tool, a source copy of the Caddie Skill, and compatibility facts for the whole set.

The app owns release installation and activation. It copies each private Node and Tool set into an app-owned versioned directory, checks the staged set, and switches the Tool Launch Record to exact paths and fingerprints. Existing Tool calls keep using their old versioned directory. New calls use the newly active set. The app keeps the last-good set until the new Tool and installed Caddie Skill pass their checks. The exact app installer, relaunch, and removal method belongs to the Mac app lifecycle decision.

The Caddie Skill no longer runs a Tool nested in its own installed directory. It reads the Tool Launch Record and invokes the active app-owned Tool. The Tool remains the only writer of Caddie skill-management state. It reconciles the Caddie Skill from the active release source into `~/.agents/skills/caddie` through the normal plan, apply, verify, and recover path. The app never writes that installed Skill directly.

Each release works across one release boundary. A new Tool accepts requests from the prior installed Caddie Skill. A new Caddie Skill can use the prior Tool if the app rolls back. State written during the release check must remain readable by the last-good Tool. A release that needs a one-way state change cannot activate until it supplies a proved recovery path.

If the staged Tool cannot start or its first `status` call fails, the app switches the Tool Launch Record back before it asks the Tool to change the installed Skill or other Caddie state. Later skill or state failures use normal Attention and recovery; the app does not guess how to undo them.

Bootstrap remains only as a small install or repair path for a Mac that cannot start the app. It does not provide a second full command-line product.

This decision changes the self-update part of issue #14: Caddie still manages its installed Skill through the normal flow, but it no longer updates the active Tool by replacing a Tool nested in that Skill. It does not change how Caddie manages other User Skills or Project Skills.

## Consequences

Caddie has one active Tool, one release owner, and one rollback pointer. A running Tool never needs to replace its own files. The app and Skill stay small because management rules remain in the Tool.

The app must manage versioned private runtime directories and the Tool Launch Record. Release tests must cover the current and prior Skill and Tool pairings. The app lifecycle design must choose the signed installer and relaunch method without adding another long-running worker.
