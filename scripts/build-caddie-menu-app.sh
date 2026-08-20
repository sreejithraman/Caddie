#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repo_root=${script_dir:h}
package_root="$repo_root/app/CaddieReleaseRuntime"

swift build --package-path "$package_root" -c debug --product CaddieMenuApp
binary_path=$(swift build --package-path "$package_root" -c debug --show-bin-path)
app_path="$package_root/.build/Caddie.app"
mkdir -p "$app_path/Contents/MacOS"
cp "$binary_path/CaddieMenuApp" "$app_path/Contents/MacOS/CaddieMenuApp"
cp "$package_root/CaddieMenuApp-Info.plist" "$app_path/Contents/Info.plist"
codesign --force --sign - "$app_path"
print -r -- "$app_path"
