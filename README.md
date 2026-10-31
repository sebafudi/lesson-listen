# Lesson Listen

A Chrome extension that makes the lesson audio player on `hq.mega.dev` easier to read along with: skip buttons, clickable timestamps in the text, and a tracking mode that follows the audio. Exact word timings come from a Parakeet speech-to-text model running locally.

<!-- media -->

## Features

- **Skip buttons**: ±10 s in the player and the docked bar, ±30 s in the player. Each location can show any of ±5, ±10, ±30.
- **Timestamps in the text**: every paragraph, heading and diagram gets a clickable time. Estimated (`~4:51`) from the chapter times right away, exact (`4:51`) after **Sync with Parakeet**.
- **Tracking**: scrolls between paragraphs as the audio moves on and highlights the spoken word. Scrolling yourself pauses it; it picks up again at the next paragraph.
- **Shortcuts**: `J`/`L` ±10 s, `←`/`→` ±5 s, `K` play/pause, `T` tracking. All configurable.
- **Local and cached**: transcription runs on your machine and is stored per lesson in the browser. The model process exits after each sync.

## Install

1. Native host (needs `uv` and `ffmpeg`, Apple Silicon for `parakeet-mlx`):
   ```sh
   ./host/install.sh
   ```
   It registers `dev.lesson_listen.stt` for Chrome/Chromium/Brave/Arc and warms up the Python env.
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.
   The manifest pins the extension ID to `pidekogefiadecbjdbkfejdiigkjdomj`, which the host manifest allows.
3. Open a lesson, expand the player, click **Sync with Parakeet** once per lesson.

The first sync downloads the model (about 1.2 GB) into `~/.cache/huggingface`. Each sync starts a fresh host process that exits when it is done, so the model does not stay in memory. Host logs: `$TMPDIR/lesson-listen-host.log`.

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
```

## How syncing works

Page text and transcript are matched as runs of identical words, seeded by words (or 2-3 word sequences) unique to both, keeping the longest non-crossing set and filling gaps with LCS. Isolated matches that disagree with the surrounding runs are dropped, words the recognizer glued together are split back, and unmatched words (such as narrated diagrams) are interpolated. Estimates without a transcript are anchored on the player's chapter times and spread by word count, with diagram descriptions weighted by a per-lesson fit.

## Host protocol

Extension → host: `ping` | `begin {model, size, ext}`, `chunk {data: base64}`…, `end`.
Host → extension: `pong {modelCached}` | `status {stage, progress}`…, `words {part, total, words: [[text, start, end]]}`…, `done` | `error {message}`.
