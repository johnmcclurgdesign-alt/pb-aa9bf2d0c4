#!/usr/bin/env python3
"""loop-preflight.py — run the publish gate's static checks on a WEB Loop payload BEFORE you send it.

    loop-preflight.py <payload.zip> [--id <loop-id>] [--lane dev|release] [--version X.Y.Z]
                      [--catalog-assets <dir>] [--sums <SHA256SUMS.txt>] [--docs <loops-docs dir>]
                      [--default <default.zip>]    # a platform cook (-tvos- …): parity with the default
                      [--budget-mb 370] [--json] [--top 15]
    loop-preflight.py --self-test
    loop-preflight.py --check-copy --docs <loops-docs dir>     # is this file the same as loops-docs'?

Exit 0 = READY, 1 = NOT READY, 2 = the tool could not do its job (an input it cannot read, a total
it refuses to guess). Every FAIL line says what was found, why it matters, and what to do.

WHY THIS FILE EXISTS. The catalog side runs `loop-intake.py report` on every Release and posts a
Loop Report (40-delivery/10-delivering-a-release.md §4.2). Everything it checks STATICALLY is
knowable before you tag — and a NOT READY costs you a new tag, a new Release and a new file, because
a release is the FILE plus its sums and a rebuild hashes differently. This is those checks, run on
your desk, from the same rules, so the first Loop Report you get reads READY.

WHAT IT MIRRORS, AND WHAT IS THE AUTHORITY. The rules are the loops-docs pages named on each check.
The reference implementations are in the Collectivus monorepo, `packages/catalog/`:
`publish-checks.py` (the archive inspection, the external-reference sweep and its allowlist),
`texture-memory.py` (the resident-memory model), `loop-intake.py` (naming, sums, masters, text).
Where this file and those disagree, THOSE win — tell your integrator, do not patch this one.

⚠ THE SOURCE OF TRUTH IS `publish-checks.py`, AND A PARITY GATE HOLDS THIS FILE TO IT (PFL1, #307).
This file cannot import the gate — you have loops-docs at your desk, not the monorepo — so it MIRRORS
three pieces of it exactly: the show-notes refusals (`MD_REFUSED` = the gate's `_MD_REFUSED`), the URL
sweep (`scan_urls`, `_strip_js_comments`, `external_references`, `excused_references` and the regexes),
and the allowlist (`ALLOWED_PREFIXES` = `VENDORING_ALLOWED_PREFIXES`). The monorepo's
`scripts/check-preflight-parity.py` runs the same fixtures and archives through both and fails on any
disagreement. It exists because they drifted: this file refused every list in `about` after the gate
admitted one level (FX3), and refused three.js's `jcgt.org` GLSL comment, which the gate passes.

WHAT IT DOES NOT DO. It never runs your Loop: the Apple TV shape test, the picture census and the
device leg are separate instruments (40-delivery/20-validating-a-build.md). A READY here means the
static half will pass; it says nothing about whether the Loop draws.

⚠ READ THE DOCS FIRST — THEY CHANGE WEEKLY. With `--docs` this tool pulls loops-docs and prints
every CHANGELOG entry newer than the last run (stamped in `.loop-preflight-docs-stamp` beside the
payload's repo). A rule you have not read is a rule you are about to break.

⚠ EVERY CHECK HAS BEEN WATCHED FAILING. `--self-test` builds synthetic archives with one planted
violation each and requires the NAMED check to go red. A gate nobody has seen fail reports success
when it is broken.
"""
import argparse
import datetime as dt
import hashlib
import io
import json
import os
import pathlib
import re
import struct
import subprocess
import sys
import tempfile
import zipfile
from collections import namedtuple

# ─────────────────────────────────────────────────────────────────────────────────────────────
# The numbers, each with the page that owns it
# ─────────────────────────────────────────────────────────────────────────────────────────────
PAYLOAD_CEILING = 200 * 1024 * 1024      # 20-contract/20-payload-and-ceilings.md §2 — hard
PAYLOAD_TARGET = 150 * 1024 * 1024       # same page — target
BUNDLED_CEILING = 25 * 1024 * 1024       # same page — bundled Loops
TEXTURE_BUDGET_MB = 370.0                # 30-engines/web/00-status.md §4.2 — clean 4 of 4
TEXTURE_WARN_MB = 300.0                  # headroom; 450–650 MB is the coin-toss band
TEXT_MEMBER_CEILING = 8 * 1024 * 1024    # publish-checks.py WEB_TEXT_MEMBER_CEILING
MANIFEST = "loop.json"
RUN_OF_SHOW_MANIFEST = "manifest.json"    # 10-platform/55-run-of-show-manifest.md — a DIFFERENT file from loop.json
# Calibrated from RUNSHOW1 (2026-09-18): web-test-loop-003 measured 15,947 ms of first-frame replay
# at a 19.4-day-old, 9-event seed manifest — 91.3 ms per (event × day). Approximate; the point is
# to catch a seed that is ALREADY stale before you tag, not to model every Loop's replay cost exactly.
ROS_MS_PER_EVENT_DAY = 91.3
ROS_WARN_MS = 200          # getting stale — worth a rebase before this ships
ROS_FAIL_MS = 1000         # the shell's own first-frame block budget (55-run-of-show-manifest.md §6)
SUMS_NAME = "SHA256SUMS.txt"
ENTRY_NAME = "catalog-entry.md"
TITLE_MAX, DESCRIPTION_MAX, ABOUT_MAX = 28, 280, 2000   # 10-platform/40-metadata.md (`subtitle` retired 2026-09-26: not checked)
AGE_BANDS = ("4+", "9+", "13+", "16+", "18+")
POSTER_MIN, WIDE_MIN = (1200, 1600), (3840, 2160)                          # 40-metadata.md §2
STAMP_NAME = ".loop-preflight-docs-stamp"

# The vendoring allowlist — FULLY QUALIFIED prefixes, never hosts (publish-checks.py
# VENDORING_ALLOWED_PREFIXES). Every excuse is printed. Adding one here is not enough: the gate
# has its own copy and it is the one that decides — ask your integrator to add it there.
ALLOWED_PREFIXES = (
    ("http://www.w3.org/", "an XML/SVG namespace, not a fetch"),
    ("https://www.w3.org/", "an XML/SVG namespace, not a fetch"),
    ("http://purl.org/", "an RDF vocabulary, not a fetch"),
    ("https://purl.org/", "an RDF vocabulary, not a fetch"),
    ("https://github.com/mrdoob/three.js/issues/32012",
     "three.js deprecation warning text (waitForGPU), printed not fetched"),
)
TEXT_SUFFIXES = {".html", ".htm", ".js", ".mjs", ".cjs", ".css", ".json", ".importmap"}

# ─────────────────────────────────────────────────────────────────────────────────────────────
# Results
# ─────────────────────────────────────────────────────────────────────────────────────────────
Result = namedtuple("Result", "check status why fix")


class Report:
    def __init__(self):
        self.rows = []
        self.notes = []          # informational lines (digest, excused URLs, top textures)
        self.refused = False     # the tool could not answer — exit 2

    def add(self, status, check, why, fix=""):
        self.rows.append(Result(check, status, why, fix))

    def PASS(self, check, why): self.add("PASS", check, why)
    def FAIL(self, check, why, fix): self.add("FAIL", check, why, fix)
    def WARN(self, check, why, fix=""): self.add("WARN", check, why, fix)
    def SKIP(self, check, why, fix=""): self.add("SKIP", check, why, fix)

    def verdict(self):
        if self.refused:
            return "NO RESULT"
        return "NOT READY" if any(r.status == "FAIL" for r in self.rows) else "READY"


def mb(n):
    return "%.1f MB" % (n / 1048576)


# ─────────────────────────────────────────────────────────────────────────────────────────────
# 0. The docs — pull, then say what changed since the last run
# ─────────────────────────────────────────────────────────────────────────────────────────────
def check_docs(rep, docs, stamp_dir, offline):
    if not docs:
        rep.WARN("docs: loops-docs read",
                 "no --docs given, so nothing here proves you read the current rules",
                 "clone https://github.com/CollectivusWorlds/collectivus-loops-docs and pass --docs <dir>")
        return
    docs = pathlib.Path(docs)
    changelog = docs / "90-meta" / "CHANGELOG.md"
    if not changelog.is_file():
        rep.FAIL("docs: loops-docs read", "%s has no 90-meta/CHANGELOG.md — not a loops-docs checkout" % docs,
                 "point --docs at a clone of collectivus-loops-docs")
        return
    pulled = "not pulled (--offline)"
    if not offline:
        try:
            out = subprocess.run(["git", "-C", str(docs), "pull", "--ff-only", "-q"],
                                 capture_output=True, text=True, timeout=60)
            pulled = "pulled" if out.returncode == 0 else "pull FAILED: %s" % (out.stderr.strip()[:120] or "?")
        except Exception as error:  # noqa: BLE001 — a missing git or a timeout are both "not pulled"
            pulled = "pull failed: %s" % error
    head = subprocess.run(["git", "-C", str(docs), "log", "-1", "--format=%h %cs"],
                          capture_output=True, text=True).stdout.strip() or "?"
    # Entries newer than the stamp. CHANGELOG entries are `## YYYY-MM-DD — title`.
    stamp = pathlib.Path(stamp_dir) / STAMP_NAME if stamp_dir else None
    since = stamp.read_text().strip() if stamp and stamp.is_file() else "0000-00-00"
    entries = re.findall(r"^## (\d{4}-\d{2}-\d{2})\s*[—-]\s*(.+)$", changelog.read_text(encoding="utf-8"), re.M)
    newer = [(d, t) for d, t in entries if d > since]
    today = dt.date.today().isoformat()
    if newer:
        rep.WARN("docs: changes since your last run (%s)" % since,
                 "%d CHANGELOG entr%s newer — READ THEM before trusting this run: %s" % (
                     len(newer), "y is" if len(newer) == 1 else "ies are",
                     " | ".join("%s %s" % (d, t[:70]) for d, t in newer[:6]) + (" …" if len(newer) > 6 else "")),
                 "read %s, then re-run; the stamp advances to today on this run" % changelog)
    else:
        rep.PASS("docs: changes since your last run (%s)" % since, "none newer in the CHANGELOG (head %s, %s)" % (head, pulled))
    if stamp:
        try:
            stamp.write_text(today + "\n")
        except OSError:
            pass
    # A page unverified for 60 days is flagged by the docs' own rule; say so for the web pages.
    stale = []
    for page in ("30-engines/web/00-status.md", "30-engines/web/20-the-loop-manifest-and-bridge.md",
                 "40-delivery/10-delivering-a-release.md", "40-delivery/20-validating-a-build.md",
                 "20-contract/20-payload-and-ceilings.md", "10-platform/40-metadata.md"):
        p = docs / page
        if not p.is_file():
            stale.append("%s MISSING" % page)
            continue
        m = re.search(r"^last-verified:\s*(\d{4}-\d{2}-\d{2})", p.read_text(encoding="utf-8"), re.M)
        if m and (dt.date.today() - dt.date.fromisoformat(m.group(1))).days > 60:
            stale.append("%s last-verified %s" % (page, m.group(1)))
    if stale:
        rep.WARN("docs: page freshness", "; ".join(stale), "a page over 60 days old is flagged, not trusted — ask before building against it")
    else:
        rep.PASS("docs: page freshness", "every page this tool depends on was verified within 60 days")


def check_copy(rep, docs):
    """Is this file byte-identical to loops-docs' copy? A Loop repo carries a copy; copies drift."""
    me = pathlib.Path(__file__).resolve()
    ref = pathlib.Path(docs) / "40-delivery" / "tools" / "loop-preflight.py"
    if not ref.is_file():
        rep.WARN("copy: matches loops-docs", "loops-docs has no 40-delivery/tools/loop-preflight.py at %s" % ref)
        return
    if ref.resolve() == me:
        rep.PASS("copy: matches loops-docs", "this IS the loops-docs copy")
        return
    same = hashlib.sha256(me.read_bytes()).digest() == hashlib.sha256(ref.read_bytes()).digest()
    if same:
        rep.PASS("copy: matches loops-docs", "byte-identical to %s" % ref)
    else:
        rep.WARN("copy: matches loops-docs", "this copy differs from %s" % ref,
                 "cp '%s' '%s'  (the loops-docs copy is the reference; a local edit is a proposal, send it upstream)" % (ref, me))


# ─────────────────────────────────────────────────────────────────────────────────────────────
# 1. The archive — shape, manifest, unsafe members  (publish-checks.py inspect_web_archive)
# ─────────────────────────────────────────────────────────────────────────────────────────────
def unsafe_members(names):
    bad = []
    for name in names:
        posix = name.replace("\\", "/")
        if posix.startswith("/") or re.match(r"^[A-Za-z]:", posix):
            bad.append("%s: absolute path" % name)
        elif any(part == ".." for part in posix.split("/")):
            bad.append("%s: escapes the payload root with '..'" % name)
    return bad


MEDIA_PREFIX = "media/"   # publish-policy.json `mediaPrefix` — 20-contract/25-media-lane.md §1


def reserved_media_members(names):
    """Members under the media lane's reserved `media/` prefix — publish-checks.py
    `inspect_web_archive` refuses a payload carrying any (app row MEDIA2). The same expression as the
    gate's, so the parity gate can hold the two to one answer: backslashes read as `/`, case kept."""
    return [n for n in names if n.replace("\\", "/").startswith(MEDIA_PREFIX)]


def check_archive(rep, z, names):
    bad = unsafe_members(names)
    if bad:
        rep.FAIL("archive: no unsafe members", "; ".join(bad[:5]), "zip from INSIDE the tree with relative paths only")
    else:
        rep.PASS("archive: no unsafe members", "%d members, none absolute or escaping" % len(names))

    reserved = reserved_media_members(names)
    if reserved:
        rep.FAIL("archive: no media/ folder (reserved prefix)",
                 "%d member(s) under media/, e.g. %s — a path under media/ is read through the Loop's media "
                 "manifest, never the payload, so the gate refuses the payload" % (len(reserved), reserved[0]),
                 "move those files to the release's media zip and list them in media.json (tools/loop-media.py "
                 "generate does both), or rename the folder (20-contract/25-media-lane.md §1)")
    else:
        rep.PASS("archive: no media/ folder (reserved prefix)", "nothing under media/")

    junk = [n for n in names if n.split("/")[-1] == ".DS_Store" or n.startswith("__MACOSX/")
            or n.split("/")[-1].startswith("._")]
    if junk:
        rep.FAIL("archive: no macOS metadata", "%d member(s): %s" % (len(junk), ", ".join(junk[:4])),
                 "zip -X … -x '.*' -x '__MACOSX/*' and `find . -name .DS_Store -delete` first (web/20 §1)")
    else:
        rep.PASS("archive: no macOS metadata", "no .DS_Store, ._* or __MACOSX members")

    dirs = [n for n in names if n.endswith("/")]
    if dirs:
        rep.WARN("archive: directory entries", "%d directory member(s) — the member count is not a file count" % len(dirs),
                 "zip -D so every member is a file you can assert against a manifest (web/00 §3 rule 17)")
    else:
        rep.PASS("archive: directory entries", "none — every member is a file")

    if MANIFEST not in names:
        nested = [n for n in names if n.endswith("/" + MANIFEST)]
        rep.FAIL("manifest: loop.json at the archive root",
                 "not at the root" + (" — found at %s (you zipped the FOLDER, not its contents)" % nested[0] if nested else ""),
                 "cd into the tree and `zip -X -D -r ../payload.zip .` (web/20 §1)")
        return None
    try:
        manifest = json.loads(z.read(MANIFEST).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        rep.FAIL("manifest: loop.json at the archive root", "present but not readable JSON (%s)" % error, "fix the JSON")
        return None
    if not isinstance(manifest, dict):
        rep.FAIL("manifest: loop.json at the archive root", "must be a JSON object", "see web/20 §2")
        return None
    rep.PASS("manifest: loop.json at the archive root", "present and parses")

    if manifest.get("manifestVersion") != 1:
        rep.FAIL("manifest: manifestVersion", "got %r, the shell refuses anything but 1" % (manifest.get("manifestVersion"),),
                 '"manifestVersion": 1')
    else:
        rep.PASS("manifest: manifestVersion", "1")
    entry = manifest.get("entry")
    if not isinstance(entry, str) or not entry:
        rep.FAIL("manifest: entry resolves", "'entry' must name the entry HTML, relative to the archive root", '"entry": "index.html"')
    elif entry.startswith(("/", "http://", "https://")):
        rep.FAIL("manifest: entry resolves", "'entry' is %r — must be a relative path, not absolute or a URL" % entry, "make it archive-relative")
    elif entry not in names:
        rep.FAIL("manifest: entry resolves", "'entry' %r is not in the archive — the shell shows a blank screen with no error" % entry,
                 "check the path the build wrote; do not flatten the tree to fix it (web/00 §3 rule 17)")
    else:
        rep.PASS("manifest: entry resolves", entry)
    cameras = manifest.get("cameras")
    if cameras is not None:
        if not isinstance(cameras, list) or any(not isinstance(c, dict) or not isinstance(c.get("id"), str) for c in cameras):
            rep.FAIL("manifest: cameras", "'cameras' must be a list of objects with a string 'id' (and a 'title')", "see web/20 §3.3")
        else:
            rep.PASS("manifest: cameras", "%d declared: %s — must agree with what ready() sends, and the ids are PERMANENT" % (
                len(cameras), ", ".join(c["id"] for c in cameras)))
    else:
        rep.PASS("manifest: cameras", "none declared (a single view; no switcher is offered)")
    return manifest


# ─────────────────────────────────────────────────────────────────────────────────────────────
# 2. Vendoring — the position-aware URL sweep  (publish-checks.py _scan_urls / external_references)
# ─────────────────────────────────────────────────────────────────────────────────────────────
_URL_RE = re.compile(r"https?://[^\s\"'`)<>\\]+")
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
_LINE_COMMENT_RE = re.compile(r"(?<!:)//[^\n]*")      # (?<!:) so `https://` is not eaten
# The string-aware strip's stops (VEND2, Q320) — see `_strip_js_comments`.
_JS_CODE_STOP_RE = re.compile(r"""['"`]|(?<!:)//|/\*""")                 # outside any string
_JS_STRING_STOP_RE = re.compile(r"""\\.|['"`\n]|(?<!:)//|/\*""", re.S)   # inside one
_JS_STRING_LINE_END_RE = re.compile(r"""\\n|\\.|['"`\n]""", re.S)       # ends a `//` inside one
_JS_STRING_BLOCK_END_RE = re.compile(r"""\\.|['"`\n]|\*/""", re.S)      # ends a `/*` inside one
_HTML_SRC_RE = re.compile(r"""\bsrc\s*=\s*["']([^"']+)["']""", re.I)
_HTML_LINK_RE = re.compile(r"""<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>""", re.I)
_HTML_IMPORTMAP_RE = re.compile(r"""<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>(.*?)</script>""", re.I | re.S)
_HTML_SCRIPT_RE = re.compile(r"<script\b[^>]*>(.*?)</script>", re.I | re.S)
_CSS_URL_RE = re.compile(r"""url\(\s*["']?([^"')]+)["']?\s*\)""", re.I)


# ⚠ THE GATE'S SWEEP, EXACTLY (PFL1 #307, then VEND2 / collectivus Q320) — copied from publish-checks.py.
def _strip_js_comments(text):
    """JavaScript with its comments removed, reading where the strings are (VEND2, Q320).

    ⚠ WHY NOT A REGEX. A string-blind `//[^\\n]*` cut from a `//` INSIDE A STRING to the end of the
    line, and a minified bundle is one line (three.module.min.js: 365,459 columns) — so
    `const p='//';import('https://unpkg.com/three')` swept clean. Here a `//` or `/*` in code is a
    comment to the end of the line / the `*/`, as JavaScript reads it.

    ⚠ A COMMENT INSIDE A STRING IS STILL STRIPPED, BUT BOUNDED BY THE STRING. three.js ships GLSL as
    JS strings, and a GLSL comment in one cites `https://jcgt.org/…` — a citation, never a fetch
    (#307). So inside a string a `//` runs only to the string's own line end (an escaped `\\n`, or a
    real newline in a template literal) and a `/*` to its `*/`, and neither ever runs past the closing
    quote. That bound is the fix: the statement after the string is always read.

    A `/*` inside a string is stripped only when its `*/` is inside the same string; otherwise it is
    string content and kept. Escapes are honoured; a real newline ends a '…' or "…" string, which
    re-synchronises a misread. It does not parse regular-expression literals, so a quote inside one
    is a misread — which is why it is never the sweep's only reading (`_js_urls`).
    """
    out, i = [], 0
    while True:
        m = _JS_CODE_STOP_RE.search(text, i)
        if not m:
            out.append(text[i:])
            return "".join(out)
        out.append(text[i:m.start()])
        token = m.group()
        if token == "//":
            i = _line_end(text, m.start())
        elif token == "/*":
            close = text.find("*/", m.end())
            # Unterminated: kept, exactly as the old regex (which never matched) kept it.
            out.append("" if close >= 0 else token)
            i = close + 2 if close >= 0 else m.end()
        else:
            i = _copy_js_string(text, m.start(), out)


def _line_end(text, start):
    """The index of the newline that ends `start`'s line (kept), or the end of the text."""
    end = text.find("\n", start)
    return len(text) if end < 0 else end


def _copy_js_string(text, start, out):
    """Append the string literal opening at `start` to `out`, minus the comments inside it; return
    the index just past it. Its comments are bounded by the string (see `_strip_js_comments`)."""
    quote, i = text[start], start + 1
    out.append(quote)
    while True:
        m = _JS_STRING_STOP_RE.search(text, i)
        if not m:
            out.append(text[i:])
            return len(text)
        out.append(text[i:m.start()])
        token = m.group()
        end = _string_comment_end(text, m.end(), quote, token) if token in ("//", "/*") else None
        if end is not None:
            i = end
            continue
        out.append(token)
        i = m.end()
        if token == quote or (token == "\n" and quote != "`"):
            return i


def _string_comment_end(text, i, quote, opener):
    """Where a comment opened by `opener` inside a `quote` string stops, or None when it is not one.

    A `//` stops at its line end (a `\\n` escape or a real newline) or at the closing quote, which is
    never consumed. A `/*` stops just past its `*/`, and is None — kept as content — when the string
    ends first (its quote, or a real newline in a '…' or "…" string) or the text does."""
    end_re = _JS_STRING_LINE_END_RE if opener == "//" else _JS_STRING_BLOCK_END_RE
    while True:
        m = end_re.search(text, i)
        if not m:
            return len(text) if opener == "//" else None
        token = m.group()
        if token == "*/":
            return m.end()
        string_ends = token == quote or (token == "\n" and quote != "`")
        if opener == "//" and (string_ends or token in ("\n", "\\n")):
            return m.start()
        if string_ends:
            return None
        i = m.end()   # another escape, the other quote characters, a templated newline: content


def _js_urls(text):
    """Every URL in JavaScript that survives comment stripping, read TWO ways (VEND2, Q320).

    ⚠ THE UNION IS THE GUARANTEE. The string-aware strip is the fix — it sees the fetch after a
    `'//'` string that the string-blind regexes hid — but a misread of its own (a quote inside a
    regular-expression literal) could hide something the regexes see. So a URL either reading keeps
    is reported: the sweep is never looser than it was before VEND2, and #307's jcgt citation, which
    both readings strip, still passes. Measured on every local payload at VEND2: the two readings
    found the same URLs in every member, so the union costs no false refusals today.
    """
    aware = _URL_RE.findall(_strip_js_comments(text))
    blind = _URL_RE.findall(_LINE_COMMENT_RE.sub("", _BLOCK_COMMENT_RE.sub("", text)))
    return aware + [u for u in blind if u not in aware]


def scan_urls(name, text):
    suffix = pathlib.PurePosixPath(name).suffix.lower()
    if suffix in (".js", ".mjs", ".cjs"):
        return _js_urls(text)
    if suffix in (".htm", ".html"):
        body = _HTML_COMMENT_RE.sub("", text)
        found = []
        for block in _HTML_IMPORTMAP_RE.findall(body):
            found += _URL_RE.findall(block)
        body = _HTML_IMPORTMAP_RE.sub("", body)
        found += _HTML_SRC_RE.findall(body)
        found += _HTML_LINK_RE.findall(body)
        for inline in _HTML_SCRIPT_RE.findall(body):
            found += _js_urls(inline)
        return found
    if suffix == ".css":
        body = _BLOCK_COMMENT_RE.sub("", text)
        found = _CSS_URL_RE.findall(body)
        found += _URL_RE.findall("\n".join(re.findall(r"@import[^;]+;", body, re.I)))
        return found
    if suffix in (".json", ".importmap"):
        try:
            parsed = json.loads(text)
        except ValueError:
            return []
        if not isinstance(parsed, dict):
            return []
        found = []
        for key in ("imports", "scopes"):
            if key in parsed:
                found += _URL_RE.findall(json.dumps(parsed[key]))
        return found
    return []


def allowlist_reason(url):
    for prefix, reason in ALLOWED_PREFIXES:
        if url.startswith(prefix):
            return "%s (%s)" % (prefix, reason)
    return None


_ALLOWED_PREFIX_STRINGS = tuple(prefix for prefix, _ in ALLOWED_PREFIXES)


def external_references(name, text):
    """What the gate refuses in one member (publish-checks.py external_references)."""
    return [u for u in scan_urls(name, text)
            if u.startswith(("http://", "https://")) and not u.startswith(_ALLOWED_PREFIX_STRINGS)]


def excused_references(name, text):
    """What the gate's allowlist lets through in one member (publish-checks.py excused_references)."""
    return [u for u in scan_urls(name, text)
            if u.startswith(("http://", "https://")) and u.startswith(_ALLOWED_PREFIX_STRINGS)]


def check_vendoring(rep, z, names):
    violations, excused, scanned, unscanned = [], [], 0, []
    for name in names:
        if name.endswith("/") or pathlib.PurePosixPath(name).suffix.lower() not in TEXT_SUFFIXES:
            continue
        info = z.getinfo(name)
        if info.file_size > TEXT_MEMBER_CEILING:
            unscanned.append("%s (%s)" % (name, mb(info.file_size)))
            continue
        try:
            text = z.read(name).decode("utf-8")
        except UnicodeDecodeError:
            unscanned.append("%s (not UTF-8)" % name)
            continue
        scanned += 1
        violations += ["%s: %s" % (name, url) for url in external_references(name, text)]
        excused += ["%s: %s — allowed by %s" % (name, url, allowlist_reason(url)) for url in excused_references(name, text)]
    if unscanned:
        rep.FAIL("vendoring: every text member scanned", "%d NOT scanned: %s" % (len(unscanned), "; ".join(unscanned[:4])),
                 "a text member over %s is a mislabelled asset; the gate refuses it rather than skipping it" % mb(TEXT_MEMBER_CEILING))
    else:
        rep.PASS("vendoring: every text member scanned", "%d text members read" % scanned)
    if violations:
        rep.FAIL("vendoring: no external runtime references", "%d: %s" % (len(violations), " | ".join(violations[:6]) + (" …" if len(violations) > 6 else "")),
                 "vendor it into the payload and reference it by relative path; grep setDecoderPath/setTranscoderPath too (web/00 §3 rule 1). "
                 "A benign library URL string is excused on the GATE's allowlist — ask your integrator, do not patch the library")
    else:
        rep.PASS("vendoring: no external runtime references", "none in load-bearing positions across %d members" % scanned)
    for line in excused:
        rep.notes.append("excused: " + line)


# ─────────────────────────────────────────────────────────────────────────────────────────────
# 3. Resident texture memory  (texture-memory.py's model, restated)
# ─────────────────────────────────────────────────────────────────────────────────────────────
MIP = 4 / 3
KTX2_ID = b"\xabKTX 20\xbb\r\n\x1a\n"
ASTC_BLOCKS = [(4, 4), (5, 4), (5, 5), (6, 5), (6, 6), (8, 5), (8, 6), (8, 8),
               (10, 5), (10, 6), (10, 8), (10, 10), (12, 10), (12, 12)]
VK_COMPRESSED = {157 + 2 * i + k: (bw, bh, 16) for i, (bw, bh) in enumerate(ASTC_BLOCKS) for k in (0, 1)}
VK_COMPRESSED.update({147: (4, 4, 8), 148: (4, 4, 8), 149: (4, 4, 8), 150: (4, 4, 8),
                      151: (4, 4, 16), 152: (4, 4, 16), 153: (4, 4, 8), 154: (4, 4, 8),
                      155: (4, 4, 16), 156: (4, 4, 16)})
VK_UNCOMPRESSED = {9: 1, 10: 1, 14: 1, 15: 1, 16: 2, 17: 2, 21: 2, 22: 2, 23: 3, 24: 3, 28: 3, 29: 3,
                   30: 3, 36: 3, 37: 4, 38: 4, 42: 4, 43: 4, 44: 4, 50: 4, 64: 4, 122: 4, 123: 4,
                   70: 2, 76: 2, 77: 4, 83: 4, 91: 8, 97: 8, 100: 4, 103: 8, 109: 16}
Tex = namedtuple("Tex", "w h kind bytes flag")


def _blocks(n, b):
    return (n + b - 1) // b


def model_ktx2(b):
    if len(b) < 104 or b[:12] != KTX2_ID:
        return None
    vk, _ts, w, h, depth, layers, faces, levels, scheme = struct.unpack("<9I", b[12:48])
    w, h = max(1, w), max(1, h)
    slices = max(1, layers) * max(1, faces) * max(1, depth)
    mip = MIP if max(1, levels) > 1 else 1.0
    flag = None
    if vk == 0:
        kind, level0 = "Basis (vkFormat 0)", w * h * slices
        flag = "Basis Universal charged at 1.0 B/texel (transcodes to a 4x4-class format)"
    elif vk in VK_COMPRESSED:
        bw, bh, bb = VK_COMPRESSED[vk]
        kind, level0 = ("ASTC %dx%d" % (bw, bh)) if vk >= 157 else "ETC2/EAC", _blocks(w, bw) * _blocks(h, bh) * bb * slices
        if scheme != 0:
            flag = "supercompressionScheme %d — modelled from vkFormat; not self-checked" % scheme
    elif vk in VK_UNCOMPRESSED:
        kind, level0 = "uncompressed", w * h * VK_UNCOMPRESSED[vk] * slices
    else:
        kind, level0 = "vkFormat %d" % vk, w * h * slices
        flag = "unknown vkFormat %d charged at 1.0 B/texel" % vk
    return Tex(w, h, kind, int(level0 * mip), flag)


def image_dims(b):
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", b[16:24])
    if b[:2] == b"\xff\xd8":
        i = 2
        while i < len(b) - 9:
            if b[i] != 0xFF:
                i += 1
                continue
            m = b[i + 1]
            if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", b[i + 5:i + 9])
                return w, h
            if m in (0xD8, 0xD9) or 0xD0 <= m <= 0xD7:
                i += 2
                continue
            i += 2 + struct.unpack(">H", b[i + 2:i + 4])[0]
        return None
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        c = b[12:16]
        if c == b"VP8 ":
            w, h = struct.unpack("<HH", b[26:30])
            return w & 0x3FFF, h & 0x3FFF
        if c == b"VP8L":
            n = struct.unpack("<I", b[21:25])[0]
            return (n & 0x3FFF) + 1, ((n >> 14) & 0x3FFF) + 1
        if c == b"VP8X":
            return (b[24] | b[25] << 8 | b[26] << 16) + 1, (b[27] | b[28] << 8 | b[29] << 16) + 1
    return None


def model_image(b):
    m = model_ktx2(b)
    if m is not None:
        return m
    d = image_dims(b)
    if d is None:
        return None
    w, h = d
    return Tex(w, h, "RGBA8", int(w * h * 4 * MIP), None)


def glb_chunks(d):
    off, js, bin_ = 12, None, None
    while off + 8 <= len(d):
        ln, ty = struct.unpack("<II", d[off:off + 8])
        chunk = d[off + 8:off + 8 + ln]
        if ty == 0x4E4F534A:
            js = json.loads(chunk)
        elif ty == 0x004E4942:
            bin_ = chunk
        off += 8 + ln + ((4 - ln % 4) % 4 if ln % 4 else 0)
    return js, bin_


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".ktx2"}


def texture_rows(z, names):
    """(rows, flags, unsized) over `names` — (member, images, resident bytes) per row."""
    rows, flags, unsized = [], [], []
    for name in names:
        suffix = pathlib.PurePosixPath(name).suffix.lower()
        if name.endswith("/"):
            continue
        if suffix == ".glb":
            try:
                js, bin_ = glb_chunks(z.read(name))
            except Exception as error:  # noqa: BLE001
                unsized.append("%s (unreadable glb: %s)" % (name, error))
                continue
            total, count = 0, 0
            for i, img in enumerate((js or {}).get("images", [])):
                if "bufferView" not in img:
                    continue      # a URI image is a member of its own and is measured there
                bv = js["bufferViews"][img["bufferView"]]
                o = bv.get("byteOffset", 0)
                m = model_image(bin_[o:o + bv["byteLength"]])
                if m is None:
                    unsized.append("%s#images[%d]" % (name, i))
                    continue
                total += m.bytes
                count += 1
                if m.flag:
                    flags.append("%s#images[%d]: %s" % (name, i, m.flag))
            rows.append((name, count, total))
        elif suffix in IMAGE_SUFFIXES:
            m = model_image(z.read(name))
            if m is None:
                unsized.append(name)
                continue
            rows.append((name, 1, m.bytes))
            if m.flag:
                flags.append("%s: %s" % (name, m.flag))
    return rows, flags, unsized


# TIER2 (2026-09-18) — loop.json `tiers` may MAP each rung to the globs it loads,
#   { "phone": { "assets": ["models_ktx2/*.glb", "textures_ktx2/**/*.ktx2"] }, ... }
# and then each tier is measured by what IT loads: one payload carrying a desktop and a lean set
# totals a number no single device ever holds. `*` and `?` stop at "/", `**/` spans folders.
# Only the phone ceiling (~370 MB) is measured; phone, tablet and tv are held to it. Laptop,
# desktop, ultra and max print their number and are NOT judged — no ceiling was ever measured.
JUDGED_TIERS = {"phone": "iPhone and the web at a phone viewport", "tablet": "iPad", "tv": "Apple TV"}


def glob_regex(pattern):
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + r"\Z")


def manifest_tiers(z):
    """('map', {rung: [globs]}) | ('list', [names]) | ('none', None) | ('bad', why)."""
    try:
        tiers = json.loads(z.read(MANIFEST)).get("tiers")
    except Exception:  # noqa: BLE001 — check_archive already reports an unreadable manifest
        return "none", None
    if tiers is None:
        return "none", None
    if isinstance(tiers, list):
        return "list", [t for t in tiers if isinstance(t, str)]
    if isinstance(tiers, dict):
        out = {}
        for rung, spec in tiers.items():
            assets = spec.get("assets") if isinstance(spec, dict) else None
            if not (isinstance(assets, list) and assets and all(isinstance(a, str) and a for a in assets)):
                return "bad", "tiers.%s has no \"assets\" list of globs" % rung
            out[rung] = assets
        return "map", out
    return "bad", "tiers is neither a list of names nor a map of rung → {\"assets\": [...]}"


def judge_resident(rep, check, total_mb, budget_mb, why):
    if total_mb > budget_mb:
        rep.FAIL(check, why, "KTX2 the heaviest files and size each texture to its on-screen footprint (web/10). Count the images INSIDE .glb files first — that is where it hides (web/00 §4)")
    elif total_mb > TEXTURE_WARN_MB:
        rep.WARN(check, why, "inside the budget with under %.0f MB of headroom" % (budget_mb - total_mb))
    else:
        rep.PASS(check, why)


def check_tier_textures(rep, z, names, budget_mb, tiers):
    for rung, globs in tiers.items():
        chosen, empty = set(), []
        for pattern in globs:
            hits = {n for n in names if not n.endswith("/") and glob_regex(pattern).match(n)}
            empty += [] if hits else [pattern]
            chosen |= hits
        if empty:
            rep.refused = True
            rep.FAIL("texture: tier %s" % rung, "glob(s) matched no member: %s — NO TOTAL, because a typo drops files and a low total passes a Loop the device cannot draw" % ", ".join(empty),
                     "fix the glob in loop.json tiers.%s.assets" % rung)
            continue
        rows, _flags, _unsized = texture_rows(z, sorted(chosen))
        total_mb = sum(r[2] for r in rows) / 1048576
        why = "%.1f MB resident across the %d member(s) this tier's globs name" % (total_mb, len(chosen))
        if rung in JUDGED_TIERS:
            judge_resident(rep, "texture: tier %s ≤ %.0f MB" % (rung, budget_mb), total_mb, budget_mb,
                           why + " — serves " + JUDGED_TIERS[rung])
        else:
            rep.SKIP("texture: tier %s" % rung, why + " — NOT judged: no ceiling has been measured for this rung")


def check_texture(rep, z, names, budget_mb, top):
    rows, flags, unsized = texture_rows(z, names)
    total = sum(r[2] for r in rows)
    rows.sort(key=lambda r: -r[2])
    for name, count, size in rows[:top]:
        rep.notes.append("texture: %-48s %3d image(s) %10s" % (name[-48:], count, mb(size)))
    for f in flags:
        rep.notes.append("texture flag: " + f)
    if unsized:
        rep.refused = True
        rep.FAIL("texture: every image sized", "%d could not be sized: %s — NO TOTAL is printed, because a low total passes a Loop the phone cannot draw" % (
            len(unsized), ", ".join(unsized[:5])), "make every image PNG/JPEG/WebP/KTX2, or ask why the header does not parse")
        return
    rep.PASS("texture: every image sized", "%d files, %d images" % (len(rows), sum(r[1] for r in rows)))
    total_mb = total / 1048576
    why = "%.1f MB resident (RGBA8 + mips; KTX2 by vkFormat) over EVERYTHING in the archive — an upper bound; a tier that loads less is measured by what it loads" % total_mb
    kind, tiers = manifest_tiers(z)
    if kind == "bad":
        rep.FAIL("texture: loop.json tiers", tiers, "tiers is a list of rung names, or a map of rung → {\"assets\": [globs]}")
    if kind == "map":
        rep.PASS("texture: whole archive (payload size)", "%.1f MB across every tier — not a resident-memory verdict; each tier is judged by what it loads" % total_mb)
        check_tier_textures(rep, z, names, budget_mb, tiers)
        return
    if kind == "list":
        why += " — loop.json tiers is a list of names and does not say which files each tier loads (map each to its \"assets\" globs for a line per tier)"
    judge_resident(rep, "texture: resident memory ≤ %.0f MB" % budget_mb, total_mb, budget_mb, why)


ASTC_FIX = ("Re-encode as Basis Universal (UASTC or ETC1S) — it transcodes to the ETC2/S3TC the Mac face has. "
            "If the Loop must also draw on Apple TV (no Basis transcoder there), ship ETC2/EAC at supercompressionScheme 0: "
            "`ktx transcode --target etc-rgba in-uastc.ktx2 out.ktx2` (web/10 §3, 'KTX2 formats and the faces')")


def _astc_label(b):
    """'ASTC 6x6' for a KTX2 whose vkFormat is ASTC (157–184), at ANY supercompressionScheme; else None."""
    if len(b) < 48 or b[:12] != KTX2_ID:
        return None
    vk = struct.unpack("<I", b[12:16])[0]
    if vk < 157 or vk not in VK_COMPRESSED:
        return None
    bw, bh, _ = VK_COMPRESSED[vk]
    return "ASTC %dx%d" % (bw, bh)


def check_astc(rep, z, names):
    """publish-checks.py hard_astc_violations (COOK1, 2026-09-18). PER IMAGE: an ASTC image beside a PNG is
    still refused — the Designed-for-iPad Mac face refuses each ASTC upload on its own, silently."""
    hits = []
    for name in names:
        suffix = pathlib.PurePosixPath(name).suffix.lower()
        if suffix == ".ktx2":
            label = _astc_label(z.read(name))
            if label:
                hits.append("%s (%s)" % (name, label))
        elif suffix == ".glb":
            try:
                js, bin_ = glb_chunks(z.read(name))
            except Exception:  # noqa: BLE001 — check_texture already refuses an unreadable glb
                continue
            images = (js or {}).get("images", [])
            found = [i for i, img in enumerate(images) if "bufferView" in img and bin_ is not None
                     and _astc_label(bin_[js["bufferViews"][img["bufferView"]].get("byteOffset", 0):][:48])]
            if found:
                hits.append("%s (%d of %d images, e.g. images[%d])" % (name, len(found), len(images), found[0]))
    if hits:
        rep.FAIL("texture: no hard ASTC", "%d member(s) carry hard-ASTC KTX2, which the Mac face that ships cannot upload: %s" % (
            len(hits), "; ".join(hits[:8]) + (" …" if len(hits) > 8 else "")), ASTC_FIX)
    else:
        rep.PASS("texture: no hard ASTC", "no KTX2 image names an ASTC vkFormat")


def check_run_of_show(rep, z, names):
    """A run-of-show seed manifest (10-platform/55-run-of-show-manifest.md) ages: replay from a
    fixed `epoch` to now grows every calendar day the payload is not rebuilt, INSIDE the Loop's
    first requestAnimationFrame callback, on the host's main thread (RUNSHOW1, 2026-09-18 —
    web-test-loop-003 shipped a 19.4-day-old seed and froze Apple TV for 15.7-16.5 s). This check
    cannot catch the growth that happens AFTER you ship — only §6's rebase-on-load fix in your own
    code does that — but it catches a seed that is ALREADY stale before you tag, which is exactly
    how web-test-loop-003 shipped. Most Loops carry no run-of-show manifest at all; that is a SKIP,
    not a FAIL."""
    if RUN_OF_SHOW_MANIFEST not in names:
        rep.SKIP("manifest: run-of-show seed age", "no manifest.json in the archive — this Loop ships no run-of-show seed")
        return
    try:
        manifest = json.loads(z.read(RUN_OF_SHOW_MANIFEST).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        rep.WARN("manifest: run-of-show seed age", "manifest.json present but not readable JSON (%s)" % error,
                  "fix the JSON — this check cannot run without it")
        return
    epoch = manifest.get("epoch") if isinstance(manifest, dict) else None
    if not isinstance(epoch, (int, float)):
        rep.SKIP("manifest: run-of-show seed age", "manifest.json has no numeric 'epoch' — not a run-of-show manifest")
        return
    n_events = len((manifest.get("events") or [])) if isinstance(manifest, dict) else 0
    age_days = (dt.datetime.now(dt.timezone.utc).timestamp() - epoch) / 86400.0
    if age_days < 0:
        rep.WARN("manifest: run-of-show seed age", "epoch is %.1f day(s) in the future — check the clock that generated it")
        return
    predicted_ms = age_days * n_events * ROS_MS_PER_EVENT_DAY
    detail = "%.1f day(s) old, %d event(s), ~%.0f ms predicted first-frame replay (55-run-of-show-manifest.md §6)" % (
        age_days, n_events, predicted_ms)
    if predicted_ms >= ROS_FAIL_MS:
        rep.FAIL("manifest: run-of-show seed age", detail,
                 "rebase the seed onto the current window before you build (55-run-of-show-manifest.md §6's snippet), "
                 "or ship the rebase-on-load fix in your own code so this stops growing after release")
    elif predicted_ms >= ROS_WARN_MS:
        rep.WARN("manifest: run-of-show seed age", detail,
                 "getting stale — rebase before you tag, or implement §6's rebase-on-load so it never needs remembering again")
    else:
        rep.PASS("manifest: run-of-show seed age", detail)


# ─────────────────────────────────────────────────────────────────────────────────────────────
# 4. Ceilings, the name, the sums, the digest  (20-contract/20 §2–4; 40-delivery/10 §1–2; loop-intake R1–R3)
# ─────────────────────────────────────────────────────────────────────────────────────────────
def check_size(rep, size, bundled):
    if bundled and size > BUNDLED_CEILING:
        rep.FAIL("size: bundled ceiling 25 MB", mb(size), "a bundled Loop ships inside the app binary; 25 MB is enforced by CI")
    elif size > PAYLOAD_CEILING:
        rep.FAIL("size: payload ceiling 200 MB", mb(size), "over the hard ceiling (20-contract/20 §2)")
    elif size > PAYLOAD_TARGET:
        rep.WARN("size: payload ceiling 200 MB", "%s — under the ceiling, over the 150 MB target" % mb(size))
    else:
        rep.PASS("size: payload ceiling 200 MB", mb(size))


def content_digest(z, names):
    rows = sorted((n, hashlib.sha256(z.read(n)).hexdigest()) for n in names if not n.endswith("/"))
    return hashlib.sha256("".join("%s  %s\n" % (h, n) for n, h in rows).encode()).hexdigest(), len(rows)


# COOK2 (2026-09-23) — one cook per platform: `<loop-id>[-catalog][-<platform>]-<day>-<sha8>.zip`. The
# platform is one of the catalog's payload keys; the untagged zip is the default every other surface
# reads. A token that LOOKS like a platform and is not one is refused (40-delivery/10 §1).
COOK_PLATFORMS = {"tvos": "Apple TV", "ios": "iPhone", "ipados": "iPad", "macos": "Mac"}
PLATFORM_LOOKALIKES = ("tv", "appletv", "atv", "iphone", "ipad", "mac", "osx", "macosx",
                       "visionos", "xros", "watchos", "android", "roku")


def check_name(rep, payload, sha256, loop_id, lane):
    name = payload.name
    m = re.match(r"^([a-z0-9][a-z0-9-]*?)(-catalog)?(?:-(tvos|ios|ipados|macos))?-(\d{8})-([0-9a-f]{8})\.zip$", name)
    if not m:
        rep.FAIL("name: <loop-id>-<YYYYMMDD>-<sha8>.zip", "%r does not match" % name,
                 "sha=$(shasum -a 256 f.zip | cut -c1-8); mv f.zip <loop-id>-$(date +%%Y%%m%%d)-$sha.zip  (40-delivery/10 §1)")
        return
    nid, _cat, platform, day, sha8 = m.groups()
    tail = nid[len(loop_id) + 1:] if loop_id and nid.startswith(loop_id + "-") else nid
    lookalike = [t for t in tail.split("-") if t in PLATFORM_LOOKALIKES]
    if lookalike:
        rep.FAIL("name: <loop-id>-<YYYYMMDD>-<sha8>.zip", "`-%s-` is not a platform key — a cook is tagged "
                 "-tvos-, -ios-, -ipados- or -macos-, or untagged for the default" % lookalike[0],
                 "rename with the catalog's payload key, then re-sum (40-delivery/10 §1)")
        return
    if sha8 != sha256[:8]:
        rep.FAIL("name: <loop-id>-<YYYYMMDD>-<sha8>.zip", "the name says %s, the bytes say %s — a rebuild or a rename" % (sha8, sha256[:8]),
                 "never rename to an old sha8; name the file from ITS OWN bytes after it is written")
    elif loop_id and nid != loop_id:
        rep.FAIL("name: <loop-id>-<YYYYMMDD>-<sha8>.zip", "the name's id is %r, --id is %r" % (nid, loop_id),
                 "the id is the catalog id, not the repo name; check the catalog origin before choosing (40-metadata §1)")
    else:
        cook = (" — the %s cook: payloads.%s, read by %s" % (platform, platform, COOK_PLATFORMS[platform])
                if platform else " — the default cook")
        rep.PASS("name: <loop-id>-<YYYYMMDD>-<sha8>.zip", "%s — sha8 matches the bytes%s%s" % (
            name, "" if loop_id else " (no --id given, id unchecked)", cook))


PER_COOK_FIELDS = ("tiers", "readyBudgetSeconds", "render")   # render: RSCALE1, 2026-09-25 — the intake's own list


def check_parity(rep, z, default_path):
    """COOK2 — a platform cook's loop.json against the default cook's: equal except tiers,
    readyBudgetSeconds and render. The catalog side refuses a mismatch by field (loop-intake.py)."""
    if not default_path:
        return
    try:
        mine = json.loads(z.read(MANIFEST))
        with zipfile.ZipFile(default_path) as d:
            theirs = json.loads(d.read(MANIFEST))
    except (KeyError, ValueError, OSError, zipfile.BadZipFile) as error:
        rep.FAIL("parity: loop.json matches the default cook's", "could not read both manifests: %s" % error,
                 "--default is the untagged zip of the same release")
        return
    differ = sorted(k for k in set(mine) | set(theirs) if k not in PER_COOK_FIELDS and mine.get(k) != theirs.get(k))
    if differ:
        rep.FAIL("parity: loop.json matches the default cook's", "differs in %s" % ", ".join("`%s`" % k for k in differ),
                 "every cook's loop.json matches the default's except tiers, readyBudgetSeconds and render (40-delivery/10 §1)")
    elif mine.get("readyBudgetSeconds") != theirs.get("readyBudgetSeconds"):
        rep.WARN("parity: loop.json matches the default cook's", "readyBudgetSeconds %s here, %s in the default — the catalog "
                 "carries ONE per Loop, the default's" % (mine.get("readyBudgetSeconds"), theirs.get("readyBudgetSeconds")),
                 "declare the budget the slowest surface needs in the default cook")
    else:
        rep.PASS("parity: loop.json matches the default cook's", "apart from the per-cook fields (tiers, readyBudgetSeconds, render)")


def check_sums(rep, payload, sha256, sums_path, lane):
    p = pathlib.Path(sums_path) if sums_path else payload.parent / SUMS_NAME
    if not p.is_file():
        msg = "no %s beside the payload" % SUMS_NAME
        if lane == "release":
            rep.FAIL("sums: SHA256SUMS.txt agrees", msg, "shasum -a 256 <file> > SHA256SUMS.txt && shasum -a 256 -c SHA256SUMS.txt")
        else:
            rep.WARN("sums: SHA256SUMS.txt agrees", msg + " (dev lane: the staging tool warns and continues)", "write it for every cook anyway")
        return
    listed = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([0-9a-f]{64})\s+\*?(.+)$", line.strip())
        if m:
            listed[pathlib.PurePosixPath(m.group(2)).name] = m.group(1)
    if payload.name not in listed:
        rep.FAIL("sums: SHA256SUMS.txt agrees", "%s does not list %s (it lists: %s) — a sums file left over from a previous cook is the most common submission fault" % (
            p.name, payload.name, ", ".join(listed) or "nothing"), "regenerate the sums for THIS file")
    elif listed[payload.name] != sha256:
        rep.FAIL("sums: SHA256SUMS.txt agrees", "%s lists a different sha256 for %s" % (p.name, payload.name), "regenerate the sums for THIS file; never edit them by hand")
    else:
        rep.PASS("sums: SHA256SUMS.txt agrees", "%s lists %s with the right sha256" % (p.name, payload.name))


# ─────────────────────────────────────────────────────────────────────────────────────────────
# 5. catalog-assets — the entry and the masters  (10-platform/40-metadata.md; loop-intake R7–R9)
# ─────────────────────────────────────────────────────────────────────────────────────────────
def parse_entry(text):
    """Frontmatter + about body. PyYAML if present; otherwise a small reader for the shapes the
    scaffold uses (key: value, two-space nesting, inline {a: b} maps, [] lists)."""
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        return None, text
    front_text, body = m.group(1), m.group(2)
    try:
        import yaml  # type: ignore
        return yaml.safe_load(front_text) or {}, body
    except ImportError:
        pass
    return _mini_yaml(front_text), body


def _scalar(v):
    v = v.strip()
    if v.startswith('"') and v.endswith('"') or v.startswith("'") and v.endswith("'"):
        return v[1:-1]
    if v == "[]":
        return []
    if v.startswith("{") and v.endswith("}"):
        out = {}
        for part in re.split(r",\s*(?=[A-Za-z_]+\s*:)", v[1:-1]):
            if ":" in part:
                k, val = part.split(":", 1)
                out[k.strip()] = _scalar(val)
        return out
    if v in ("true", "false"):
        return v == "true"
    return v


def _mini_yaml(text):
    root, stack = {}, [(-1, {})]
    stack[0] = (-1, root)
    for raw in text.splitlines():
        line = raw.split(" #")[0].rstrip() if not raw.strip().startswith('"') else raw.rstrip()
        if not line.strip() or line.strip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        key, _, val = line.strip().partition(":")
        while stack and stack[-1][0] >= indent:
            stack.pop()
        parent = stack[-1][1]
        if val.strip() == "":
            parent[key] = {}
            stack.append((indent, parent[key]))
        else:
            parent[key] = _scalar(val)
    return root


def _get(d, *path):
    for p in path:
        if not isinstance(d, dict):
            return None
        d = d.get(p)
    return d


# The show-notes subset, as what is REFUSED — publish-checks.py `_MD_REFUSED`, copied EXACTLY:
# patterns, flags and labels (PFL1, #307). Everything not named here is paragraphs, emphasis, strong,
# https links and ONE-LEVEL lists (FX3, 2026-09-17). This file used to refuse every list and a `---`
# rule, and to miss nesting, indented code, `####` and http links — the pre-FX3 subset.
MD_REFUSED = (
    (re.compile(r"!\["), "an image"),
    (re.compile(r"<[a-zA-Z/!]"), "raw HTML"),
    (re.compile(r"^```|^~~~", re.M), "a code fence"),
    (re.compile(r"^ {4,}(?![-*+] |\d+[.)] )\S", re.M), "an indented code block"),
    (re.compile(r"^[ \t]+([-*+] |\d+[.)] )", re.M),
     "a nested list — the subset admits ONE level"),
    (re.compile(r"^\|", re.M), "a table"),
    (re.compile(r"^#(?!#)", re.M), "an h1 — the screen owns that level; show notes start at `##`"),
    (re.compile(r"^#{4,}", re.M), "a heading below `###`"),
    (re.compile(r"\]\(\s*(?!https://)[^)]*\)"), "a link that is not https"),
)


def about_refusals(about):
    """Every show-notes rule this text breaks, by label, in the gate's order (publish-checks.py _check_text)."""
    return [what for pattern, what in MD_REFUSED if pattern.search(about)]


def check_entry(rep, assets, loop_id, version, lane):
    if not assets:
        rep.SKIP("entry: catalog-entry.md", "no --catalog-assets given", "pass the repo's catalog-assets/ to check the entry and the masters")
        return
    assets = pathlib.Path(assets)
    entry = assets / ENTRY_NAME
    if not entry.is_file():
        rep.FAIL("entry: catalog-entry.md", "%s is missing — the Loop Pool cannot receive a release without it" % entry,
                 "scaffold it from 40-metadata.md §9 and commit it before you tag")
        return
    front, about = parse_entry(entry.read_text(encoding="utf-8"))
    if front is None:
        rep.FAIL("entry: catalog-entry.md", "no YAML frontmatter block", "start the file with --- … ---")
        return
    rep.PASS("entry: catalog-entry.md", "present, frontmatter parses")
    eid = _get(front, "id")
    if loop_id and eid != loop_id:
        rep.FAIL("entry: id", "entry says %r, --id is %r — the workflow reads the id FROM THIS FILE at the tag" % (eid, loop_id),
                 "make them agree; the id is permanent and is the cache namespace on every device")
    elif not eid:
        rep.FAIL("entry: id", "no id: in the frontmatter", "id: <loop-id>")
    else:
        rep.PASS("entry: id", str(eid))
    for field, limit in (("title", TITLE_MAX), ("description", DESCRIPTION_MAX)):
        val = _get(front, field)
        if not val:
            (rep.FAIL if field == "title" or lane == "release" else rep.WARN)(
                "entry: %s" % field, "empty", "fill it in — %s is ≤ %d characters (40-metadata §1)" % (field, limit))
        elif len(str(val)) > limit:
            rep.FAIL("entry: %s" % field, "%d characters, limit %d" % (len(str(val)), limit), "shorten it")
        else:
            rep.PASS("entry: %s" % field, "%d/%d characters" % (len(str(val)), limit))
    ver = _get(front, "version", "content")
    if version and str(ver) != version:
        rep.FAIL("entry: version.content", "entry says %r, the release is %r" % (ver, version), "version.content equals the tag without its v")
    elif ver in (None, "", "0.0.0") and lane == "release":
        rep.FAIL("entry: version.content", "%r is not a release version" % (ver,), "set it to the tag's X.Y.Z")
    else:
        rep.PASS("entry: version.content", str(ver))
    band = _get(front, "rating", "ageBand")
    if band not in AGE_BANDS:
        rep.FAIL("entry: rating.ageBand", "%r is not one of %s" % (band, "/".join(AGE_BANDS)), "Apple's current bands; 12+/17+ were retired")
    else:
        rep.PASS("entry: rating.ageBand", str(band))
    avail = _get(front, "availability") or {}
    if isinstance(avail, dict):
        open_on = [k for k, v in avail.items() if isinstance(v, dict) and v.get("mode") == "embed"]
        rep.notes.append("entry: availability embed on: %s (proven is never yours to state)" % (", ".join(open_on) or "none"))
    # The show notes: the Markdown subset the publish gate enforces.
    body = about.strip()
    body = re.sub(r"^#\s*about\s*$", "", body, flags=re.M | re.I).strip()
    problems = about_refusals(body)
    if not body or body.startswith("TODO"):
        (rep.FAIL if lane == "release" else rep.WARN)("entry: about (show notes)", "empty or TODO", "write the show notes (40-metadata §3)")
    elif len(body) > ABOUT_MAX:
        rep.FAIL("entry: about (show notes)", "%d characters, limit %d" % (len(body), ABOUT_MAX), "shorten it")
    elif problems:
        rep.FAIL("entry: about (show notes)", "contains %s — the publish gate refuses it" % "; ".join(problems),
                 "only ## / ### headings, paragraphs, *emphasis*, **strong**, [links](https://…), "
                 "and -/*/1. lists ONE level deep (40-metadata.md §3)")
    else:
        rep.PASS("entry: about (show notes)", "%d/%d characters, subset OK" % (len(body), ABOUT_MAX))
    # The masters.
    for role, (mw, mh), ratio in (("poster", POSTER_MIN, 3 / 4), ("wide", WIDE_MIN, 16 / 9)):
        declared = _get(front, "artwork", "masters", role, "file") or "%s-%s.png" % (eid or "loop", role)
        p = assets / str(declared)
        if not p.is_file():
            (rep.FAIL if lane == "release" else rep.WARN)("masters: %s" % role, "%s is missing" % p.name,
                                                          "%s master, %s, ≥ %d×%d, no text, bottom-right 22%%×14%% clear (40-metadata §2)" % (role, "3:4" if role == "poster" else "16:9", mw, mh))
            continue
        d = image_dims(p.read_bytes()[:65536])
        if d is None:
            rep.FAIL("masters: %s" % role, "%s is not a PNG/JPEG this tool can read" % p.name, "PNG or JPEG q ≥ 92, sRGB, no alpha")
            continue
        w, h = d
        if w < mw or h < mh:
            rep.FAIL("masters: %s" % role, "%dx%d, minimum %dx%d" % (w, h, mw, mh), "render at or above the minimum")
        elif abs((w / h) - ratio) > 0.01:
            rep.FAIL("masters: %s" % role, "%dx%d is not %s" % (w, h, "3:4" if role == "poster" else "16:9"), "compose for the shape; not a crop of the other master")
        else:
            rep.PASS("masters: %s" % role, "%s %dx%d" % (p.name, w, h))


# ─────────────────────────────────────────────────────────────────────────────────────────────
# The run
# ─────────────────────────────────────────────────────────────────────────────────────────────
def run(args):
    rep = Report()
    payload = pathlib.Path(args.payload).resolve()
    if not payload.is_file():
        print("no such file: %s" % payload, file=sys.stderr)
        return 2, rep
    data = payload.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    stamp_dir = args.stamp_dir or (pathlib.Path(args.catalog_assets).resolve().parent if args.catalog_assets else payload.parent)
    check_docs(rep, args.docs, stamp_dir, args.offline)
    if args.docs:
        check_copy(rep, args.docs)
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        rep.FAIL("archive: readable ZIP", str(error), "a web-archive payload is a ZIP of the Loop's tree")
        return 1, rep
    with z:
        names = z.namelist()
        check_size(rep, len(data), args.bundled)
        check_archive(rep, z, names)
        check_vendoring(rep, z, names)
        check_texture(rep, z, names, args.budget_mb, args.top)
        check_astc(rep, z, names)
        check_run_of_show(rep, z, names)
        check_parity(rep, z, getattr(args, "default", None))
        digest, members = content_digest(z, names)
    check_name(rep, payload, sha256, args.id, args.lane)
    check_sums(rep, payload, sha256, args.sums, args.lane)
    check_entry(rep, args.catalog_assets, args.id, args.version, args.lane)
    rep.notes.insert(0, "sha256 %s  %s" % (sha256, payload.name))
    rep.notes.insert(1, "content digest %s (%d members) — survives a rebuild; the sha256 does not (web/00 §3 rule 11)" % (digest, members))
    code = 2 if rep.refused else (1 if rep.verdict() == "NOT READY" else 0)
    return code, rep


def print_report(rep, as_json, payload, lane):
    if as_json:
        print(json.dumps({"verdict": rep.verdict(), "lane": lane, "payload": str(payload),
                          "checks": [r._asdict() for r in rep.rows], "notes": rep.notes}, indent=2))
        return
    print("loop-preflight — %s (%s lane)\n" % (payload, lane))
    for r in rep.rows:
        print("%-4s  %-46s %s" % (r.status, r.check[:46], r.why))
        if r.fix and r.status in ("FAIL", "WARN"):
            print("      ↳ %s" % r.fix)
    print()
    for n in rep.notes:
        print("      " + n)
    print("\n%s" % rep.verdict())
    if rep.verdict() == "NOT READY":
        print("Fix, rebuild, and run again — a rebuild is a NEW file; name it from its own bytes and regenerate the sums.")


# ─────────────────────────────────────────────────────────────────────────────────────────────
# --self-test: every check watched failing on a planted violation
# ─────────────────────────────────────────────────────────────────────────────────────────────
def _png_bytes(w, h):
    import zlib
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x00\x00\x00" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _ktx2_bytes(vk, w, h, levels=1):
    bw, bh, bb = VK_COMPRESSED[vk]
    level0 = _blocks(w, bw) * _blocks(h, bh) * bb
    head = KTX2_ID + struct.pack("<9I", vk, 1, w, h, 0, 0, 1, levels, 0) + b"\x00" * 32
    idx = b"".join(struct.pack("<3Q", 104 + 24 * levels, level0 >> i * 2, level0 >> i * 2) for i in range(levels))
    return head + idx + b"\x00" * level0


def _make_zip(members):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in members.items():
            z.writestr(name, data)
    return buf.getvalue()


def self_test():
    failures = []
    def expect(label, rep, check_prefix, status):
        hit = [r for r in rep.rows if r.check.startswith(check_prefix)]
        ok = bool(hit) and hit[0].status == status
        print("%s  %s → %s %s" % ("ok  " if ok else "FAIL", label, check_prefix, (hit[0].status if hit else "MISSING")))
        if not ok:
            failures.append(label)

    clean = {MANIFEST: json.dumps({"manifestVersion": 1, "entry": "index.html"}),
             "index.html": "<script type=module src=main.js></script>",
             "main.js": "import './x.js'; // https://example.com in a comment is fine\n",
             "x.js": "export const ns = 'http://www.w3.org/2000/svg';\n",
             "a.png": _png_bytes(64, 64)}

    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        class A:  # minimal args
            def __init__(self, payload, **kw):
                self.payload, self.id, self.lane, self.version = payload, "test-loop", "dev", None
                self.catalog_assets, self.sums, self.docs, self.offline = None, None, None, True
                self.budget_mb, self.json, self.top, self.bundled, self.stamp_dir = 370.0, False, 5, False, str(tmp)
                self.default = None
                self.__dict__.update(kw)

        def write(name_data, name="test-loop-20260101-deadbeef.zip"):
            p = tmp / name
            p.write_bytes(_make_zip(name_data) if isinstance(name_data, dict) else name_data)
            return p

        def named(data):
            sha = hashlib.sha256(data).hexdigest()[:8]
            p = tmp / ("test-loop-20260101-%s.zip" % sha)
            p.write_bytes(data)
            return p

        def named_as(data, pattern):
            p = tmp / (pattern % hashlib.sha256(data).hexdigest()[:8])
            p.write_bytes(data)
            return p

        # 0. the clean archive is READY (dev lane)
        p = named(_make_zip(clean))
        code, rep = run(A(str(p)))
        ok = rep.verdict() == "READY"
        print("%s  clean archive is READY (%s)" % ("ok  " if ok else "FAIL", rep.verdict()))
        if not ok:
            failures.append("clean")
            for r in rep.rows:
                if r.status == "FAIL":
                    print("      " + r.check + ": " + r.why)
        # excused URL is printed
        ok = any("excused" in n and "w3.org" in n for n in rep.notes)
        print("%s  the allowlist excuse is printed" % ("ok  " if ok else "FAIL"))
        if not ok:
            failures.append("excuse printed")

        TWO_TIER = {MANIFEST: json.dumps({"manifestVersion": 1, "entry": "index.html", "tiers": {"phone": {"assets": ["lean/*.png"]}, "desktop": {"assets": ["desktop/*.png"]}}}),
                    "lean/sand.png": _png_bytes(10000, 10000), "desktop/sand.png": _png_bytes(256, 256)}
        plants = [
            ("loop.json nested (zipped the folder)", {**{k: v for k, v in clean.items() if k != MANIFEST}, "loop/loop.json": clean[MANIFEST]}, "manifest: loop.json at the archive root", "FAIL"),
            ("entry missing", {**clean, MANIFEST: json.dumps({"manifestVersion": 1, "entry": "nope.html"})}, "manifest: entry resolves", "FAIL"),
            ("manifestVersion 2", {**clean, MANIFEST: json.dumps({"manifestVersion": 2, "entry": "index.html"})}, "manifest: manifestVersion", "FAIL"),
            ("bad camera", {**clean, MANIFEST: json.dumps({"manifestVersion": 1, "entry": "index.html", "cameras": [{"title": "x"}]})}, "manifest: cameras", "FAIL"),
            ("zip-slip member", {**clean, "../evil.js": "x"}, "archive: no unsafe members", "FAIL"),
            (".DS_Store", {**clean, ".DS_Store": b"\x00"}, "archive: no macOS metadata", "FAIL"),
            # MEDIA6 — the media lane's reserved prefix, as the gate refuses it (MEDIA2).
            ("a media/ folder in the payload", {**clean, "media/music/a.m4a": b"\x00" * 8}, "archive: no media/ folder", "FAIL"),
            ("a media/ folder NESTED is only a folder name", {**clean, "assets/media/a.png": _png_bytes(8, 8)}, "archive: no media/ folder", "PASS"),
            ("directory entry", {**clean, "assets/": b""}, "archive: directory entries", "WARN"),
            ("CDN import in JS", {**clean, "main.js": "import * as T from 'https://unpkg.com/three';"}, "vendoring: no external", "FAIL"),
            ("transcoder path string", {**clean, "main.js": "k.setTranscoderPath('https://cdn.jsdelivr.net/basis/');"}, "vendoring: no external", "FAIL"),
            ("importmap in HTML", {**clean, "index.html": '<script type="importmap">{"imports":{"three":"https://unpkg.com/three"}}</script>'}, "vendoring: no external", "FAIL"),
            ("CSS @import", {**clean, "s.css": "@import url(https://fonts.example/x.css);"}, "vendoring: no external", "FAIL"),
            ("URL in a JS comment is NOT a hit", {**clean, "main.js": "/* https://unpkg.com/three */ const a = 1; // https://x.y\n"}, "vendoring: no external", "PASS"),
            # PFL1 (#307) — the minified-line cases, each run through the GATE's comment stripper.
            ("a URL STRING past column 4000 is found", {**clean, "main.js": "const s='" + "a" * 5000 + "';const u='https://x.y/z';"}, "vendoring: no external", "FAIL"),
            ("a URL in a real // comment past column 4000 is not a hit (the gate strips it)", {**clean, "main.js": "const s='" + "a" * 5000 + "';//https://x.y/z"}, "vendoring: no external", "PASS"),
            # three.js r18x's three.module.min.js: a GLSL `// https://jcgt.org/…` comment inside a
            # shader string on a 365,459-column line. The gate passes it; so must this.
            ("three.js's jcgt.org GLSL comment on a minified line (#307)", {**clean, "vendor/three/three.module.min.js": "const a='" + "a" * 5000 + "',b=\"\\n\\t\\t\\t// https://jcgt.org/published/0007/04/01/\\n\\t\\t\\tvec3 V = x;\";"}, "vendoring: no external", "PASS"),
            ("unreadable text member", {**clean, "b.js": b"\xff\xfe\x00bad"}, "vendoring: every text member scanned", "FAIL"),
            ("texture over budget (2 × 8192² RGBA)", {**clean, "big1.png": _png_bytes(8192, 8192), "big2.png": _png_bytes(8192, 8192)}, "texture: resident memory", "FAIL"),
            ("texture near budget (WARN band)", {**clean, "big.png": _png_bytes(8192, 4096), "b2.png": _png_bytes(4096, 4096), "b3.png": _png_bytes(4096, 4096)}, "texture: resident memory", "WARN"),
            ("unsizable image refuses a total", {**clean, "mystery.webp": b"RIFF\x00\x00\x00\x00WEBPXXXX"}, "texture: every image sized", "FAIL"),
            # TIER2 — a two-tier payload is judged per tier: the phone set over budget FAILS its own
            # line, the desktop set prints and is not judged, the whole archive is the payload size.
            ("two tiers: phone set over budget", {**clean, **TWO_TIER}, "texture: tier phone", "FAIL"),
            ("two tiers: desktop set printed, not judged", {**clean, **TWO_TIER}, "texture: tier desktop", "SKIP"),
            ("two tiers: whole archive is the payload size", {**clean, **TWO_TIER}, "texture: whole archive", "PASS"),
            ("list-only tiers: the whole-archive verdict, saying why", {**clean, MANIFEST: json.dumps({"manifestVersion": 1, "entry": "index.html", "tiers": ["phone", "desktop"]})}, "texture: resident memory", "PASS"),
            ("a tier glob that matches nothing", {**clean, MANIFEST: json.dumps({"manifestVersion": 1, "entry": "index.html", "tiers": {"phone": {"assets": ["laen/*.png"]}}})}, "texture: tier phone", "FAIL"),
        ]
        for label, members, prefix, status in plants:
            p = named(_make_zip(members))
            code, rep = run(A(str(p)))
            expect(label, rep, prefix, status)
        # COOK1 — hard ASTC refused, Basis accepted, and the MIXED case (ASTC beside a PNG) refused.
        basis = KTX2_ID + struct.pack("<9I", 0, 1, 64, 64, 0, 0, 1, 1, 2) + b"\x00" * 32 + struct.pack("<3Q", 128, 0, 0)
        def glb_of(images):
            blob, views, entries = b"", [], []
            for i, data in enumerate(images):
                views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
                entries.append({"bufferView": i})
                blob += data + b"\x00" * ((4 - len(data) % 4) % 4)
            j = json.dumps({"asset": {"version": "2.0"}, "images": entries, "bufferViews": views}).encode()
            j += b" " * ((4 - len(j) % 4) % 4)
            return (b"glTF" + struct.pack("<II", 2, 12 + 8 + len(j) + 8 + len(blob)) + struct.pack("<II", len(j), 0x4E4F534A)
                    + j + struct.pack("<II", len(blob), 0x004E4942) + blob)
        for label, members, status in (
                ("hard ASTC 6x6 KTX2 is refused", {**clean, "t.ktx2": _ktx2_bytes(165, 64, 64)}, "FAIL"),
                ("Basis (vkFormat 0, zstd) KTX2 is accepted", {**clean, "t.ktx2": basis, "m.glb": glb_of([basis])}, "PASS"),
                ("MIXED: an ASTC image beside a PNG in one glb is refused",
                 {**clean, "m.glb": glb_of([_png_bytes(8, 8), _ktx2_bytes(166, 64, 64)])}, "FAIL")):
            p = named(_make_zip(members))
            code, rep = run(A(str(p)))
            expect(label, rep, "texture: no hard ASTC", status)
        # RUNSHOW1 (2026-09-18) — the run-of-show seed manifest ages; catch it before it ships.
        # No manifest.json at all (most Loops) is a SKIP — already proven READY by "clean" above.
        code, rep = run(A(str(named(_make_zip(clean)))))
        expect("no run-of-show manifest at all", rep, "manifest: run-of-show seed age", "SKIP")
        ros_now = dt.datetime.now(dt.timezone.utc).timestamp()
        nine_events = [{"id": "e%d" % i} for i in range(9)]
        for label, age_days, status in (
                ("fresh run-of-show seed (epoch = now)", 0, "PASS"),
                ("1-day-old run-of-show seed, 9 events (~800 ms predicted)", 1, "WARN"),
                ("19.4-day-old run-of-show seed, 9 events (matches web-test-loop-003's device measurement)", 19.4, "FAIL")):
            ros = json.dumps({"manifestVersion": 1, "epoch": ros_now - age_days * 86400, "events": nine_events})
            p = named(_make_zip({**clean, RUN_OF_SHOW_MANIFEST: ros}))
            code, rep = run(A(str(p)))
            expect(label, rep, "manifest: run-of-show seed age", status)
        # KTX2 sizing: ASTC 6x6 1024² single level = 171*171*16 = 467,856 bytes, no mip factor.
        k = _ktx2_bytes(165, 1024, 1024)          # 165 = VK_FORMAT_ASTC_6x6_UNORM_BLOCK (157 + 2*4)
        p = named(_make_zip({**clean, "t.ktx2": k}))
        code, rep = run(A(str(p)))
        row = [n for n in rep.notes if "t.ktx2" in n]
        ok = bool(row) and "0.4 MB" in row[0]
        print("%s  KTX2 ASTC 6x6 1024² single-level sizes to 0.4 MB (%s)" % ("ok  " if ok else "FAIL", row[0].strip() if row else "no row"))
        if not ok:
            failures.append("ktx2 sizing")
        # glb with an embedded image
        png = _png_bytes(2048, 2048)
        js = json.dumps({"asset": {"version": "2.0"}, "images": [{"bufferView": 0, "mimeType": "image/png"}],
                         "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(png)}]}).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        pad = png + b"\x00" * ((4 - len(png) % 4) % 4)
        glb = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(pad)) + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(pad), 0x004E4942) + pad
        p = named(_make_zip({**clean, "m.glb": glb}))
        code, rep = run(A(str(p)))
        row = [n for n in rep.notes if "m.glb" in n]
        ok = bool(row) and "21.3 MB" in row[0]
        print("%s  a 2048² PNG inside a .glb is counted (21.3 MB) (%s)" % ("ok  " if ok else "FAIL", row[0].strip() if row else "no row"))
        if not ok:
            failures.append("glb image")
        # name / sums / entry / masters
        data = _make_zip(clean)
        p = write(data, "test-loop-20260101-00000000.zip")
        code, rep = run(A(str(p)))
        expect("sha8 in the name lies about the bytes", rep, "name:", "FAIL")
        p = named(data)
        (tmp / SUMS_NAME).write_text("%s  other.zip\n" % ("0" * 64))
        code, rep = run(A(str(p), sums=str(tmp / SUMS_NAME)))
        expect("stale SHA256SUMS.txt (names another file)", rep, "sums:", "FAIL")
        (tmp / SUMS_NAME).write_text("%s  %s\n" % ("0" * 64, p.name))
        code, rep = run(A(str(p), sums=str(tmp / SUMS_NAME)))
        expect("SHA256SUMS.txt with a wrong hash", rep, "sums:", "FAIL")
        (tmp / SUMS_NAME).write_text("%s  %s\n" % (hashlib.sha256(data).hexdigest(), p.name))
        code, rep = run(A(str(p), sums=str(tmp / SUMS_NAME)))
        expect("SHA256SUMS.txt that agrees", rep, "sums:", "PASS")
        code, rep = run(A(str(p), sums=str(tmp / "missing.txt"), lane="release"))
        expect("release lane: missing sums", rep, "sums:", "FAIL")
        assets = tmp / "catalog-assets"
        assets.mkdir(exist_ok=True)
        entry = ("---\nid: test-loop\ntitle: \"A Title\"\ndescription: \"Desc\"\nversion:\n  content: \"1.2.3\"\n"
                 "rating:\n  ageBand: \"4+\"\nartwork:\n  masters:\n    poster: { file: test-loop-poster.png, width: 0, height: 0 }\n"
                 "    wide: { file: test-loop-wide.png, width: 0, height: 0 }\navailability:\n  ios: { mode: embed, reason: \"\", note: \"\" }\n---\n\n# about\n\nA paragraph with *emphasis*.\n")
        (assets / ENTRY_NAME).write_text(entry)
        (assets / "test-loop-poster.png").write_bytes(_png_bytes(1200, 1600))
        (assets / "test-loop-wide.png").write_bytes(_png_bytes(3840, 2160))
        code, rep = run(A(str(p), catalog_assets=str(assets), version="1.2.3", lane="release", sums=str(tmp / SUMS_NAME)))
        for prefix in ("entry: id", "entry: title", "entry: version.content", "entry: rating.ageBand", "entry: about", "masters: poster", "masters: wide"):
            expect("good entry: %s" % prefix, rep, prefix, "PASS")
        code, rep = run(A(str(p), catalog_assets=str(assets), version="9.9.9", lane="release"))
        expect("version.content disagrees with the tag", rep, "entry: version.content", "FAIL")
        code, rep = run(A(str(p), catalog_assets=str(assets), id="other-loop", lane="release"))
        expect("entry id disagrees with --id", rep, "entry: id", "FAIL")
        # PFL1 (#307) — the gate's subset since FX3: ONE level of list is accepted, nesting refused.
        for label, body, status in (
                ("about with a one-level `-` list", "Credits:\n\n- one\n- two", "PASS"),
                ("about with a one-level `1.` list", "1. one\n2. two", "PASS"),
                ("about with a nested list", "- one\n  - nested", "FAIL"),
                ("about with a `####` heading", "#### too deep", "FAIL"),
                ("about with an http link", "[x](http://example.com)", "FAIL")):
            (assets / ENTRY_NAME).write_text(entry.replace("A paragraph with *emphasis*.", body))
            code, rep = run(A(str(p), catalog_assets=str(assets), lane="release"))
            expect(label, rep, "entry: about", status)
        (assets / ENTRY_NAME).write_text(entry.replace("\"A Title\"", "\"" + "x" * 29 + "\""))
        code, rep = run(A(str(p), catalog_assets=str(assets), lane="release"))
        expect("title of 29 characters", rep, "entry: title", "FAIL")
        # LDTOOLS1 (#398) — `subtitle` retired 2026-09-26 (40-metadata §1): absent is clean, stated is ignored.
        bare = entry.replace("subtitle: \"Sub\"\n", "")
        for label, text in (("an entry with no subtitle", bare),
                            ("an entry that still states a subtitle", bare.replace("description:", "subtitle: \"Sub\"\ndescription:", 1))):
            (assets / ENTRY_NAME).write_text(text)
            code, rep = run(A(str(p), catalog_assets=str(assets), lane="release"))
            bad = [r for r in rep.rows if r.check.startswith("entry: subtitle")]
            print("%s  %s → no `entry: subtitle` row" % ("ok  " if not bad else "FAIL", label))
            if bad:
                failures.append(label)
        (assets / ENTRY_NAME).write_text(entry.replace("\"4+\"", "\"12+\""))
        code, rep = run(A(str(p), catalog_assets=str(assets), lane="release"))
        expect("retired age band 12+", rep, "entry: rating.ageBand", "FAIL")
        (assets / ENTRY_NAME).write_text(entry)
        (assets / "test-loop-poster.png").write_bytes(_png_bytes(1000, 1333))
        code, rep = run(A(str(p), catalog_assets=str(assets), lane="release"))
        expect("poster under 1200×1600", rep, "masters: poster", "FAIL")
        (assets / "test-loop-poster.png").write_bytes(_png_bytes(1600, 1600))
        code, rep = run(A(str(p), catalog_assets=str(assets), lane="release"))
        expect("poster not 3:4", rep, "masters: poster", "FAIL")
        (assets / "test-loop-wide.png").unlink()
        (assets / "test-loop-poster.png").write_bytes(_png_bytes(1200, 1600))
        code, rep = run(A(str(p), catalog_assets=str(assets), lane="release"))
        expect("release lane: wide master missing", rep, "masters: wide", "FAIL")
        code, rep = run(A(str(p), catalog_assets=str(assets), lane="dev"))
        expect("dev lane: wide master missing is a WARN", rep, "masters: wide", "WARN")
        # COOK2 (2026-09-23) — one cook per platform: a `-tvos-` zip beside the default.
        tv = named_as(_make_zip({**clean, "tv.js": "// the TV cook"}), "test-loop-tvos-20260101-%s.zip")
        code, rep = run(A(str(tv)))
        expect("a -tvos- cook's name is canonical", rep, "name:", "PASS")
        code, rep = run(A(str(named_as(_make_zip(clean), "test-loop-appletv-20260101-%s.zip"))))
        expect("a -appletv- tag is not a platform key", rep, "name:", "FAIL")
        default = named(_make_zip(clean))
        code, rep = run(A(str(tv), default=str(default)))
        expect("--default: a cook whose loop.json matches", rep, "parity:", "PASS")
        odd = named_as(_make_zip({**clean, MANIFEST: json.dumps({"manifestVersion": 1, "entry": "index.html",
                                                              "cameras": [{"id": "tv-only"}]})}), "test-loop-tvos-20260101-%s.zip")
        code, rep = run(A(str(odd), default=str(default)))
        expect("--default: a cook whose loop.json differs (cameras)", rep, "parity:", "FAIL")
        slow = named_as(_make_zip({**clean, MANIFEST: json.dumps({"manifestVersion": 1, "entry": "index.html",
                                                               "readyBudgetSeconds": 40})}), "test-loop-tvos-20260101-%s.zip")
        code, rep = run(A(str(slow), default=str(default)))
        expect("--default: only readyBudgetSeconds differs — the catalog keeps the default's", rep, "parity:", "WARN")
        # RSCALE1 (2026-09-25): render.scale is per cook — the intake's PER_COOK_MANIFEST_FIELDS carries it. Pirate
        # Beach's TV cook was refused here while the intake would have accepted it (session 049-007).
        scaled = named_as(_make_zip({**clean, MANIFEST: json.dumps({"manifestVersion": 1, "entry": "index.html",
                                                                 "render": {"scale": 0.5}})}), "test-loop-tvos-20260101-%s.zip")
        code, rep = run(A(str(scaled), default=str(default)))
        expect("--default: only render differs — a per-cook field (RSCALE1)", rep, "parity:", "PASS")
        big = _make_zip({**clean, "blob.bin": os.urandom(26 * 1024 * 1024)})   # random: zip cannot shrink it
        p = named(big)
        code, rep = run(A(str(p), bundled=True))
        expect("bundled Loop over 25 MB", rep, "size: bundled", "FAIL")

    print("\nSELF-TEST %s" % ("PASS" if not failures else "FAIL: " + ", ".join(failures)))
    return 0 if not failures else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("payload", nargs="?", help="the web-archive zip")
    ap.add_argument("--id", help="the catalog id the release ships under (checked against the name and the entry)")
    ap.add_argument("--lane", choices=("dev", "release"), default="dev", help="dev: sums/masters warn; release: they fail")
    ap.add_argument("--version", help="X.Y.Z — must equal catalog-entry.md version.content")
    ap.add_argument("--catalog-assets", help="the repo's catalog-assets/ directory")
    ap.add_argument("--sums", help="SHA256SUMS.txt (default: beside the payload)")
    ap.add_argument("--docs", help="a checkout of collectivus-loops-docs — pulled, then diffed against your last run")
    ap.add_argument("--offline", action="store_true", help="do not git pull the docs")
    ap.add_argument("--stamp-dir", help="where .loop-preflight-docs-stamp lives (default: beside catalog-assets, else the payload)")
    ap.add_argument("--budget-mb", type=float, default=TEXTURE_BUDGET_MB, help="resident texture budget (default %.0f)" % TEXTURE_BUDGET_MB)
    ap.add_argument("--bundled", action="store_true", help="this Loop ships inside the app binary (25 MB)")
    ap.add_argument("--default", help="COOK2: for a platform cook (-tvos- …), the release's default zip — loop.json parity")
    ap.add_argument("--top", type=int, default=15, help="how many texture rows to print")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--self-test", action="store_true", help="prove every check can fail")
    ap.add_argument("--check-copy", action="store_true", help="only compare this file with loops-docs' copy")
    args = ap.parse_args(argv)
    if args.self_test:
        return self_test()
    if args.check_copy:
        if not args.docs:
            ap.error("--check-copy needs --docs")
        rep = Report()
        check_copy(rep, args.docs)
        print_report(rep, False, pathlib.Path(__file__), "copy")
        return 0 if rep.rows[0].status == "PASS" else 1
    if not args.payload:
        ap.error("a payload is required")
    code, rep = run(args)
    print_report(rep, args.json, pathlib.Path(args.payload), args.lane)
    return code


if __name__ == "__main__":
    sys.exit(main())
