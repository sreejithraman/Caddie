#!/bin/sh
set -eu

repository=${CADDIE_REPOSITORY:-https://github.com/sreejithraman/Caddie.git}
commit=${CADDIE_COMMIT:-}
source_dir=${CADDIE_SOURCE_DIR:-}
temp_dir=

if ! printf '%s' "$commit" | grep -Eq '^[0-9a-fA-F]{40}$'; then
  echo 'CADDIE_COMMIT must be an exact 40-character Git commit.' >&2
  exit 2
fi

cleanup() {
  if [ -n "$temp_dir" ]; then
    rm -rf "$temp_dir"
  fi
}
trap cleanup EXIT HUP INT TERM

clone_source=${source_dir:-$repository}
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/caddie-bootstrap.XXXXXX")
git clone --quiet --no-checkout "$clone_source" "$temp_dir/repository"
git -C "$temp_dir/repository" checkout --quiet --detach "$commit"
resolved=$(git -C "$temp_dir/repository" rev-parse HEAD)
if [ "$resolved" != "$commit" ]; then
  echo 'The fetched release did not resolve to CADDIE_COMMIT.' >&2
  exit 3
fi
source_dir=$temp_dir/repository

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$script_dir/bootstrap.cjs" "$source_dir" "$commit" "$repository"
