#!/bin/bash
# Native messaging entry point. Chrome starts it with a minimal PATH, so add Homebrew and uv locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/bin:/bin"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec uv run --quiet --python 3.12 --script "$DIR/stt_host.py" 2>>"${TMPDIR:-/tmp}/lesson-listen-host.log"
