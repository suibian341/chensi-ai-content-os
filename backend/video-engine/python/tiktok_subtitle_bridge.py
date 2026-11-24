"""Bridge the TiTok project's deterministic subtitle pipeline into Chensi.

The source project keeps the subtitle algorithm as a pure Python module. This
one-shot bridge intentionally exchanges only JSON over stdin/stdout, so the
Chensi server does not need to import the source project's database or start a
second web service.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path


MAX_SUBTITLE_LINE_CHARACTERS = 15
MAX_SUBTITLE_LINES = 2
OPEN_SUBTITLE_FONT_FAMILY = "Noto Sans SC"
_LINE_END_PUNCTUATION = set("，。！？；：、,.!?;:)]}）】》」』")


DEFAULT_PROJECT_ROOT = Path(__file__).resolve().parents[3]
BUNDLED_PIPELINE = Path(__file__).resolve().parent / "subtitle_pipeline.py"


def _load_pipeline():
    """Load the subtitle pipeline.

    The bundled copy next to this file wins, so the pipeline ships with the
    application and the bridge works wherever it is deployed. The historical
    external TiTok checkout is still honoured through IP_AGENT_TITOK_PROJECT_ROOT
    (and the default root) for development machines that have it.

    Resolving the bundled path relative to __file__ rather than to an absolute
    Windows path is what makes this work on the Linux host: the previous version
    looked only at <root>/backend/app/subtitle_pipeline.py and raised
    FileNotFoundError on production, where the pipeline was not deployed at all.
    """
    root = Path(os.environ.get("IP_AGENT_TITOK_PROJECT_ROOT", str(DEFAULT_PROJECT_ROOT)))
    candidates = [
        Path(os.environ["IP_AGENT_SUBTITLE_PIPELINE_PATH"]) if os.environ.get("IP_AGENT_SUBTITLE_PIPELINE_PATH") else None,
        BUNDLED_PIPELINE,
        root / "backend" / "app" / "subtitle_pipeline.py",
    ]
    module_path = next((path for path in candidates if path is not None and path.is_file()), None)
    if module_path is None:
        raise FileNotFoundError(
            "TiTok subtitle pipeline not found; looked in: "
            + ", ".join(str(path) for path in candidates if path is not None)
        )
    spec = importlib.util.spec_from_file_location("tiktok_subtitle_pipeline", module_path)
    if spec is None or spec.loader is None:
        raise ImportError("Unable to load TiTok subtitle pipeline")
    module = importlib.util.module_from_spec(spec)
    # dataclasses and a few runtime annotations resolve the module through
    # sys.modules while the imported source is being executed.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _word_mappings(payload: dict, pipeline) -> list[dict]:
    result = []
    duration_ms = max(1, int(payload.get("duration_ms") or 1))
    for sequence, item in enumerate(payload.get("words") or []):
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", item.get("word", ""))).strip()
        if not text:
            continue
        try:
            start_ms = int(round(float(item.get("start_ms", float(item.get("start", 0)) * 1000))))
            end_ms = int(round(float(item.get("end_ms", float(item.get("end", 0)) * 1000))))
        except (TypeError, ValueError, OverflowError):
            continue
        if end_ms <= 0 or start_ms >= duration_ms:
            continue
        start_ms = max(0, min(duration_ms - 1, start_ms))
        end_ms = min(duration_ms, max(start_ms + 1, end_ms))
        if end_ms <= start_ms:
            continue
        confidence = item.get("confidence")
        try:
            confidence = float(confidence) if confidence is not None else None
        except (TypeError, ValueError, OverflowError):
            confidence = None
        if confidence is not None and not 0 <= confidence <= 1:
            confidence = None
        result.append({
            "sequence": sequence,
            "text": text,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "confidence": confidence,
        })
    return result


def _fallback_words(payload: dict, duration_ms: int) -> list[dict]:
    text = str(payload.get("text") or "").strip()
    if not text:
        return []
    if re.search(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]", text):
        tokens = _split_script_sentences(text)
    else:
        tokens = text.split()
    tokens = list(tokens)
    step = duration_ms / max(1, len(tokens))
    result = []
    for sequence, token in enumerate(tokens):
        start_ms = min(duration_ms - 1, round(sequence * step))
        end_ms = min(duration_ms, max(start_ms + 1, round((sequence + 1) * step)))
        result.append({
            "sequence": sequence,
            "text": token,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "confidence": None,
        })
    return result


def _split_script_sentences(text: str) -> list[str]:
    value = str(text or "").replace("\r", "").strip()
    if not value:
        return []
    # Keep punctuation attached to the sentence so the rendered cue ends at
    # the same semantic boundary as the spoken line.
    sentences = [item.strip() for item in re.findall(r"[^。！？；!?;\n]+[。！？；!?;]?", value) if item.strip()]
    if not sentences:
        return [value]
    result: list[str] = []
    for sentence in sentences:
        if len(sentence) <= 28:
            result.append(sentence)
            continue
        chunks = [item.strip() for item in re.split(r"(?<=[，,、])\s*", sentence) if item.strip()]
        if len(chunks) > 1:
            result.extend(chunks)
        else:
            result.extend(sentence[index:index + 24] for index in range(0, len(sentence), 24))
    return result or [value]


def _alignment_chars(text: str) -> list[str]:
    return [character.casefold() for character in str(text or "") if character.isalnum()]


def _aligned_sentence_word_ranges(sentences: list[str], words: list[dict]) -> list[tuple[int, int]]:
    """Align authoritative script characters to ASR words.

    Whisper tokenization is not proportional to sentence length. A global
    edit-distance alignment keeps sentence changes attached to the words that
    were actually spoken, even when ASR omits or substitutes a few characters.
    """
    script_chars: list[str] = []
    sentence_ranges: list[tuple[int, int]] = []
    for sentence in sentences:
        start = len(script_chars)
        script_chars.extend(_alignment_chars(sentence))
        sentence_ranges.append((start, len(script_chars)))

    recognized_chars: list[str] = []
    recognized_word_indexes: list[int] = []
    for word_index, word in enumerate(words):
        for character in _alignment_chars(word.get("text", "")):
            recognized_chars.append(character)
            recognized_word_indexes.append(word_index)

    if not script_chars or not recognized_chars:
        return []

    script_to_recognized: list[int | None] = [None] * len(script_chars)
    exact_matches = 0
    matcher = SequenceMatcher(None, script_chars, recognized_chars, autojunk=False)
    for tag, script_start, script_end, recognized_start, recognized_end in matcher.get_opcodes():
        script_span = script_end - script_start
        recognized_span = recognized_end - recognized_start
        if tag == "equal":
            exact_matches += script_span
            for offset in range(script_span):
                script_to_recognized[script_start + offset] = recognized_start + offset
        elif tag == "replace" and script_span and recognized_span:
            for offset in range(script_span):
                ratio = offset / max(1, script_span - 1)
                recognized_offset = min(recognized_span - 1, round(ratio * (recognized_span - 1)))
                script_to_recognized[script_start + offset] = recognized_start + recognized_offset

    # Unrelated audio should not force misleading sentence boundaries.
    if exact_matches / max(1, min(len(script_chars), len(recognized_chars))) < 0.45:
        return []

    ranges: list[tuple[int, int]] = []
    for sentence_start, sentence_end in sentence_ranges:
        mapped = [
            recognized_character_index
            for recognized_character_index in script_to_recognized[sentence_start:sentence_end]
            if recognized_character_index is not None
        ]
        if not mapped:
            return []
        first_word = recognized_word_indexes[min(mapped)]
        last_word = recognized_word_indexes[max(mapped)]
        ranges.append((first_word, last_word + 1))
    return ranges


def _script_sentence_cues(text: str, words: list[dict], duration_ms: int, reference_timeline: list[dict], offset_ms: int = 0, measured_words: bool = False) -> list[dict]:
    """Map the known narration script to measured word/reference timings.

    ASR word text can differ slightly from the generated script (especially in
    Chinese), so timing comes from ASR while display text always comes from the
    authoritative script. Reference teardown timing is used only for an exact
    sentence-count match and is scaled to this video's duration.
    """
    sentences = _split_script_sentences(text)
    if not sentences:
        return []
    timeline: list[tuple[float, float]] = []
    for item in reference_timeline or []:
        try:
            start = float(item.get("start", float(item.get("start_ms", 0)) / 1000))
            end = float(item.get("end", float(item.get("end_ms", 0)) / 1000))
        except (TypeError, ValueError, AttributeError):
            continue
        if end > start >= 0:
            timeline.append((start, end))
    if not measured_words and len(timeline) == len(sentences):
        source_total = timeline[-1][1]
        scale = duration_ms / (source_total * 1000) if source_total > 0 else 1.0
        cues = [
            {
                "id": f"script-{index:04d}",
                "sequence": index,
                "current_text": sentence,
                "start_ms": max(0, min(duration_ms - 1, round(start * 1000 * scale) + offset_ms)),
                "end_ms": max(1, min(duration_ms, round(end * 1000 * scale) + offset_ms)),
                "word_timed": False,
            }
            for index, (sentence, (start, end)) in enumerate(zip(sentences, timeline))
        ]
        previous_end = 0
        for cue in cues:
            cue["start_ms"] = max(previous_end, int(cue["start_ms"]))
            cue["end_ms"] = min(duration_ms, max(cue["start_ms"] + 1, int(cue["end_ms"])))
            previous_end = cue["end_ms"]
        return cues
    if not words:
        return []
    aligned_ranges = _aligned_sentence_word_ranges(sentences, words)
    if aligned_ranges:
        cues = []
        groups: list[tuple[int, int, int, int]] = []
        group_start = 0
        group_first_word, group_last_word = aligned_ranges[0]
        for sentence_index, (start_word, end_word) in enumerate(aligned_ranges[1:], start=1):
            if start_word < group_last_word:
                group_last_word = max(group_last_word, end_word)
                continue
            groups.append((group_start, sentence_index, group_first_word, group_last_word))
            group_start = sentence_index
            group_first_word, group_last_word = start_word, end_word
        groups.append((group_start, len(aligned_ranges), group_first_word, group_last_word))

        for sentence_start, sentence_end, start_word, end_word in groups:
            chunk = words[start_word:end_word]
            if not chunk:
                continue
            group_sentences = sentences[sentence_start:sentence_end]
            start_ms = max(0, min(duration_ms - 1, int(chunk[0]["start_ms"])))
            end_ms = max(start_ms + 1, min(duration_ms, int(chunk[-1]["end_ms"])))
            weights = [max(1, len(sentence.replace(" ", ""))) for sentence in group_sentences]
            total_weight = sum(weights)
            consumed = 0
            cursor = start_ms
            for offset, (sentence, weight) in enumerate(zip(group_sentences, weights)):
                consumed += weight
                cue_end = end_ms if offset == len(group_sentences) - 1 else start_ms + round((end_ms - start_ms) * consumed / total_weight)
                cue_end = min(end_ms, max(cursor + 1, cue_end))
                sequence = sentence_start + offset
                cues.append({
                    "id": f"script-{sequence:04d}",
                    "sequence": sequence,
                    "current_text": sentence,
                    "start_ms": cursor,
                    "end_ms": cue_end,
                    "word_timed": measured_words,
                })
                cursor = cue_end
        previous_end = 0
        for cue in cues:
            cue["start_ms"] = max(previous_end, int(cue["start_ms"]))
            cue["end_ms"] = min(duration_ms, max(cue["start_ms"] + 1, int(cue["end_ms"])))
            previous_end = cue["end_ms"]
        return cues
    # Use character-weighted boundaries over measured words. This preserves
    # real pauses and speaking speed while keeping the exact script text.
    weights = [max(1, len(sentence.replace(" ", ""))) for sentence in sentences]
    total_weight = sum(weights)
    cues: list[dict] = []
    cursor_word = 0
    for index, sentence in enumerate(sentences):
        remaining_sentences = len(sentences) - index
        remaining_words = len(words) - cursor_word
        if index == len(sentences) - 1:
            end_word = len(words)
        else:
            desired = round(sum(weights[: index + 1]) / total_weight * len(words))
            end_word = max(cursor_word + 1, min(len(words) - (remaining_sentences - 1), desired))
        chunk = words[cursor_word:end_word]
        if not chunk:
            continue
        start_ms = int(chunk[0]["start_ms"])
        end_ms = int(chunk[-1]["end_ms"])
        cues.append({
            "id": f"script-{index:04d}",
            "sequence": index,
            "current_text": sentence,
            "start_ms": max(0, min(duration_ms - 1, start_ms)),
            "end_ms": max(1, min(duration_ms, end_ms)),
            "word_timed": False,
        })
        cursor_word = end_word
    # Ensure monotonically increasing, non-overlapping cues after rounding.
    previous_end = 0
    for cue in cues:
        cue["start_ms"] = max(previous_end, int(cue["start_ms"]))
        cue["end_ms"] = max(cue["start_ms"] + 1, int(cue["end_ms"]))
        cue["end_ms"] = min(duration_ms, cue["end_ms"])
        previous_end = cue["end_ms"]
    return cues


def _shift_words(words: list[dict], offset_ms: int, duration_ms: int) -> list[dict]:
    if not offset_ms:
        return words
    shifted = []
    for item in words:
        start_ms = max(0, min(duration_ms - 1, int(item["start_ms"]) + offset_ms))
        end_ms = min(duration_ms, max(start_ms + 1, int(item["end_ms"]) + offset_ms))
        shifted.append({**item, "start_ms": start_ms, "end_ms": end_ms})
    return shifted


def _semantic_cues(segments: list[dict]) -> list[dict]:
    return [
        {
            "id": f"display-{index:04d}",
            "sequence": index,
            "current_text": str(segment.get("current_text") or segment.get("original_text") or "").strip(),
            "start_ms": int(segment["start_ms"]),
            "end_ms": int(segment["end_ms"]),
            "word_timed": False,
        }
        for index, segment in enumerate(segments)
        if str(segment.get("current_text") or segment.get("original_text") or "").strip()
    ]


def _graphemes(value: str) -> list[str]:
    clusters: list[str] = []
    for character in str(value or ""):
        category = unicodedata.category(character)
        joins_previous = bool(clusters) and (
            unicodedata.combining(character)
            or category in {"Mn", "Mc", "Me"}
            or character == "\u200d"
            or clusters[-1].endswith("\u200d")
            or "\ufe00" <= character <= "\ufe0f"
        )
        if joins_previous:
            clusters[-1] += character
        else:
            clusters.append(character)
    return clusters


def _grapheme_width_units(cluster: str) -> float:
    character = cluster[0]
    east_asian_width = unicodedata.east_asian_width(character)
    if character.isspace():
        return 0.34
    if east_asian_width in {"W", "F"} or ord(character) >= 0x1F000:
        return 1.0
    if character in "MW@#%&":
        return 0.92
    if character.isupper():
        return 0.68
    if character.isdigit():
        return 0.58
    if unicodedata.category(character).startswith("P"):
        return 0.44
    return 0.56


def _wrap_subtitle_lines(text: str) -> list[str]:
    remaining = _graphemes(re.sub(r"\s+", " ", str(text or "")).strip())
    lines: list[str] = []
    while remaining:
        if sum(_grapheme_width_units(cluster) for cluster in remaining) <= MAX_SUBTITLE_LINE_CHARACTERS:
            lines.append("".join(remaining).strip())
            break
        window_end = 0
        window_width = 0.0
        for cluster in remaining:
            cluster_width = _grapheme_width_units(cluster)
            if window_end and window_width + cluster_width > MAX_SUBTITLE_LINE_CHARACTERS:
                break
            window_width += cluster_width
            window_end += 1
        window = remaining[:window_end]
        minimum_natural_break = max(4.0, MAX_SUBTITLE_LINE_CHARACTERS / 2)
        boundaries: list[tuple[int, int]] = []
        occupied_width = 0.0
        for index, cluster in enumerate(window, start=1):
            cluster_width = _grapheme_width_units(cluster)
            occupied_width += cluster_width
            if cluster.isspace() and occupied_width - cluster_width >= minimum_natural_break:
                boundaries.append((index - 1, index))
            elif cluster[-1:] in _LINE_END_PUNCTUATION and occupied_width >= minimum_natural_break:
                boundaries.append((index, index))
        line_end, next_start = boundaries[-1] if boundaries else (
            window_end,
            window_end,
        )
        line = "".join(remaining[:line_end]).strip()
        if not line:
            line = "".join(remaining[:window_end]).strip()
            next_start = window_end
        lines.append(line)
        remaining = remaining[next_start:]
        while remaining and remaining[0].isspace():
            remaining.pop(0)
    return [line for line in lines if line]


def _limit_display_cues(cues: list[dict]) -> list[dict]:
    result: list[dict] = []
    for cue in cues:
        text = str(cue.get("current_text") or "").strip()
        if not text:
            continue
        lines = _wrap_subtitle_lines(text)
        groups = [lines[index:index + MAX_SUBTITLE_LINES] for index in range(0, len(lines), MAX_SUBTITLE_LINES)]
        weights = [max(1, sum(len(_graphemes(line)) for line in group)) for group in groups]
        total_weight = sum(weights)
        source_start = int(cue["start_ms"])
        source_end = int(cue["end_ms"])
        duration = max(1, source_end - source_start)
        cursor = source_start
        consumed_weight = 0
        for group_index, (group, weight) in enumerate(zip(groups, weights)):
            consumed_weight += weight
            end_ms = source_end if group_index == len(groups) - 1 else source_start + round(duration * consumed_weight / total_weight)
            end_ms = min(source_end, max(cursor + 1, end_ms))
            result.append({
                **cue,
                "id": f"{cue.get('id') or 'subtitle'}-layout-{group_index + 1}",
                "sequence": len(result),
                "current_text": "\n".join(group),
                "start_ms": cursor,
                "end_ms": end_ms,
            })
            cursor = end_ms
    return result


def _safe_subtitle_style(style: dict, width: int, height: int) -> dict:
    result = dict(style)
    outline = max(0.0, float(result.get("outline_width") or 4))
    horizontal_margin = max(48, round(width * 0.06))
    usable_width = max(1, width - horizontal_margin * 2 - outline * 4)
    requested_size = max(16, int(float(result.get("font_size") or 88)))
    wide_character_size = max(16, int(usable_width / (MAX_SUBTITLE_LINE_CHARACTERS * 1.04)))
    result.update({
        "name": "Unified Subtitle",
        # Noto Sans SC is released under the SIL Open Font License 1.1.
        "font_family": OPEN_SUBTITLE_FONT_FAMILY,
        "font_size": min(requested_size, wide_character_size),
        "margin_left": horizontal_margin,
        "margin_right": horizontal_margin,
        "margin_bottom": max(48, min(height // 2, round(height * 400 / 1920))),
        "max_lines": MAX_SUBTITLE_LINES,
    })
    return result


def _line_width_units(line: str) -> float:
    return max(1.0, sum(_grapheme_width_units(cluster) for cluster in _graphemes(line)))


def _cue_font_size(lines: list[str], style: dict, width: int) -> int:
    outline = max(0.0, float(style.get("outline_width") or 4))
    usable_width = max(1, width - int(style["margin_left"]) - int(style["margin_right"]) - outline * 4)
    widest = max((_line_width_units(line) for line in lines), default=1.0)
    width_fitted = int(usable_width / (widest * 1.06))
    return max(16, min(int(style["font_size"]), width_fitted))


def _ass_timestamp(milliseconds: int) -> str:
    centiseconds = max(0, int(milliseconds)) // 10
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    seconds, fraction = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{fraction:02d}"


def _build_uniform_ass(cues: list[dict], style: dict, width: int, height: int, pipeline) -> str:
    font_family = str(style["font_family"]).replace(",", " ").replace("{", "").replace("}", "")
    name = str(style["name"]).replace(",", " ")
    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: " + ",".join([
            name, font_family, str(float(style["font_size"])),
            str(style.get("primary_color") or "&H00FFFFFF"), "&H00FFFFFF",
            str(style.get("outline_color") or "&H00000000"), "&H00000000",
            "-1", "0", "0", "0", "100", "100", "0", "0", "1",
            str(float(style.get("outline_width") or 4)), str(float(style.get("shadow_depth") or 0)),
            str(int(style.get("alignment") or 2)), str(int(style["margin_left"])),
            str(int(style["margin_right"])), str(int(style["margin_bottom"])), "1",
        ]),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    events: list[str] = []
    for cue in cues:
        lines = str(cue.get("current_text") or "").split("\n")
        font_size = _cue_font_size(lines, style, width)
        escaped = r"\N".join(pipeline.escape_ass_text(line) for line in lines)
        override = f"{{\\q2\\fn{font_family}\\fs{font_size}}}"
        events.append(
            f"Dialogue: 0,{_ass_timestamp(int(cue['start_ms']))},{_ass_timestamp(int(cue['end_ms']))},{name},,0,0,0,,{override}{escaped}"
        )
    return "\n".join([*header, *events, ""])


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("bridge input must be an object")
        pipeline = _load_pipeline()
        duration_ms = max(1, int(payload.get("duration_ms") or 1))
        words = _word_mappings(payload, pipeline)
        if not words:
            words = _fallback_words(payload, duration_ms)
        if not words:
            raise ValueError("subtitle input has no text")
        try:
            subtitle_offset_ms = int(round(float(payload.get("subtitle_offset_ms") or 0)))
        except (TypeError, ValueError, OverflowError):
            subtitle_offset_ms = 0
        words = _shift_words(words, subtitle_offset_ms, duration_ms)

        word_objects = [
            pipeline.SubtitleWord(
                str(item["text"]), int(item["start_ms"]), int(item["end_ms"]), item["confidence"]
            )
            for item in words
        ]
        script_text = str(payload.get("script_text") or payload.get("text") or "").strip()
        script_cues = _script_sentence_cues(
            script_text,
            words,
            duration_ms,
            payload.get("reference_timeline") if isinstance(payload.get("reference_timeline"), list) else [],
            subtitle_offset_ms,
            bool(payload.get("word_timings_measured")),
        ) if script_text and re.search(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]", script_text) else []
        semantic = pipeline.SubtitleSegmenter().segment(word_objects, duration_ms=duration_ms)
        segments = script_cues and [
            {
                "id": cue["id"],
                "sequence": cue["sequence"],
                "original_text": cue["current_text"],
                "current_text": cue["current_text"],
                "start_ms": cue["start_ms"],
                "end_ms": cue["end_ms"],
                "confidence": None,
                "low_confidence": False,
            }
            for cue in script_cues
        ] or [
            {
                "id": f"chensi-segment-{index}",
                "sequence": index,
                "original_text": segment.text,
                "current_text": segment.text,
                "start_ms": segment.start_ms,
                "end_ms": min(duration_ms, segment.end_ms),
                "confidence": segment.confidence,
                "low_confidence": segment.low_confidence,
            }
            for index, segment in enumerate(semantic)
        ]
        style = {
            "name": "Unified Subtitle",
            "font_family": OPEN_SUBTITLE_FONT_FAMILY,
            "font_size": 88,
            "primary_color": "&H00FFFFFF",
            "outline_color": "&H00000000",
            "outline_width": 4,
            "shadow_depth": 0,
            "alignment": 2,
            "margin_left": 48,
            "margin_right": 48,
            "margin_bottom": 400,
            "max_lines": 2,
        }
        style.update(payload.get("style") or {})
        width = max(1, int(payload.get("width") or 1080))
        height = max(1, int(payload.get("height") or 1920))
        style = _safe_subtitle_style(style, width, height)
        try:
            display_cues = script_cues or pipeline.DisplaySubtitleSegmenter().segment(
                words,
                segments,
                duration_ms=duration_ms,
                style=style,
                width=width,
                height=height,
            )
        except (TypeError, ValueError):
            # TiTok intentionally rejects an over-wide word-timed cue. Keep
            # the same semantic segmentation and render a readable ASS cue.
            display_cues = _semantic_cues(segments)
        display_cues = _limit_display_cues(display_cues)
        ass = _build_uniform_ass(display_cues, style, width, height, pipeline)
        print(json.dumps({"ok": True, "ass": ass, "segments": segments, "cues": display_cues}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
