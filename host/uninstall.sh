#!/bin/bash
# Removes the native messaging host registrations that install.sh wrote.
# The model (~/.cache/huggingface) and uv's package cache are left alone; see the README to remove them.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/targets.sh"
removed=0
for target in "${HOST_TARGETS[@]}"; do
  file="$target/$HOST_NAME.json"
  if [ -f "$file" ]; then
    rm -f "$file" && echo "Removed: $file" && removed=$((removed + 1))
  fi
done
echo "Removed $removed host registration(s)."
