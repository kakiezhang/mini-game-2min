#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 INPUT_GLB OUTPUT_GLB [--force]" >&2
  exit 2
fi

input=$1
output=$2
force=${3:-}

if [[ ! -f "$input" ]]; then
  echo "Input model not found: $input" >&2
  exit 1
fi
if [[ -e "$output" && "$force" != "--force" ]]; then
  echo "Refusing to overwrite existing output: $output" >&2
  exit 1
fi
if [[ -e "$output" ]]; then
  rm "$output"
fi

run_gltf_transform() {
  if command -v gltf-transform >/dev/null 2>&1; then
    gltf-transform "$@"
  else
    npx --yes @gltf-transform/cli@4.5.0 "$@"
  fi
}

run_gltf_transform optimize "$input" "$output" \
  --compress meshopt \
  --texture-compress webp \
  --texture-size 1024

echo
ls -lh "$input" "$output"
echo
run_gltf_transform inspect "$output"
