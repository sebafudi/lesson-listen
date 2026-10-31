#!/bin/bash
# Removes the native messaging host manifests. The model stays in the Hugging Face cache (~/.cache/huggingface).
NAME="dev.lesson_listen.stt"
find "$HOME/Library/Application Support" "$HOME/.config" -path "*NativeMessagingHosts/$NAME.json" -print -delete 2>/dev/null
