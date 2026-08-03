#!/bin/zsh
set -euo pipefail

app_path=${1:-}
version=${2:-}
output_root=${3:-}

[[ -d "$app_path" && ${app_path:t} == Caddie.app && "$version" == <->.<->.<-> && -d "$output_root" ]] || {
  print -u2 -- "Usage: package-caddie-dry-run.sh <Caddie.app> <x.y.z> <existing-output-folder>"
  exit 2
}
version_parts=("${(@s:.:)version}")
for version_part in $version_parts; do
  [[ "$version_part" == <-> && ${#version_part} -le 10 && "$version_part" -le 2147483647 && ( "$version_part" == 0 || "$version_part" != 0* ) ]] || {
    print -u2 -- "The package version must use three dot-separated integers without leading zeroes."
    exit 2
  }
done
bundle_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Contents/Info.plist" 2>/dev/null) || {
  print -u2 -- "Caddie.app has no release version."
  exit 2
}
[[ "$bundle_version" == "$version" ]] || {
  print -u2 -- "Caddie.app version $bundle_version does not match package version $version."
  exit 2
}

output_path="${output_root:A}/Caddie-${version}.dmg"
[[ ! -e "$output_path" ]] || {
  print -u2 -- "Refusing to replace $output_path"
  exit 2
}

architecture=$(file "$app_path/Contents/MacOS/CaddieMenuApp")
[[ "$architecture" == *"arm64"* ]] || {
  print -u2 -- "The first dry-run package requires an arm64 Caddie app."
  exit 2
}

stage=$(mktemp -d /private/tmp/caddie-dmg-stage.XXXXXX)
trap 'result=$?; rm -rf -- "$stage"; exit $result' EXIT
ditto "$app_path" "$stage/Caddie.app"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -fs HFS+ -format UDZO -volname Caddie -srcfolder "$stage" "$output_path"
shasum -a 256 "$output_path"
