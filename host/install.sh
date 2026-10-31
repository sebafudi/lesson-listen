#!/bin/bash
# Registers the native messaging host with Chrome (and Chromium-based browsers if present).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="dev.lesson_listen.stt"
EXTENSION_ID="${1:-pidekogefiadecbjdbkfejdiigkjdomj}"
chmod +x "$DIR/run.sh"

command -v uv >/dev/null || { echo "uv is required: brew install uv"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required: brew install ffmpeg"; exit 1; }

TARGETS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/chromium/NativeMessagingHosts"
)

for target in "${TARGETS[@]}"; do
  parent="$(dirname "$target")"
  [ -d "$parent" ] || continue
  mkdir -p "$target"
  cat > "$target/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "Lesson Listen local speech-to-text (Parakeet)",
  "path": "$DIR/run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
  echo "Installed: $target/$NAME.json"
done

echo "Warming up the Python environment (first run downloads dependencies)..."
uv run --quiet --python 3.12 --script "$DIR/stt_host.py" < /dev/null && echo "Host ready."
