"""Project-owned local word transcription runner.

This is deliberately a one-shot process. It loads faster-whisper in the main
project process tree and writes a small JSON document to stdout; it does not
open a service port or call another project.
"""
from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("media_path")
    parser.add_argument("--model", default="Systran/faster-whisper-large-v3")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--cpu-threads", type=int, default=6)
    parser.add_argument("--language", default="")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - depends on local installation
        print(json.dumps({"ok": False, "error": f"faster-whisper unavailable: {exc}"}, ensure_ascii=False))
        return 2

    try:
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type=args.compute_type,
            cpu_threads=max(1, args.cpu_threads),
        )
        segments, info = model.transcribe(
            args.media_path,
            language=args.language or None,
            word_timestamps=True,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        words = []
        normalized_segments = []
        for segment in segments:
            segment_words = []
            for word in (segment.words or []):
                start = float(word.start or 0)
                end = float(word.end or start)
                text = str(word.word or "").strip()
                if not text or end <= start:
                    continue
                item = {"word": text, "start": round(start, 3), "end": round(end, 3)}
                words.append(item)
                segment_words.append(item)
            if segment_words:
                normalized_segments.append({
                    "start": segment_words[0]["start"],
                    "end": segment_words[-1]["end"],
                    "text": "".join(item["word"] for item in segment_words).strip(),
                    "words": segment_words,
                })
        duration = float(getattr(info, "duration", 0) or 0)
        print(json.dumps({
            "ok": True,
            "language": getattr(info, "language", None),
            "language_probability": float(getattr(info, "language_probability", 0) or 0),
            "duration": round(duration, 3),
            "words": words,
            "segments": normalized_segments,
        }, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover - depends on media/model
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
