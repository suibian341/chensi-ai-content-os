"""Project-owned local word transcription runner.

This is deliberately a one-shot process. It loads faster-whisper in the main
project process tree and writes a small JSON document to stdout; it does not
open a service port or call another project.
"""
from __future__ import annotations

import argparse
import json
import os
import sys


def simplified_chinese_converter(language: str):
    if str(language or "").lower().split("-")[0] != "zh":
        return None
    try:
        from opencc import OpenCC
    except Exception as exc:
        raise RuntimeError(f"opencc unavailable for Simplified Chinese subtitles: {exc}") from exc
    return OpenCC("t2s")


def cuda_available() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def resolve_cached_model(model: str) -> str:
    if os.path.isdir(model):
        return model
    try:
        from faster_whisper.utils import download_model

        return download_model(model, local_files_only=True)
    except Exception:
        return model


def inference_attempts(device: str, compute_type: str) -> list[tuple[str, str]]:
    if device == "auto":
        devices = ("cuda", "cpu") if cuda_available() else ("cpu",)
    else:
        devices = (device,)
    return [
        (
            current_device,
            compute_type if compute_type != "auto" else ("float16" if current_device == "cuda" else "int8"),
        )
        for current_device in devices
    ]


def run_transcription(whisper_model, args, device: str, compute_type: str):
    model = whisper_model(
        args.model,
        device=device,
        compute_type=compute_type,
        cpu_threads=max(1, args.cpu_threads),
    )
    segments, info = model.transcribe(
        args.media_path,
        language=args.language or None,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    return list(segments), info


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("media_path")
    parser.add_argument("--model", default="Systran/faster-whisper-large-v3")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--cpu-threads", type=int, default=max(1, os.cpu_count() or 1))
    parser.add_argument("--language", default="")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - depends on local installation
        print(json.dumps({"ok": False, "error": f"faster-whisper unavailable: {exc}"}, ensure_ascii=False))
        return 2

    args.model = resolve_cached_model(args.model)
    failures = []
    for device, compute_type in inference_attempts(args.device, args.compute_type):
        try:
            segments, info = run_transcription(WhisperModel, args, device, compute_type)
            break
        except Exception as exc:
            failures.append(f"{device}/{compute_type}: {exc}")
    else:
        print(json.dumps({"ok": False, "error": "; ".join(failures)}, ensure_ascii=False))
        return 3

    try:
        converter = simplified_chinese_converter(args.language or getattr(info, "language", ""))
        words = []
        normalized_segments = []
        for segment in segments:
            segment_words = []
            for word in (segment.words or []):
                start = float(word.start or 0)
                end = float(word.end or start)
                text = str(word.word or "").strip()
                if converter:
                    text = converter.convert(text)
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
            "device": device,
            "compute_type": compute_type,
            "cpu_threads": max(1, args.cpu_threads),
            "words": words,
            "segments": normalized_segments,
        }, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover - depends on media/model
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
