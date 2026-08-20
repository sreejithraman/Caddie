#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repo_root=${script_dir:h}
package_root="$repo_root/app/CaddieReleaseRuntime"
mode=${1:---development}
export CLANG_MODULE_CACHE_PATH=${CLANG_MODULE_CACHE_PATH:-/private/tmp/caddie-menu-clang-cache}
export SWIFTPM_MODULECACHE_OVERRIDE=${SWIFTPM_MODULECACHE_OVERRIDE:-/private/tmp/caddie-menu-swift-cache}

case "$mode" in
  --development)
    configuration=debug
    final_app_path="$package_root/.build/Caddie.app"
    node_path=${CADDIE_DEVELOPMENT_NODE:-${commands[node]:-}}
    node_version=$("$node_path" --version 2>/dev/null || true)
    node_major=${${node_version#v}%%.*}
    [[ -x "$node_path" && "$node_version" == v<->.* && "$node_major" -ge 22 ]] || {
      print -u2 -- "Node 22 or later is required for a development build."
      exit 2
    }
    ;;
  --release)
    configuration=release
    final_app_path="$package_root/.build/release-app/Caddie.app"
    [[ -n ${CADDIE_CODE_SIGN_IDENTITY:-} ]] || {
      print -u2 -- "CADDIE_CODE_SIGN_IDENTITY is required for a release build."
      exit 2
    }
    release_version=${CADDIE_APP_VERSION:-}
    build_number=${CADDIE_BUILD_NUMBER:-}
    version_parts=("${(@s:.:)release_version}")
    [[ ${#version_parts} -eq 3 && "$build_number" == <-> && ${#build_number} -le 10 && "$build_number" -gt 0 && "$build_number" -le 2147483647 ]] || {
      print -u2 -- "CADDIE_APP_VERSION must be x.y.z and CADDIE_BUILD_NUMBER must be a positive integer."
      exit 2
    }
    for version_part in $version_parts; do
      [[ "$version_part" == <-> && ${#version_part} -le 10 && "$version_part" -le 2147483647 && ( "$version_part" == 0 || "$version_part" != 0* ) ]] || {
        print -u2 -- "CADDIE_APP_VERSION must use three dot-separated integers without leading zeroes."
        exit 2
      }
    done
    ;;
  *)
    print -u2 -- "Usage: build-caddie-menu-app.sh [--development|--release]"
    exit 2
    ;;
esac

swift build --disable-sandbox --package-path "$package_root" -c "$configuration" --arch arm64 --product CaddieMenuApp
if [[ "$mode" == --development ]]; then
  swift build --disable-sandbox --package-path "$package_root" -c "$configuration" --arch arm64 --product CaddieDevelopmentSetup
fi
binary_path=$(swift build --disable-sandbox --package-path "$package_root" -c "$configuration" --arch arm64 --show-bin-path)
bundle_stage=$(mktemp -d "$package_root/.build/caddie-app.XXXXXX")
app_path="$bundle_stage/Caddie.app"
trap 'result=$?; rm -rf -- "$bundle_stage"; exit $result' EXIT
mkdir -p "$app_path/Contents/MacOS"
cp "$binary_path/CaddieMenuApp" "$app_path/Contents/MacOS/CaddieMenuApp"
cp "$package_root/CaddieMenuApp-Info.plist" "$app_path/Contents/Info.plist"
if [[ "$mode" == --development ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier app.caddie.CaddieMenuApp.dev" "$app_path/Contents/Info.plist"
  codesign --force --sign - "$app_path"
else
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $release_version" "$app_path/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app_path/Contents/Info.plist"
  codesign --force --options runtime --timestamp --sign "$CADDIE_CODE_SIGN_IDENTITY" "$app_path/Contents/MacOS/CaddieMenuApp"
  codesign --force --options runtime --timestamp --sign "$CADDIE_CODE_SIGN_IDENTITY" "$app_path"
fi
mkdir -p "${final_app_path:h}"
rm -rf -- "$final_app_path"
mv "$app_path" "$final_app_path"
if [[ "$mode" == --development ]]; then
  "$binary_path/CaddieDevelopmentSetup" "$final_app_path" "$node_path" "$repo_root/skills/caddie"
fi
print -r -- "$final_app_path"
