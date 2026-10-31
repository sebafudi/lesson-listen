# Lesson Listen

A Chrome extension that makes the lesson audio player on `hq.mega.dev` easier to read along with: skip buttons, clickable timestamps in the text, and a tracking mode that follows the audio. Exact word timings come from a Parakeet speech-to-text model running locally.

<p align="center"><img src="https://github.com/sebafudi/lesson-listen/releases/download/media/demo.gif" alt="Skip buttons, Parakeet sync and tracking in the lesson player" width="800"></p>

<p align="center"><sub>The lesson shown is made up.</sub></p>

| Skip | Sync | Tracking |
| --- | --- | --- |
| <img src="https://github.com/sebafudi/lesson-listen/releases/download/media/skip.png" alt="Skip buttons next to Play"> | <img src="https://github.com/sebafudi/lesson-listen/releases/download/media/sync.png" alt="Timestamps synced with Parakeet"> | <img src="https://github.com/sebafudi/lesson-listen/releases/download/media/tracking.png" alt="Spoken word highlighted while tracking"> |

## Features

- **Skip buttons**: ±10 s in the player and the docked bar, ±30 s in the player. Each location can show any of ±5, ±10, ±30.
- **Timestamps in the text**: every paragraph, heading and diagram gets a clickable time. Estimated (`~4:51`) from the chapter times right away, exact (`4:51`) after **Sync with Parakeet**.
- **Tracking**: scrolls between paragraphs as the audio moves on and highlights the spoken word. Scrolling yourself pauses it; it picks up again at the next paragraph.
- **Shortcuts**: `J`/`L` ±10 s, `←`/`→` ±5 s, `K` play/pause, `T` tracking. All configurable.
- **Local and cached**: transcription runs on your machine and is stored per lesson in the browser. The model process exits after each sync.

## Install

Requirements: Chrome (or Chromium, Brave, Arc). For **Sync with Parakeet** also macOS on Apple Silicon, [`uv`](https://docs.astral.sh/uv/) and `ffmpeg` (`brew install uv ffmpeg`). Without the host everything works with estimated timestamps.

1. Get the code and keep the folder where it is (the host is registered by its path; if you move the folder, run `install.sh` again):
   ```sh
   git clone https://github.com/sebafudi/lesson-listen.git
   cd lesson-listen
   ```
2. Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the `extension/` folder.
3. Optional, for exact timestamps, register the local speech-to-text host:
   ```sh
   ./host/install.sh
   ```
4. Open a lesson and expand the player. The skip buttons and estimated timestamps are there right away. Click **Sync with Parakeet** once per lesson; the first sync downloads the model (about 1.2 GB).

The extension icon opens the settings: shortcuts, skip buttons per player state, tracking style, model, host status and stored transcripts.

## What runs where

- **In the browser**: everything except transcription. Settings live in `chrome.storage.sync`, transcripts in `chrome.storage.local`.
- **On your machine**: only `host/stt_host.py`, started by Chrome through native messaging when you click **Sync** (and for a quick status check when the settings page opens or a sync starts). It receives the lesson audio, writes it to a temp file, transcribes it, returns word timings, deletes the file and exits. No background process, no server, no open port. Only this extension's ID may start it.
- **On disk**: the model in `~/.cache/huggingface`, Python packages in uv's cache, a log at `$TMPDIR/lesson-listen-host.log`, and one small `dev.lesson_listen.stt.json` per browser in its `NativeMessagingHosts` folder.

## Uninstall

1. Remove **Lesson Listen** in `chrome://extensions`. This also deletes its settings and stored transcripts.
2. Unregister the host (removes the `NativeMessagingHosts` entries):
   ```sh
   ./host/uninstall.sh
   ```
3. Optional, free the disk space:
   ```sh
   rm -rf ~/.cache/huggingface/hub/models--mlx-community--parakeet-tdt-0.6b-v2 \
          ~/.cache/huggingface/hub/models--mlx-community--parakeet-tdt-0.6b-v3
   rm -f "$TMPDIR/lesson-listen-host.log"
   uv cache prune
   ```
4. Delete the `lesson-listen` folder.

## Development

Unpacked builds watch their own files: when anything under `extension/` changes, the extension reloads itself and reloads open lesson tabs. They also answer two messages from the page console, `postMessage({type: "ll-debug-align", phrase: "..."})` (token-by-token alignment around a phrase) and `postMessage({type: "ll-debug-scan"})` (stretches of text with implausible timing). Packed builds skip both.

## Default shortcuts

| Action | Key |
| --- | --- |
| Back / forward 10s | `J` / `L` |
| Back / forward 5s | `←` / `→` |
| Play / pause | `K` |
| Toggle tracking | `T` |
| Scroll to what is playing | `C` |
| Slower / faster | `⇧,` / `⇧.` |

## Layout

```
extension/
  manifest.json
  background.js        native messaging bridge
  shared/settings.js   defaults, storage, shortcut parsing
  content/timing.js    tokenizer, chapter-anchored estimate, text/STT alignment
  content/content.js   UI injection, seeking, tracking, sync flow
  content/content.css
  options/             settings page (also the toolbar popup)
host/
  stt_host.py          parakeet-mlx transcription, native messaging protocol
  run.sh               entry point Chrome launches
  install.sh / uninstall.sh
  targets.sh           browser folders both scripts use
```

## How syncing works

Page text and transcript are matched as runs of identical words, seeded by words (or 2-3 word sequences) unique to both, keeping the longest non-crossing set and filling gaps with LCS. Isolated matches that disagree with the surrounding runs are dropped, words the recognizer glued together are split back, and unmatched words (such as narrated diagrams) are interpolated. Estimates without a transcript are anchored on the player's chapter times and spread by word count, with diagram descriptions weighted by a per-lesson fit.

## Host protocol

Extension → host: `ping` | `begin {model, size, ext}`, `chunk {data: base64}`…, `end`.
Host → extension: `pong {modelCached}` | `status {stage, progress}`…, `words {part, total, words: [[text, start, end]]}`…, `done` | `error {message}`.
