#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repo_root=${script_dir:h}
state_root=${CADDIE_PREVIEW_STATE_ROOT:-"$HOME/.agents/.caddie"}
state_file="$state_root/management-v2.json"
inventory_file="$state_root/management-v2.json.inventory-v1.json"

[[ -r "$state_file" && -r "$inventory_file" ]] || {
  print -u2 -- "Caddie preview needs readable live state and inventory files."
  exit 2
}

preview_root=$(mktemp -d "${TMPDIR:-/private/tmp}/caddie-preview.XXXXXX")
preview_pid=""
cleanup() {
  if [[ -n "$preview_pid" ]]; then kill "$preview_pid" 2>/dev/null || true; fi
  rm -rf -- "$preview_root"
}
trap cleanup EXIT INT TERM

stable=false
for attempt in 1 2 3; do
  cp "$state_file" "$preview_root/state-before.json"
  cp "$inventory_file" "$preview_root/management-v2.json.inventory-v1.json"
  cp "$state_file" "$preview_root/state-after.json"
  if cmp -s "$preview_root/state-before.json" "$preview_root/state-after.json"; then
    mv "$preview_root/state-before.json" "$preview_root/management-v2.json"
    rm "$preview_root/state-after.json"
    stable=true
    break
  fi
done

[[ "$stable" == true ]] || {
  print -u2 -- "Caddie changed while the preview snapshot was copied. Try again."
  exit 3
}

"$repo_root/scripts/build-caddie-menu-app.sh" --development >/dev/null
app="$repo_root/app/CaddieReleaseRuntime/.build/Caddie.app"
print -r -- "Opening a read-only preview from $preview_root"
"$app/Contents/MacOS/CaddieMenuApp" \
  --preview-snapshot "$preview_root" \
  --show-main-window &
preview_pid=$!
wait "$preview_pid"
