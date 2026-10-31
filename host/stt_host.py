# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["parakeet-mlx>=0.3", "huggingface_hub"]
# ///
"""Chrome native messaging host: transcribes lesson audio with Parakeet and returns word timestamps.

Chrome starts one process per job and the process exits when the job is done,
so the model never stays resident in memory.
"""
import base64
import json
import os
import struct
import sys
import tempfile
import time
import traceback

PROTOCOL_OUT = sys.stdout.buffer
PROTOCOL_IN = sys.stdin.buffer
sys.stdout = sys.stderr

VERSION = 1
DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v2"
ALLOWED_MODELS = {
    "mlx-community/parakeet-tdt-0.6b-v2",
    "mlx-community/parakeet-tdt-0.6b-v3",
}
MAX_OUT_BYTES = 700_000
MAX_AUDIO_BYTES = 400 * 1024 * 1024


def send(message: dict) -> None:
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    PROTOCOL_OUT.write(struct.pack("<I", len(payload)))
    PROTOCOL_OUT.write(payload)
    PROTOCOL_OUT.flush()


def receive() -> dict | None:
    header = PROTOCOL_IN.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    return json.loads(PROTOCOL_IN.read(length).decode("utf-8"))


def model_is_cached(model_id: str) -> bool:
    from huggingface_hub import try_to_load_from_cache

    path = try_to_load_from_cache(model_id, "model.safetensors")
    return isinstance(path, str) and os.path.exists(path)


def tokens_to_words(tokens) -> list[list]:
    words: list[list] = []
    for token in tokens:
        text = token.text.replace("▁", " ")
        starts_word = text.startswith(" ") or not words
        piece = text.strip()
        if not piece:
            continue
        end = token.start + token.duration
        if starts_word:
            words.append([piece, round(token.start, 3), round(end, 3)])
        else:
            words[-1][0] += piece
            words[-1][2] = round(end, 3)
    return words


def send_words(words: list[list]) -> None:
    parts: list[list[list]] = [[]]
    size = 0
    for word in words:
        word_size = len(word[0]) + 24
        if size + word_size > MAX_OUT_BYTES and parts[-1]:
            parts.append([])
            size = 0
        parts[-1].append(word)
        size += word_size
    for index, part in enumerate(parts):
        send({"type": "words", "part": index, "total": len(parts), "words": part})


def receive_audio(begin: dict) -> str:
    suffix = "." + "".join(ch for ch in str(begin.get("ext", "mp3")) if ch.isalnum())[:5]
    handle = tempfile.NamedTemporaryFile(prefix="lesson-listen-", suffix=suffix, delete=False)
    received = 0
    expected = int(begin.get("size", 0))
    with handle:
        while True:
            message = receive()
            if message is None:
                raise RuntimeError("Connection closed while receiving audio")
            if message.get("type") == "end":
                break
            if message.get("type") != "chunk":
                raise RuntimeError(f"Unexpected message while receiving audio: {message.get('type')}")
            data = base64.b64decode(message["data"])
            received += len(data)
            if received > MAX_AUDIO_BYTES:
                raise RuntimeError("Audio is too large")
            handle.write(data)
            if expected:
                send({"type": "status", "stage": "receiving", "progress": received / expected})
    return handle.name


def transcribe(begin: dict) -> None:
    model_id = begin.get("model") or DEFAULT_MODEL
    if model_id not in ALLOWED_MODELS:
        raise RuntimeError(f"Model not allowed: {model_id}")

    audio_path = receive_audio(begin)
    started = time.time()
    try:
        cached = model_is_cached(model_id)
        send({"type": "status", "stage": "loading-model" if cached else "downloading-model"})

        from parakeet_mlx import from_pretrained

        model = from_pretrained(model_id)
        send({"type": "status", "stage": "transcribing", "progress": 0})

        def on_chunk(current, total):
            send({"type": "status", "stage": "transcribing", "progress": current / max(total, 1)})

        result = model.transcribe(
            audio_path, chunk_duration=120.0, overlap_duration=15.0, chunk_callback=on_chunk
        )
        words = tokens_to_words(result.tokens)
        send_words(words)
        send(
            {
                "type": "done",
                "model": model_id,
                "wordCount": len(words),
                "elapsed": round(time.time() - started, 1),
            }
        )
    finally:
        os.unlink(audio_path)


def main() -> None:
    try:
        message = receive()
        if message is None:
            return
        kind = message.get("type")
        if kind == "ping":
            model_id = message.get("model") or DEFAULT_MODEL
            send({"type": "pong", "version": VERSION, "modelCached": model_is_cached(model_id)})
        elif kind == "begin":
            transcribe(message)
        else:
            send({"type": "error", "message": f"Unknown message type: {kind}"})
    except Exception as error:
        traceback.print_exc()
        send({"type": "error", "message": str(error)})


if __name__ == "__main__":
    main()
