"""Secret-key matching for the public BOT ERRORS card.

The dispatcher's card pass (public_card_keyed_values) removes each secret
key's whole value from text that main's redactor (bot_errors_redaction.py)
has already redacted and the dispatcher has cut to PUBLIC_CARD_SCAN_MAX_CHARS
characters. These helpers find the key and measure its value. The shared
redactor keeps its own rules; nothing here changes what is stored.
"""

from __future__ import annotations

import re
from bisect import bisect_left

# The card's secret-bearing key words, in this order. A space in a word matches
# "_", "-" or nothing. A key matches when it ENDS in a word, after any number of
# "<alnum>_" segments (HTTP_PROXY_AUTHORIZATION, AWS_SECRET_ACCESS_KEY,
# github_pat) or after a hyphen, which is a word boundary (Proxy-Authorization,
# x-auth-token). A word from GLUED_KEY_WORDS also matches glued to a prefix
# (proxyAuthorization, sessionToken, clientsecret). Case never matters. Benign
# tails (event_count, message_id, session_id, compat) are not key words. The
# card matches the CARD_ supersets.
SECRET_KEY_WORDS = (
    "api key", "client secret", "secret access key", "access token", "refresh token", "auth token",
    "authorization", "cookie", "credential", "password", "passphrase", "secret", "session", "token", "pat",
)
GLUED_KEY_WORDS = ("token", "secret", "password", "passphrase", "api key", "authorization", "credential")
CARD_SECRET_KEY_WORDS = SECRET_KEY_WORDS + ("passwd", "pwd", "auth")
CARD_GLUED_KEY_WORDS = GLUED_KEY_WORDS + ("cookie", "passwd", "pwd")


def _key_word_pattern(word: str) -> str:
    # C1 (ReDoS): "api key" may carry a prefix and a suffix, bounded to 20
    # characters each; an unbounded run backtracked quadratically on "1.1.1.…".
    if word == "api key":
        return r"[A-Za-z0-9_.-]{0,20}api[_-]?key[A-Za-z0-9_.-]{0,20}"
    return word.replace(" ", "[_-]?")


def secret_key_pattern(words: tuple[str, ...], glued: tuple[str, ...]) -> re.Pattern[str]:
    """A secret key and its separator; the value is measured by keyed_value_span.

    Groups: 1 the character before the key, 2 the key, 3 a ":" or "="
    separator, 4 instead the "," between a quoted key and a quoted value in a
    header pair (rawHeaders ['Authorization', 'Token x'], ('Authorization', 'Basic x')).
    Each compound segment ends in a literal "_" and the glued prefix is bounded,
    so the scan stays linear.
    """
    glued_words = "|".join(_key_word_pattern(word).replace("[A-Za-z0-9_.-]{0,20}", "") for word in glued)
    alternatives = [_key_word_pattern(word) for word in words] + [r"[A-Za-z0-9]{1,40}(?:" + glued_words + ")"]
    return re.compile(
        r"(^|[^A-Za-z0-9_]|\\n)"
        r"((?:[A-Za-z0-9]+_)*(?:" + "|".join(alternatives) + r"))"
        r"(?:\\*[\"'])?(?:\s*([:=])|(?<=[\"'])\s*(,)(?=[ \t]*\\*[\"']))",
        re.IGNORECASE,
    )


# A value line ends at a newline, a carriage return, or an escaped "\n" in
# single-line text. A following line that starts with a space or a tab is a
# folded continuation (header obs-fold, a wrapped credential) and belongs to it.
LINE_BREAK_RE = re.compile(r"\r\n|\r|\n|\\n")
# A value's opening quote, also escaped once or more inside escaped JSON.
VALUE_OPENER_RE = re.compile(r"\\*[\"']")
BLANKS_RE = re.compile(r"[ \t]*")
WHITESPACE_RE = re.compile(r"\s*")
# After a non-authorization secret key, a scheme word goes with the credential
# after it; a Digest value spans spaces, commas and quotes, so it goes whole.
SECRET_SCHEME_WORD_RE = re.compile(r"(Bearer|Basic|Token|Digest|Negotiate)\s+", re.IGNORECASE)
SECRET_VALUE_TOKEN_RE = re.compile(r"[^\s\\,\"';}]+")


def _closing_quote(text: str, start: int, end: int, opener: str) -> int:
    """Index of the quote that closes `opener` (the same run of backslashes before it) in text[start:end], or -1."""
    quote = opener[-1]
    escapes = len(opener) - 1
    position = text.find(quote, start, end)
    while position != -1:
        run = 0
        while position - run - 1 >= start and text[position - run - 1] == "\\":
            run += 1
        if run == escapes:
            return position - escapes
        position = text.find(quote, position + 1, end)
    return -1


def folded_line_end(text: str, start: int) -> int:
    """End of the line holding `start`, carried through folded continuation lines."""
    position = start
    while True:
        line_break = LINE_BREAK_RE.search(text, position)
        if line_break is None:
            return len(text)
        if line_break.end() < len(text) and text[line_break.end()] in " \t":
            position = line_break.end()
            continue
        return line_break.start()


class FoldedLineEnds:
    """folded_line_end for many positions of one text, from one scan of its line breaks.

    keyed_value_span asks for the folded line end at every value. Searching
    from each value made the key/value scan quadratic: on a single line the
    search ran to the end of the text for every value, and in pretty-printed
    JSON every indented line is a folded continuation, so it walked every
    later line. The breaks are found once, left to right as LINE_BREAK_RE
    finds them, and each lookup is a binary search returning exactly what
    folded_line_end returns.
    """

    __slots__ = ("_text", "_starts", "_ends", "_line_ends")

    def __init__(self, text: str) -> None:
        self._text = text
        self._starts: list[int] | None = None
        self._ends: list[int] = []
        self._line_ends: list[int] = []

    def _index(self) -> list[int]:
        text = self._text
        starts: list[int] = []
        ends: list[int] = []
        for line_break in LINE_BREAK_RE.finditer(text):
            starts.append(line_break.start())
            ends.append(line_break.end())
        # A break that a space or tab follows is folded: its line ends where
        # the next break's line ends, or at the end of the text.
        line_ends = [0] * len(starts)
        following = len(text)
        for index in range(len(starts) - 1, -1, -1):
            folded = ends[index] < len(text) and text[ends[index]] in " \t"
            line_ends[index] = following if folded else starts[index]
            following = line_ends[index]
        self._starts, self._ends, self._line_ends = starts, ends, line_ends
        return starts

    def at(self, start: int) -> int:
        starts = self._starts if self._starts is not None else self._index()
        index = bisect_left(starts, start)
        if index > 0 and self._ends[index - 1] > start:
            # Inside a two-character break ("\r\n" at its "\n", an escaped
            # "\\n" at its "n"), where a search from `start` splits the text
            # differently. No caller starts a value there; search as before.
            return folded_line_end(self._text, start)
        return self._line_ends[index] if index < len(starts) else len(self._text)


def _folds_on(text: str, end: int) -> bool:
    """Whether a value ending at `end` stops at a line break that a continuation line follows."""
    line_break = LINE_BREAK_RE.match(text, end)
    return line_break is not None and line_break.end() < len(text) and text[line_break.end()] in " \t"


def is_authorization_key(key: str) -> bool:
    return key.lower().endswith("authorization")


def keyed_value_span(
    text: str,
    match: re.Match[str],
    *,
    whole: bool,
    line_ends: FoldedLineEnds,
    stops: re.Pattern[str] | None = None,
) -> tuple[int, int, str]:
    """(value start, value end, closed opener) for a secret_key_pattern match.

    `line_ends` is the one FoldedLineEnds of `text` for the whole scan, so
    finding line ends stays linear; building one per value would make it
    quadratic again. The closing-quote search is not linear: when no later
    quote has a value's run of backslashes (an escaped-quote ladder), it
    rescans every later quote for each value. The public card bounds that cost
    by passing at most PUBLIC_CARD_SCAN_MAX_CHARS characters here.

    A quoted value runs to its own closing quote: the same quote with the same
    run of backslashes before it, so an escaped quote inside the value stays
    inside, in JSON and in escaped JSON; the opener is returned only when that
    quote closes. An unquoted value, or a quote that never closes, runs to the
    end of its line plus folded continuation lines when `whole` is set (an
    Authorization value: every scheme, a Digest value's spaces and commas), or
    to the first `stops` match before that end (the public card's secret-key
    rule). Otherwise it is one word, two when the first is a scheme word, or
    the whole line after Digest; a word that ends at a folded line break takes
    the continuation lines too.
    """
    position = match.end()
    blanks_only = whole or stops is not None or match.group(4) is not None
    position = (BLANKS_RE if blanks_only else WHITESPACE_RE).match(text, position).end()
    opener_match = VALUE_OPENER_RE.match(text, position)
    if opener_match is not None:
        opener = opener_match.group(0)
        value_start = opener_match.end()
        line_end = line_ends.at(value_start)
        close = _closing_quote(text, value_start, line_end, opener)
        if close != -1:
            return value_start, close, opener
        if stops is None or whole:
            return value_start, line_end, ""
    if whole:
        return position, line_ends.at(position), ""
    if stops is not None:
        line_end = line_ends.at(position)
        stop = stops.search(text, position, line_end)
        return position, (stop.start() if stop is not None else line_end), ""
    scheme = SECRET_SCHEME_WORD_RE.match(text, position)
    if scheme is not None and scheme.group(1).lower() == "digest":
        return position, line_ends.at(position), ""
    token = SECRET_VALUE_TOKEN_RE.match(text, scheme.end()) if scheme is not None else None
    if token is None:
        token = SECRET_VALUE_TOKEN_RE.match(text, position)
    if token is None:
        return position, position, ""
    value_end = token.end()
    if _folds_on(text, value_end):
        value_end = line_ends.at(value_end)
    return position, value_end, ""
