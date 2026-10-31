#!/bin/bash
# Registers the native messaging host with Chrome (and Chromium-based browsers if present).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/targets.sh"
EXTENSION_ID="${1:-pidekogefiadecbjdbkfejdiigkjdomj}"
chmod +x "$DIR/run.sh"

command -v uv >/dev/null || { echo "uv is required: brew install uv"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required: brew install ffmpeg"; exit 1; }

for target in "${HOST_TARGETS[@]}"; do
  parent="$(dirname "$target")"
  [ -d "$parent" ] || continue
  mkdir -p "$target"
  cat > "$target/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Lesson Listen local speech-to-text (Parakeet)",
  "path": "$DIR/run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
  echo "Installed: $target/$HOST_NAME.json"
done

echo "Warming up the Python environment (first run downloads dependencies)..."
uv run --quiet --python 3.12 --script "$DIR/stt_host.py" < /dev/null && echo "Host ready."
