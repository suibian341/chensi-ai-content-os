from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable, Mapping, Sequence


LOW_CONFIDENCE_THRESHOLD = 0.72
MAX_SEGMENT_SECONDS = 6.0
LONG_PAUSE_MS = 700
CJK_MAX_UNITS = 28
LATIN_MAX_UNITS = 84
SUBTITLE_LAYOUT_VERSION = "adaptive-layout-v4"
DISPLAY_SUBTITLE_SEGMENTATION_VERSION = "word-timed-display-cues-v2"

ENGLISH_LAYOUT_FONT_SIZES = (80, 76, 72, 68, 64)
ENGLISH_FONT_SIZE_SCALE = 1.25
ENGLISH_FONT_SIZES = tuple(
    round(size * ENGLISH_FONT_SIZE_SCALE) for size in ENGLISH_LAYOUT_FONT_SIZES
)
ENGLISH_EMPHASIS_FONT_SIZE_SCALE = 1.08
ENGLISH_MIN_FONT_SIZE = ENGLISH_FONT_SIZES[-1]
DISPLAY_SEGMENTATION_FONT_SIZES = ENGLISH_LAYOUT_FONT_SIZES
ENGLISH_TARGET_MAX_LINES = 1
ENGLISH_LEGACY_MAX_LINES = 2
ENGLISH_WIDTH_RATIO = 0.78
# Keep cue segmentation byte-for-byte compatible while the final fitting guard
# accounts for the v16 run-level rendered geometry.
ENGLISH_LAYOUT_SCALE_X = 86
ENGLISH_SCALE_X = 104
ENGLISH_SCALE_Y = 110
ENGLISH_FONT_FAMILY = "Noto Sans SC"
ENGLISH_FONT_WEIGHT = 900
ENGLISH_ITALIC = 1
ENGLISH_OUTLINE_WIDTH = 6
ENGLISH_SHADOW_X = 6
ENGLISH_SHADOW_Y = 10
ENGLISH_BLUR = 0.0
ENGLISH_SPACING = -2
ENGLISH_WIDTH_GUARD = 1.07
ENGLISH_FINAL_FONT_METRIC_RATIO = 0.839
ENGLISH_FINAL_W_UNIT = 1.015
ENGLISH_FINAL_HORIZONTAL_EFFECT_ALLOWANCE = ENGLISH_OUTLINE_WIDTH * 2 + ENGLISH_SHADOW_X
ENGLISH_FINAL_EDGE_CLEARANCE = 12
# Render English display cues above the lower UI-safe area while leaving CJK
# styles under their existing, independently configured profile.
ENGLISH_MARGIN_BOTTOM = 560

DISPLAY_STRONG_PAUSE_MS = 380
DISPLAY_TARGET_MIN_WORDS = 3
DISPLAY_TARGET_MAX_WORDS = 6
DISPLAY_HARD_MAX_WORDS = 8
DISPLAY_TARGET_MIN_DURATION_MS = 900
DISPLAY_TARGET_MAX_DURATION_MS = 2_200
DISPLAY_HARD_MAX_DURATION_MS = 3_000

_CJK_RE = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
_NO_SPACE_BEFORE = set(",.!?;:%)]}，。！？；：、）】》」』")
_NO_SPACE_AFTER = set("([{（【《「『")
_SENTENCE_END = set(".!?。！？；;")


@dataclass(frozen=True)
class SubtitleWord:
    text: str
    start_ms: int
    end_ms: int
    confidence: float | None = None


@dataclass(frozen=True)
class SubtitleSegment:
    text: str
    start_ms: int
    end_ms: int
    confidence: float | None
    low_confidence: bool


@dataclass(frozen=True)
class DisplaySubtitleCue:
    text: str
    start_ms: int
    end_ms: int
    word_timed: bool


@dataclass(frozen=True)
class _DisplayWord:
    text: str
    start_ms: int
    end_ms: int


def _display_units(text: str) -> int:
    return sum(2 if _CJK_RE.match(char) else 1 for char in text)


def _limit_for(text: str) -> int:
    return CJK_MAX_UNITS if _CJK_RE.search(text) else LATIN_MAX_UNITS


def _append_token(current: str, token: str) -> str:
    token = token.strip()
    if not current or not token:
        return current + token
    if _CJK_RE.search(current[-1]) or _CJK_RE.match(token[0]):
        return current + token
    if token[0] in _NO_SPACE_BEFORE or current[-1] in _NO_SPACE_AFTER:
        return current + token
    return f"{current} {token}"


def validate_words(words: Iterable[SubtitleWord], duration_ms: int) -> list[SubtitleWord]:
    normalized = list(words)
    previous_start = -1
    previous_end = -1
    tolerance_ms = 1500
    for word in normalized:
        if not word.text.strip() or word.start_ms < 0 or word.end_ms <= word.start_ms:
            raise ValueError("Transcription words contain invalid text or timestamps")
        if word.start_ms < previous_start:
            raise ValueError("Transcription words are not ordered by start time")
        if previous_end >= 0 and word.start_ms < previous_end - 100:
            raise ValueError("Transcription word timestamps overlap unexpectedly")
        if duration_ms > 0 and word.end_ms > duration_ms + tolerance_ms:
            raise ValueError("Transcription word timestamp exceeds media duration")
        if word.confidence is not None and not 0 <= word.confidence <= 1:
            raise ValueError("Transcription word confidence is invalid")
        previous_start = word.start_ms
        previous_end = word.end_ms
    return normalized


class SubtitleSegmenter:
    def segment(self, words: Sequence[SubtitleWord], *, duration_ms: int) -> list[SubtitleSegment]:
        valid = validate_words(words, duration_ms)
        if not valid:
            return []
        segments: list[SubtitleSegment] = []
        group: list[SubtitleWord] = []
        text = ""

        def flush() -> None:
            nonlocal group, text
            if not group:
                return
            confidences = [word.confidence for word in group if word.confidence is not None]
            confidence = sum(confidences) / len(confidences) if confidences else None
            segments.append(SubtitleSegment(
                text=text.strip(),
                start_ms=group[0].start_ms,
                end_ms=group[-1].end_ms,
                confidence=confidence,
                low_confidence=any(
                    word.confidence is not None and word.confidence < LOW_CONFIDENCE_THRESHOLD
                    for word in group
                ),
            ))
            group = []
            text = ""

        for index, word in enumerate(valid):
            candidate = _append_token(text, word.text)
            if group and _display_units(candidate) > _limit_for(candidate):
                flush()
                candidate = word.text.strip()
            group.append(word)
            text = candidate
            next_word = valid[index + 1] if index + 1 < len(valid) else None
            duration = group[-1].end_ms - group[0].start_ms
            pause = next_word.start_ms - word.end_ms if next_word else 0
            if (
                next_word is None
                or word.text.rstrip()[-1:] in _SENTENCE_END
                or pause >= LONG_PAUSE_MS
                or duration >= int(MAX_SEGMENT_SECONDS * 1000)
                or _display_units(text) >= _limit_for(text)
            ):
                flush()
        return segments


def ass_timestamp(milliseconds: int) -> str:
    centiseconds = max(0, int(milliseconds)) // 10
    hours, remainder = divmod(centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    seconds, fraction = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{fraction:02d}"


def escape_ass_text(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    normalized = normalized.replace("\\", r"\\")
    normalized = normalized.replace("{", r"\{").replace("}", r"\}")
    return normalized.replace("\n", r"\N")


def _is_cjk_dominant(text: str) -> bool:
    cjk = sum(1 for char in text if _CJK_RE.match(char))
    latin = sum(1 for char in text if char.isascii() and char.isalpha())
    return cjk > latin


def _is_english_display(text: str, language: str | None) -> bool:
    normalized = str(language or "").strip().lower().replace("_", "-")
    if normalized:
        if normalized == "english" or normalized == "en" or normalized.startswith("en-"):
            return True
        if normalized not in {"auto", "unknown", "und"}:
            return False
    return not _is_cjk_dominant(text)


def format_english_display_text(text: str) -> str:
    def capitalize_token(match: re.Match[str]) -> str:
        token = match.group(0)
        for index, character in enumerate(token):
            if character.isalpha():
                return token[:index] + character.upper() + token[index + 1:]
        return token

    return re.sub(r"\S+", capitalize_token, text)


def _latin_character_unit(char: str, *, w_unit: float) -> float:
    if char.isspace():
        return 0.32
    if char in "ilIjtfr.,'`!:;|":
        return 0.30
    if char in "wW":
        return w_unit
    if char in "mM@#%&":
        return 0.84
    if char.isupper():
        return 0.66
    if char.isdigit():
        return 0.57
    return 0.52


def _latin_text_units(text: str, *, w_unit: float = 0.84) -> float:
    return sum(_latin_character_unit(char, w_unit=w_unit) for char in text)


def _latin_text_width(text: str, font_size: int) -> float:
    """Estimate width for the frozen display-cue segmentation contract."""
    units = _latin_text_units(text)
    return units * font_size * ENGLISH_LAYOUT_SCALE_X / 100 * ENGLISH_WIDTH_GUARD


def _latin_final_visible_width(
    text: str,
    font_size: int,
    *,
    emphasis_spans: Sequence[tuple[int, int]] = (),
    english_transform: bool = True,
) -> float:
    """Estimate v16 run-level glyphs plus horizontal effects."""
    measured_text = format_english_display_text(text) if english_transform else text
    base_render_size = max(1, round(font_size * ENGLISH_FONT_SIZE_SCALE))
    emphasis_render_size = max(
        1, round(base_render_size * ENGLISH_EMPHASIS_FONT_SIZE_SCALE)
    )
    scaled_units = 0.0
    for index, char in enumerate(measured_text):
        render_size = (
            emphasis_render_size
            if any(start <= index < end for start, end in emphasis_spans)
            else base_render_size
        )
        scaled_units += (
            _latin_character_unit(char, w_unit=ENGLISH_FINAL_W_UNIT) * render_size
        )
    glyph_width = (
        scaled_units * ENGLISH_SCALE_X / 100 * ENGLISH_FINAL_FONT_METRIC_RATIO
    )
    return glyph_width + ENGLISH_FINAL_HORIZONTAL_EFFECT_ALLOWANCE


def _fits_final_visible_width(
    text: str,
    font_size: int,
    width: int,
    *,
    emphasis_spans: Sequence[tuple[int, int]] = (),
    english_transform: bool = True,
) -> bool:
    max_width = max(1, int(width)) - ENGLISH_FINAL_EDGE_CLEARANCE * 2
    return _latin_final_visible_width(
        text,
        font_size,
        emphasis_spans=emphasis_spans,
        english_transform=english_transform,
    ) <= max_width


def _latin_line_breaks(text: str, *, font_size: int, max_width: float, max_lines: int) -> list[str] | None:
    words = text.split()
    if not words:
        return [""]
    widths = [[_latin_text_width(" ".join(words[start:end]), font_size)
               for end in range(start + 1, len(words) + 1)]
              for start in range(len(words))]
    candidates: list[tuple[float, tuple[str, ...]]] = []
    for line_count in range(1, max_lines + 1):
        def visit(start: int, remaining: int, lines: list[str], line_widths: list[float]) -> None:
            if remaining == 1:
                line = " ".join(words[start:])
                width = _latin_text_width(line, font_size)
                if width <= max_width:
                    candidates.append((max([*line_widths, width]), tuple([*lines, line])))
                return
            for end in range(start + 1, len(words) - remaining + 2):
                width = widths[start][end - start - 1]
                if width > max_width:
                    break
                visit(end, remaining - 1, [*lines, " ".join(words[start:end])], [*line_widths, width])

        if len(words) >= line_count:
            visit(0, line_count, [], [])
        if candidates:
            # Fewer lines are preferred; among those, minimize the widest line.
            return list(min(candidates, key=lambda candidate: candidate[0])[1])
    return None


def _english_layout(
    text: str,
    style: Mapping[str, object],
    width: int,
    height: int,
    *,
    word_timed: bool,
    emphasis_spans: Sequence[tuple[int, int]] = (),
    english_transform: bool = True,
) -> tuple[int, list[str], int, int, int, bool]:
    base_size = min(
        int(float(style.get("font_size") or ENGLISH_LAYOUT_FONT_SIZES[0])),
        ENGLISH_LAYOUT_FONT_SIZES[0],
    )
    sizes = tuple(size for size in ENGLISH_LAYOUT_FONT_SIZES if size <= base_size)
    if not sizes:
        sizes = (base_size,)
    target_width = max(1.0, max(1, int(width)) * ENGLISH_WIDTH_RATIO)
    margin_bottom = max(0, round(max(1, int(height)) * ENGLISH_MARGIN_BOTTOM / 1920))
    for font_size in sizes:
        lines = _latin_line_breaks(
            text, font_size=font_size, max_width=target_width, max_lines=ENGLISH_TARGET_MAX_LINES,
        )
        if lines is not None and _lines_fit_final_visible_width(
            text,
            lines,
            font_size,
            width,
            emphasis_spans=emphasis_spans,
            english_transform=english_transform,
        ):
            margin = max(0, round((width - target_width) / 2))
            return font_size, lines, margin, margin, margin_bottom, True

    if word_timed:
        raise ValueError("Word-timed English display cue exceeds the single-line safe width")

    # A manually rewritten segment cannot borrow word-level precision. Keep
    # its semantic timing and allow the old two-line fallback rather than
    # inventing timestamps or dropping text.
    for font_size in sizes:
        lines = _latin_line_breaks(
            text, font_size=font_size, max_width=target_width, max_lines=ENGLISH_LEGACY_MAX_LINES,
        )
        if lines is not None and _lines_fit_final_visible_width(
            text,
            lines,
            font_size,
            width,
            emphasis_spans=emphasis_spans,
            english_transform=english_transform,
        ):
            margin = max(0, round((width - target_width) / 2))
            return font_size, lines, margin, margin, margin_bottom, True

    lines = _latin_line_breaks(
        text, font_size=sizes[-1], max_width=float(width), max_lines=ENGLISH_LEGACY_MAX_LINES,
    )
    if lines is not None:
        return sizes[-1], lines, 0, 0, margin_bottom, True
    return sizes[-1], [text], 0, 0, margin_bottom, False


def _lines_fit_final_visible_width(
    source: str,
    lines: Sequence[str],
    font_size: int,
    width: int,
    *,
    emphasis_spans: Sequence[tuple[int, int]],
    english_transform: bool,
) -> bool:
    for line, (line_start, line_end) in zip(lines, _layout_line_ranges(source, lines)):
        line_spans = [
            (
                max(line_start, span_start) - line_start,
                min(line_end, span_end) - line_start,
            )
            for span_start, span_end in emphasis_spans
            if span_end > line_start and span_start < line_end
        ]
        if not _fits_final_visible_width(
            line,
            font_size,
            width,
            emphasis_spans=line_spans,
            english_transform=english_transform,
        ):
            return False
    return True


def _normalized_alignment_token(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(char for char in normalized if char.isalnum())


def _edited_tokens(value: str) -> list[str]:
    normalized = re.sub(r"\s+([,.;:!?%\)\]\}]+)", r"\1", value.strip())
    normalized = re.sub(r"([\(\[\{]+)\s+", r"\1", normalized)
    return normalized.split()


def _join_display_words(words: Sequence[_DisplayWord]) -> str:
    text = ""
    for word in words:
        text = _append_token(text, word.text)
    return text.strip()


def _ends_with_strong_punctuation(value: str) -> bool:
    return bool(re.search(r"[.!?;:][\"'\)\]]*$", value.rstrip()))


def _ends_with_comma(value: str) -> bool:
    return bool(re.search(r",[\"'\)\]]*$", value.rstrip()))


def _preferred_display_font_rank(
    text: str,
    style: Mapping[str, object],
    width: int,
) -> int:
    base_size = min(
        int(float(style.get("font_size") or DISPLAY_SEGMENTATION_FONT_SIZES[0])),
        DISPLAY_SEGMENTATION_FONT_SIZES[0],
    )
    sizes = tuple(size for size in DISPLAY_SEGMENTATION_FONT_SIZES if size <= base_size) or (base_size,)
    max_width = max(1.0, max(1, int(width)) * ENGLISH_WIDTH_RATIO)
    for rank, font_size in enumerate(sizes):
        if _latin_line_breaks(
            text,
            font_size=font_size,
            max_width=max_width,
            max_lines=ENGLISH_TARGET_MAX_LINES,
        ) is not None:
            return rank
    return len(sizes) + 2


class DisplaySubtitleSegmenter:
    """Derive render-only cues without changing transcript semantic segments."""

    _CONJUNCTIONS = frozenset({"and", "but", "or", "so", "because", "while"})

    def segment(
        self,
        words: Sequence[Mapping[str, object]],
        segments: Sequence[Mapping[str, object]],
        *,
        duration_ms: int,
        style: Mapping[str, object],
        width: int,
        height: int,
    ) -> list[dict[str, object]]:
        del height  # Reserved for future render-height-specific scoring.
        ordered_segments = sorted(segments, key=lambda item: int(item["sequence"]))
        fallback = self._fallback_cues(ordered_segments, duration_ms)
        if not ordered_segments:
            return []
        all_text = " ".join(str(item.get("current_text") or "") for item in ordered_segments)
        if _CJK_RE.search(all_text):
            return self._as_mappings(fallback)

        try:
            source_words = validate_words(
                [
                    SubtitleWord(
                        str(item["text"]),
                        int(item["start_ms"]),
                        int(item["end_ms"]),
                        float(item["confidence"]) if item.get("confidence") is not None else None,
                    )
                    for item in sorted(words, key=lambda item: int(item["sequence"]))
                ],
                duration_ms,
            )
        except (KeyError, TypeError, ValueError):
            return self._as_mappings(fallback)
        if not source_words or source_words[-1].end_ms > duration_ms:
            return self._as_mappings(fallback)

        cues: list[DisplaySubtitleCue] = []
        aligned_chunk: list[_DisplayWord] = []
        used_word_indexes: set[int] = set()

        def flush_aligned() -> None:
            nonlocal aligned_chunk
            if aligned_chunk:
                cues.extend(self._partition(aligned_chunk, style, width))
                aligned_chunk = []

        for segment in ordered_segments:
            start_ms, end_ms = int(segment["start_ms"]), int(segment["end_ms"])
            contained = [
                (index, word)
                for index, word in enumerate(source_words)
                if index not in used_word_indexes
                and word.start_ms >= start_ms
                and word.end_ms <= end_ms
            ]
            aligned = self._align_segment(segment, [word for _, word in contained])
            if aligned is None:
                flush_aligned()
                cues.append(DisplaySubtitleCue(
                    str(segment.get("current_text") or "").strip(), start_ms, end_ms, False,
                ))
                continue
            used_word_indexes.update(index for index, _ in contained)
            aligned_chunk.extend(aligned)
        flush_aligned()

        self._validate_cues(cues, duration_ms)
        return self._as_mappings(cues)

    @staticmethod
    def _fallback_cues(
        segments: Sequence[Mapping[str, object]], duration_ms: int,
    ) -> list[DisplaySubtitleCue]:
        cues: list[DisplaySubtitleCue] = []
        previous_end = -1
        for segment in segments:
            text = str(segment.get("current_text") or "").strip()
            start_ms, end_ms = int(segment["start_ms"]), int(segment["end_ms"])
            if (
                not text
                or start_ms < 0
                or end_ms <= start_ms
                or start_ms < previous_end
                or end_ms > duration_ms
            ):
                raise ValueError("Subtitle segment timestamps are invalid")
            cues.append(DisplaySubtitleCue(text, start_ms, end_ms, False))
            previous_end = end_ms
        return cues

    @staticmethod
    def _align_segment(
        segment: Mapping[str, object], source_words: Sequence[SubtitleWord],
    ) -> list[_DisplayWord] | None:
        if not source_words:
            return None
        original_tokens = _edited_tokens(str(segment.get("original_text") or ""))
        current_tokens = _edited_tokens(str(segment.get("current_text") or ""))
        if len(original_tokens) != len(source_words) or len(current_tokens) != len(source_words):
            return None
        source_keys = [_normalized_alignment_token(word.text) for word in source_words]
        original_keys = [_normalized_alignment_token(token) for token in original_tokens]
        current_keys = [_normalized_alignment_token(token) for token in current_tokens]
        if not all(source_keys) or source_keys != original_keys or not all(current_keys):
            return None

        replacements = 0
        for source_key, current_key in zip(source_keys, current_keys):
            if source_key == current_key:
                continue
            replacements += 1
            if SequenceMatcher(None, source_key, current_key, autojunk=False).ratio() < 0.72:
                return None
        if replacements > max(1, len(source_words) // 5):
            return None
        return [
            _DisplayWord(token, word.start_ms, word.end_ms)
            for token, word in zip(current_tokens, source_words)
        ]

    def _partition(
        self,
        words: Sequence[_DisplayWord],
        style: Mapping[str, object],
        width: int,
    ) -> list[DisplaySubtitleCue]:
        blocks: list[list[_DisplayWord]] = []
        current: list[_DisplayWord] = []
        for index, word in enumerate(words):
            current.append(word)
            next_word = words[index + 1] if index + 1 < len(words) else None
            gap_ms = next_word.start_ms - word.end_ms if next_word else 0
            if (
                next_word is None
                or gap_ms >= DISPLAY_STRONG_PAUSE_MS
                or _ends_with_strong_punctuation(word.text)
            ):
                blocks.append(current)
                current = []
        cues: list[DisplaySubtitleCue] = []
        for block in blocks:
            cues.extend(self._partition_block(block, style, width))
        return cues

    def _partition_block(
        self,
        words: Sequence[_DisplayWord],
        style: Mapping[str, object],
        width: int,
    ) -> list[DisplaySubtitleCue]:
        size = len(words)
        best: list[tuple[float, int, tuple[int, ...]] | None] = [None] * (size + 1)
        best[0] = (0.0, 0, ())
        for end in range(1, size + 1):
            candidates: list[tuple[float, int, tuple[int, ...]]] = []
            for start in range(max(0, end - DISPLAY_HARD_MAX_WORDS), end):
                prefix = best[start]
                if prefix is None:
                    continue
                cue_words = words[start:end]
                duration = cue_words[-1].end_ms - cue_words[0].start_ms
                if duration > DISPLAY_HARD_MAX_DURATION_MS and len(cue_words) > 1:
                    continue
                if duration < 500 and not (start == 0 and end == size):
                    continue
                if (
                    len(cue_words) > 1
                    and _preferred_display_font_rank(_join_display_words(cue_words), style, width)
                    >= len(DISPLAY_SEGMENTATION_FONT_SIZES)
                ):
                    continue
                if end < size and words[end].start_ms < words[end - 1].end_ms:
                    continue
                cost = prefix[0] + self._cue_cost(cue_words, words[end] if end < size else None, style, width)
                candidates.append((cost, prefix[1] + 1, (*prefix[2], end)))
            if candidates:
                best[end] = min(candidates, key=lambda item: (round(item[0], 9), item[1], item[2]))
        if best[size] is None:
            return [DisplaySubtitleCue(_join_display_words(words), words[0].start_ms, words[-1].end_ms, True)]

        boundaries = best[size][2]
        cues: list[DisplaySubtitleCue] = []
        start = 0
        for end in boundaries:
            cue_words = words[start:end]
            cues.append(DisplaySubtitleCue(
                _join_display_words(cue_words), cue_words[0].start_ms, cue_words[-1].end_ms, True,
            ))
            start = end
        return cues

    def _cue_cost(
        self,
        words: Sequence[_DisplayWord],
        next_word: _DisplayWord | None,
        style: Mapping[str, object],
        width: int,
    ) -> float:
        count = len(words)
        duration = words[-1].end_ms - words[0].start_ms
        if DISPLAY_TARGET_MIN_WORDS <= count <= DISPLAY_TARGET_MAX_WORDS:
            word_cost = abs(count - 4.5) * 0.24
        elif count == 2:
            word_cost = 3.0
        elif count == 1:
            word_cost = 12.0
        else:
            word_cost = 3.0 + (count - DISPLAY_TARGET_MAX_WORDS) * 3.0

        if DISPLAY_TARGET_MIN_DURATION_MS <= duration <= DISPLAY_TARGET_MAX_DURATION_MS:
            duration_cost = abs(duration - 1_450) / 5_000
        elif 700 <= duration < DISPLAY_TARGET_MIN_DURATION_MS:
            duration_cost = 1.0 + (DISPLAY_TARGET_MIN_DURATION_MS - duration) / 250
        elif 500 <= duration < 700:
            duration_cost = 5.0 + (700 - duration) / 100
        elif duration < 500:
            duration_cost = 18.0 + (500 - duration) / 40
        elif duration <= 2_600:
            duration_cost = 0.8 + (duration - DISPLAY_TARGET_MAX_DURATION_MS) / 400
        else:
            duration_cost = 2.0 + (duration - 2_600) / 250

        text = _join_display_words(words)
        font_rank = _preferred_display_font_rank(text, style, width)
        font_cost = (0.0, 1.4, 4.5, 9.0, 14.0)[font_rank] if font_rank < 5 else 30.0
        boundary_reward = 0.0
        if _ends_with_comma(words[-1].text):
            boundary_reward += 8.0
        if next_word is not None:
            gap_ms = next_word.start_ms - words[-1].end_ms
            if gap_ms >= 250:
                boundary_reward += 0.4
            if _normalized_alignment_token(next_word.text) in self._CONJUNCTIONS:
                boundary_reward += 0.35
        tail_cost = 0.0
        if next_word is None and _normalized_alignment_token(words[0].text) in {
            "based", "for", "on", "to", "with",
        }:
            tail_cost = 45.0
        return 1.0 + word_cost + duration_cost + font_cost + tail_cost - boundary_reward

    @staticmethod
    def _validate_cues(cues: Sequence[DisplaySubtitleCue], duration_ms: int) -> None:
        previous_end = -1
        for cue in cues:
            if (
                not cue.text
                or cue.start_ms < 0
                or cue.end_ms <= cue.start_ms
                or cue.start_ms < previous_end
                or cue.end_ms > duration_ms
            ):
                raise ValueError("Display subtitle segmentation produced an invalid timeline")
            previous_end = cue.end_ms

    @staticmethod
    def _as_mappings(cues: Sequence[DisplaySubtitleCue]) -> list[dict[str, object]]:
        return [
            {
                "id": f"display-{sequence:04d}",
                "sequence": sequence,
                "current_text": cue.text,
                "start_ms": cue.start_ms,
                "end_ms": cue.end_ms,
                "word_timed": cue.word_timed,
            }
            for sequence, cue in enumerate(cues)
        ]


def _wrap_ass_text(text: str, max_lines: int) -> str:
    if max_lines < 2 or "\n" in text:
        return escape_ass_text(text)
    limit = _limit_for(text)
    if _display_units(text) <= limit // 2:
        return escape_ass_text(text)
    midpoint = len(text) // 2
    candidates = [index for index, char in enumerate(text) if char.isspace() or char in "，。！？；,.!?;"]
    split = min(candidates, key=lambda index: abs(index - midpoint)) if candidates else midpoint
    left, right = text[:split].rstrip(), text[split:].lstrip()
    if not left or not right:
        return escape_ass_text(text)
    return f"{escape_ass_text(left)}\\N{escape_ass_text(right)}"


def _wrapped_text_ranges(text: str, max_lines: int) -> list[tuple[int, int]]:
    if max_lines < 2 or "\n" in text or _display_units(text) <= _limit_for(text) // 2:
        return [(0, len(text))]
    midpoint = len(text) // 2
    candidates = [
        index for index, char in enumerate(text)
        if char.isspace() or char in "，。！？；,.!?;"
    ]
    split = min(candidates, key=lambda index: abs(index - midpoint)) if candidates else midpoint
    left_end = len(text[:split].rstrip())
    right_start = split + len(text[split:]) - len(text[split:].lstrip())
    if left_end <= 0 or right_start >= len(text):
        return [(0, len(text))]
    return [(0, left_end), (right_start, len(text))]


def _layout_line_ranges(text: str, lines: Sequence[str]) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    cursor = 0
    for line in lines:
        found = text.find(line, cursor)
        if found >= 0:
            ranges.append((found, found + len(line)))
            cursor = found + len(line)
            continue
        tokens = line.split()
        if not tokens:
            ranges.append((cursor, cursor))
            continue
        start = text.find(tokens[0], cursor)
        if start < 0:
            raise ValueError("Subtitle line cannot be mapped to its source text")
        end = start
        search = start
        for token in tokens:
            token_start = text.find(token, search)
            if token_start < 0:
                raise ValueError("Subtitle line cannot be mapped to its source text")
            end = token_start + len(token)
            search = end
        ranges.append((start, end))
        cursor = end
    return ranges


def _format_english_display_slice(text: str, start: int, end: int) -> str:
    rendered: list[str] = []
    for index in range(start, end):
        character = text[index]
        token_start = index
        while token_start > 0 and not text[token_start - 1].isspace():
            token_start -= 1
        token_end = token_start
        while token_end < len(text) and not text[token_end].isspace():
            token_end += 1
        first_alpha = next(
            (
                candidate
                for candidate in range(token_start, token_end)
                if text[candidate].isalpha()
            ),
            -1,
        )
        rendered.append(character.upper() if index == first_alpha else character)
    return "".join(rendered)


_ASS_OVERRIDE_COLOR_RE = re.compile(r"^&H[0-9A-Fa-f]{6}&$")


def _cue_emphasis_spans(
    segment: Mapping[str, object],
    emphasis: Mapping[str, object] | None,
) -> tuple[list[tuple[int, int]], str, str]:
    if not emphasis or not bool(emphasis.get("enabled")):
        return [], "&HFFFFFF&", "&H00FFFF&"
    normal_color = str(emphasis.get("normal_color") or "")
    emphasis_color = str(emphasis.get("emphasis_color") or "")
    if not _ASS_OVERRIDE_COLOR_RE.fullmatch(normal_color) or not _ASS_OVERRIDE_COLOR_RE.fullmatch(
        emphasis_color
    ):
        raise ValueError("Subtitle emphasis colors are invalid")
    cue_id = str(segment.get("id") or "")
    source = str(segment.get("current_text") or "")
    raw_spans = emphasis.get("spans")
    if not isinstance(raw_spans, list):
        raise ValueError("Subtitle emphasis spans are invalid")
    spans: list[tuple[int, int]] = []
    for span in raw_spans:
        if not isinstance(span, Mapping) or str(span.get("cue_id") or "") != cue_id:
            continue
        start, end = span.get("start"), span.get("end")
        phrase = span.get("text")
        if (
            isinstance(start, bool) or not isinstance(start, int)
            or isinstance(end, bool) or not isinstance(end, int)
            or not isinstance(phrase, str)
            or start < 0 or end <= start or end > len(source)
            or source[start:end] != phrase
        ):
            raise ValueError("Subtitle emphasis spans are invalid")
        spans.append((start, end))
    spans.sort()
    if any(start < previous[1] for previous, (start, _) in zip(spans, spans[1:])):
        raise ValueError("Subtitle emphasis spans overlap")
    return spans, normal_color.upper(), emphasis_color.upper()


def _styled_text_range(
    source: str,
    start: int,
    end: int,
    spans: Sequence[tuple[int, int]],
    *,
    normal_color: str,
    emphasis_color: str,
    english_transform: bool,
    normal_font_size: int | None = None,
    emphasis_font_size: int | None = None,
) -> str:
    boundaries = {start, end}
    for span_start, span_end in spans:
        if span_end <= start or span_start >= end:
            continue
        boundaries.add(max(start, span_start))
        boundaries.add(min(end, span_end))
    ordered = sorted(boundaries)
    def override(color: str, font_size: int | None = None) -> str:
        size = f"\\fs{font_size}" if font_size is not None else ""
        return f"{{\\1c{color}{size}}}"

    rendered = [override(normal_color)]
    highlighted = False
    for run_start, run_end in zip(ordered, ordered[1:]):
        run_highlighted = any(
            span_start <= run_start and run_end <= span_end
            for span_start, span_end in spans
        )
        if run_highlighted != highlighted:
            rendered.append(override(
                emphasis_color if run_highlighted else normal_color,
                emphasis_font_size if run_highlighted else normal_font_size,
            ))
            highlighted = run_highlighted
        raw = (
            _format_english_display_slice(source, run_start, run_end)
            if english_transform
            else source[run_start:run_end]
        )
        rendered.append(escape_ass_text(raw))
    if highlighted:
        rendered.append(override(normal_color, normal_font_size))
    return "".join(rendered)


class AssSubtitleBuilder:
    def build(
        self,
        segments: Sequence[Mapping[str, object]],
        style: Mapping[str, object],
        *,
        width: int,
        height: int,
        language: str | None = None,
        emphasis: Mapping[str, object] | None = None,
    ) -> str:
        font_family = str(style.get("font_family") or "Noto Sans SC").replace(",", " ")
        name = str(style.get("name") or "Standard").replace(",", " ")
        header = [
            "[Script Info]",
            "ScriptType: v4.00+",
            "WrapStyle: 0",
            "ScaledBorderAndShadow: yes",
            f"PlayResX: {max(1, int(width))}",
            f"PlayResY: {max(1, int(height))}",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
            "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
            "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            "Style: " + ",".join([
                name,
                font_family,
                str(float(style.get("font_size") or 56)),
                str(style.get("primary_color") or "&H00FFFFFF"),
                "&H00FFFFFF",
                str(style.get("outline_color") or "&H00000000"),
                "&H00000000",
                "0", "0", "0", "0", "100", "100", "0", "0", "1",
                str(float(style.get("outline_width") or 0)),
                str(float(style.get("shadow_depth") or 0)),
                str(int(style.get("alignment") or 2)),
                str(int(style.get("margin_left") or 48)),
                str(int(style.get("margin_right") or 48)),
                str(int(style.get("margin_bottom") or 72)),
                "1",
            ]),
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        ]
        max_lines = int(style.get("max_lines") or 2)
        events: list[str] = []
        for segment in segments:
            start_ms, end_ms = int(segment["start_ms"]), int(segment["end_ms"])
            if start_ms < 0 or end_ms <= start_ms:
                raise ValueError("Subtitle segment timestamps are invalid")
            source_text = str(segment.get("current_text") or "")
            spans, normal_color, emphasis_color = _cue_emphasis_spans(segment, emphasis)
            if _is_cjk_dominant(source_text):
                if spans:
                    text = r"\N".join(
                        _styled_text_range(
                            source_text,
                            line_start,
                            line_end,
                            spans,
                            normal_color=normal_color,
                            emphasis_color=emphasis_color,
                            english_transform=False,
                        )
                        for line_start, line_end in _wrapped_text_ranges(source_text, max_lines)
                    )
                else:
                    text = _wrap_ass_text(source_text, max_lines)
                margin_left = margin_right = margin_bottom = 0
            else:
                english_display = _is_english_display(source_text, language)
                font_size, lines, margin_left, margin_right, margin_bottom, disable_auto_wrap = _english_layout(
                    source_text,
                    style,
                    width,
                    height,
                    word_timed=bool(segment.get("word_timed")),
                    emphasis_spans=spans,
                    english_transform=english_display,
                )
                render_font_size = max(1, round(font_size * ENGLISH_FONT_SIZE_SCALE))
                emphasis_font_size = max(
                    1, round(render_font_size * ENGLISH_EMPHASIS_FONT_SIZE_SCALE)
                )
                blur_override = f"\\blur{ENGLISH_BLUR:g}" if ENGLISH_BLUR > 0 else ""
                raw_layout_lines = list(lines)
                if english_display:
                    lines = [format_english_display_text(line) for line in lines]
                    visual_override = (
                        f"\\fn{ENGLISH_FONT_FAMILY}\\b{ENGLISH_FONT_WEIGHT}\\i{ENGLISH_ITALIC}"
                        f"\\fscx{ENGLISH_SCALE_X}\\fscy{ENGLISH_SCALE_Y}"
                        f"\\fsp{ENGLISH_SPACING}\\bord{ENGLISH_OUTLINE_WIDTH}"
                        f"\\xshad{ENGLISH_SHADOW_X}\\yshad{ENGLISH_SHADOW_Y}"
                        f"{blur_override}"
                        "\\1c&HFFFFFF&\\3c&H000000&\\4c&H000000&\\4a&H00&"
                        f"\\fs{render_font_size}"
                    )
                else:
                    visual_override = (
                        f"\\fn{ENGLISH_FONT_FAMILY}\\b{ENGLISH_FONT_WEIGHT}\\i{ENGLISH_ITALIC}"
                        f"\\fscx{ENGLISH_SCALE_X}\\fscy{ENGLISH_SCALE_Y}"
                        f"\\fsp{ENGLISH_SPACING}\\bord{ENGLISH_OUTLINE_WIDTH}"
                        f"\\xshad{ENGLISH_SHADOW_X}\\yshad{ENGLISH_SHADOW_Y}"
                        f"{blur_override}"
                        "\\1c&HFFFFFF&\\3c&H000000&\\4c&H000000&\\4a&H00&"
                        f"\\fs{render_font_size}"
                    )
                override = f"\\q2{visual_override}" if disable_auto_wrap else visual_override
                # q2 prevents libass from adding a second, implicit wrapping
                # pass after this word-boundary layout has selected the lines.
                if spans:
                    line_ranges = _layout_line_ranges(source_text, raw_layout_lines)
                    rendered_lines = [
                        _styled_text_range(
                            source_text,
                            line_start,
                            line_end,
                            spans,
                            normal_color=normal_color,
                            emphasis_color=emphasis_color,
                            english_transform=english_display,
                            normal_font_size=render_font_size,
                            emphasis_font_size=emphasis_font_size,
                        )
                        for line_start, line_end in line_ranges
                    ]
                    text = f"{{{override}}}" + r"\N".join(rendered_lines)
                else:
                    text = f"{{{override}}}" + r"\N".join(escape_ass_text(line) for line in lines)
            events.append(
                f"Dialogue: 0,{ass_timestamp(start_ms)},{ass_timestamp(end_ms)},{name},,"
                f"{margin_left},{margin_right},{margin_bottom},,{text}"
            )
        return "\n".join([*header, *events, ""])
