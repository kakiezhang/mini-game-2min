#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 INPUT_PNG CHARACTER_SLUG [OUTPUT_DIR]" >&2
  exit 2
fi

input=$1
slug=$2
output_dir=${3:-.}

if [[ ! -f "$input" ]]; then
  echo "Input image not found: $input" >&2
  exit 1
fi

if [[ ! "$slug" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "Character slug must contain only lowercase letters, digits, underscores, or hyphens: $slug" >&2
  exit 2
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick 'magick' is required." >&2
  exit 1
fi

read -r width height < <(magick identify -format '%w %h\n' "$input")
crop_width=$(( (height * 25 + 24) / 48 ))
if (( width < crop_width )); then
  echo "Image is too narrow for a ${crop_width}x${height} crop: ${width}x${height}" >&2
  exit 1
fi

available=$(( width - crop_width ))
names=(front left_front right_front back)
left_cleanup=(0 $(( crop_width * 13 / 100 )) $(( crop_width * 13 / 100 )) $(( crop_width * 13 / 100 )))
right_cleanup=($(( crop_width * 6 / 100 )) $(( crop_width * 8 / 100 )) $(( crop_width * 11 / 100 )) 0)
background_sample=($(( crop_width * 2 / 100 )) $(( crop_width * 14 / 100 )) $(( crop_width * 14 / 100 )) $(( crop_width * 14 / 100 )))
mkdir -p "$output_dir"

for index in 0 1 2 3; do
  x=$(( (available * index + 1) / 3 ))
  output="$output_dir/${slug}_${names[$index]}.png"
  if [[ -e "$output" ]]; then
    echo "Refusing to overwrite existing output: $output" >&2
    exit 1
  fi
  magick "$input" -crop "${crop_width}x${height}+${x}+0" +repage "$output"

  left=${left_cleanup[$index]}
  if (( left > 0 )); then
    sample_x=${background_sample[$index]}
    magick "$output" \
      \( +clone -crop "1x${height}+${sample_x}+0" +repage -statistic Median 1x101 -scale "${left}x${height}!" \) \
      -geometry +0+0 -composite "$output"
  fi

  right=${right_cleanup[$index]}
  if (( right > 0 )); then
    sample_x=${background_sample[$index]}
    destination_x=$(( crop_width - right ))
    magick "$output" \
      \( +clone -crop "1x${height}+${sample_x}+0" +repage -statistic Median 1x101 -scale "${right}x${height}!" \) \
      -geometry "+${destination_x}+0" -composite "$output"
  fi

  echo "$output (${crop_width}x${height}, x=${x})"
done
