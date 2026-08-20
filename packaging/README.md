# Mac release files

The release job must make one signed and notarized disk image. Homebrew and the direct download must use those same bytes.

`homebrew/Caddie.rb.template` leaves the version, SHA-256, and GitHub Release URL blank on purpose. The release job fills them from the final disk image. Normal Cask removal removes only the app. `zap` may remove app preferences and caches. It preserves Application Support, the Tool Launch Record, active and last-good Tools, `~/.agents`, and every project folder.

`sparkle/appcast.xml.template` is the base feed. Generate its release items with Sparkle 2's `generate_appcast` from the final disk image. The Sparkle package version and EdDSA public key must be set before release code can turn updates on. Keep the private key outside this repository.

The app update bridge is `DownloadedUpdateInstalling`. Sparkle must implement that bridge and call `IdleUpdateCoordinator`. The coordinator acquires the same exclusive Release Lifecycle claim used by Tool launches, Bootstrap release work, and Recovery calls. It holds that claim through install and relaunch, so new work cannot start after an idle check.

`BootstrapCoordinator` owns the six state outcomes without writing state: fresh, current, and old state may move on; Recovery stops for a choice; malformed and newer state stop in place. The fixture test checks that user and project state bytes do not change for any outcome. Full Tool-backed adoption fixtures, a real installed app update, signing checks, and the Release Verification Record belong to issue #45 (the release verification work tracked from #30). The app lifecycle rules come from issue #44 and the earlier lifecycle work tracked from #35.

Developer builds use `app.caddie.CaddieMenuApp.dev`, `Caddie Development` in Application Support, and ad-hoc signing. They do not start at login or install app updates by default.

`scripts/build-caddie-menu-app.sh --development` makes that local build. `--release` makes an arm64 release build and refuses to run without `CADDIE_CODE_SIGN_IDENTITY`, an `x.y.z` `CADDIE_APP_VERSION`, and a positive `CADDIE_BUILD_NUMBER`. It writes both bundle versions before signing the executable and then the outer app with Hardened Runtime and a trusted timestamp. This is build scaffolding, not release proof. Do not publish its output until Sparkle is linked and pinned, the private release artifacts are embedded and sealed, and issue #45 has signed, notarized, stapled, Gatekeeper, disk image, update, fallback, and preservation evidence.

`scripts/package-caddie-dry-run.sh` puts one arm64 app and an Applications link in a new compressed disk image. It refuses to replace an old image and prints the exact SHA-256 that the Cask renderer will bind. It does not sign, notarize, staple, or publish.

The first dry-run release targets Apple silicon only. Do not call the build universal or claim macOS 13 proof until the signed checks in issue #45 run on those targets.
