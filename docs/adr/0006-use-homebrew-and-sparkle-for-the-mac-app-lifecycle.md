# Use Homebrew and Sparkle for the Mac app lifecycle

## Status

Accepted.

## Context

Caddie needs a direct Mac distribution path that works with its unsandboxed file access, starts at login, updates without a separate worker, and preserves existing user and project state. The app also needs to adopt installations made by the current bootstrap without moving skills, sources, projects, or Caddie state.

The Mac App Store would require App Sandbox and a different file-access plan. A package installer adds system install work and user authorization that a normal app bundle does not need. A custom updater would make Caddie responsible for secure download, update checks, app replacement, and relaunch.

Homebrew Cask supports apps with their own updater through `auto_updates true`. Sparkle 2 supports signed update feeds, secure download, app replacement, and relaunch for directly distributed Mac apps. Apple supports direct distribution of Developer ID-signed and notarized apps in a disk image.

## Decision

Publish each Caddie Release as one Developer ID-signed, Hardened Runtime-enabled, notarized app in a stapled disk image. The same release bytes serve every install and update path.

Use a Homebrew Cask as the main install path and the disk image as the direct-download fallback. The Cask declares `auto_updates true`. It installs the normal app bundle rather than a package. Support `/Applications/Caddie.app` and `~/Applications/Caddie.app`. If Caddie runs from a mounted disk image, Downloads, App Translocation, or another temporary path, it stops Bootstrap and tells the user to move the app.

Use Sparkle 2 for normal app updates. Host signed release files on GitHub Releases and the HTTPS appcast on GitHub Pages. Sparkle checks and downloads in the background. Automatic install stays on by default and waits until the app has no active Tool call or Recovery work before it replaces and relaunches the app. A visible setting lets the user turn automatic install off.

After each install or app update, the launched app stages the release's private Node runtime and Tool in its versioned Application Support directory. It checks their signatures, fingerprints, release compatibility, and first `status` response before it switches the Tool Launch Record. The Tool then reconciles the installed Caddie Skill from the same release. This follows ADR 0005.

Keep the active Tool, the last-good Tool, and any older Tool with a live process. Delete an older release only after no process uses it. If the new Tool fails before state changes, switch back to the last-good Tool. Do not add a daemon or app rollback worker. If the new app cannot launch, repair it through Homebrew or install a prior signed release kept on GitHub.

Bootstrap adopts existing Caddie state in place. It does not move or recreate User Skills, Project Skills, Skill Sources, Registered Projects, or any Caddie State Root. If the Tool finds unfinished Recovery, Bootstrap stops routine setup and presents Finish and Roll back. Any required state migration remains an exact Tool-owned action with user review.

Register the main app as its own macOS login item after Bootstrap. Keep the setting visible. If macOS requires approval, open the Login Items settings page. Do not add a launch agent, daemon, or login helper.

Keep the first release outside App Sandbox. Add each new local Skill Source through a folder picker. Existing registered paths remain valid without being added again. If macOS blocks one exact path, offer Grant Access for that path. Never ask for Full Disk Access.

App Removal unregisters the login item and quits the app. Homebrew may then remove the app, or the user may move it to Trash. Preserve the installed Caddie Skill, the last-good Tool, every managed skill, `~/.agents/.caddie`, and every project `.agents/.caddie`. Homebrew `--zap` may remove app preferences, caches, private Tool releases, and the Tool Launch Record, but it must not remove any Caddie State Root. A later Caddie erasure flow must use exact Tool-owned plans and must not search the disk for folders to delete.

Development builds use a separate bundle identifier and Application Support directory. They leave login and automatic updates off by default.

## Consequences

Users who use Homebrew get one command for installation while other users retain a normal signed disk image. Sparkle handles the security-sensitive app update path. Homebrew and Sparkle refer to the same signed release, so Caddie does not produce two builds.

The release process must maintain a Homebrew Cask, GitHub release files, a Sparkle appcast, Developer ID and EdDSA signing keys, notarization, and checks for both install paths. Release tests must cover app replacement, login registration, first launch with fresh and existing state, protected source paths, Tool fallback, Homebrew removal, and direct removal.

App Removal does not erase Caddie. The preserved Skill and last-good Tool allow agent use and safe repair, but automatic source monitoring ends until the app returns. Full erasure remains separate because it can affect state spread across registered projects and needs exact review.
