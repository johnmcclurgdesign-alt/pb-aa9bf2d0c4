#!/usr/bin/env python3
"""check-board-rows.py — every open card on board 2 has a home, an id and a Milestone.

PL1 (2026-09-24, Josh): adopt the app program's board sweep ([006/PREP7], its
`scripts/check-board-rows.py`) so an issue added to the board is picked up and queued, not found a
sprint later. PL1 itself found two app-filed issues (#136, #137, 2026-09-13) that sat off the board
and rowless for eleven days. ORCHESTRATION §7.3 says the first session that sees such a card triages
it; this script does the seeing, and every PL row runs it (ORCHESTRATION §6).

    python3 tools/check-board-rows.py              # the live board; exit 1 if anything needs triage
    python3 tools/check-board-rows.py --selftest   # every failure path, offline

A card is MATCHED when a home names it: `#<n>` or `issues/<n>`, the row id of a `[NNN/ROW]` title, or
the item id of a `[FAM-nnn]` title, each as a whole word. The homes: PLAN.md and PROMPTS.md of every
sprint folder whose PLAN status is ACTIVE or later, plus `backlog dripping-pickle/BACKLOG.md` and
every `*-draft.md` beside it.

Reports, and exits 1 if any is non-empty:
  UNMATCHED     open cards with no home — the PL session asks Josh, one each
  NO-ID         open cards whose title carries neither `[NNN/ROW]` nor `[FAM-nnn]` (ORCHESTRATION §7.3)
  NO-MILESTONE  open cards with no GitHub milestone (ORCHESTRATION §7.3)
  OFF-BOARD     open repo issues that are not on board 2 at all

Exit 0: all clean. 1: findings. 2: could not read the board or the homes — never a pass.
⚠ Both `gh` reads pin JSON and `--limit 500` (the project listing defaults to 30 and drops the rest).
⚠ It reports; it never edits a card or writes a home. Triage is a person's decision.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

OWNER, PROJECT = "CollectivusWorlds", "2"
REPO = "CollectivusWorlds/loop-dripping-pickle-webgl-v1"
PLAN_ROOT = os.environ.get("DP_PLAN_ROOT") or os.path.expanduser(
    "~/Library/Mobile Documents/com~apple~CloudDocs/_ Josh's Brain Organization/Projects/"
    "collectivus/collectivus loops/03 client loops/dripping-pickle/dripping pickle - loop")
ROW_ID = re.compile(r"^\[\d{3}/([A-Za-z0-9-]+)\]")
ITEM_ID = re.compile(r"^\[([A-Z]{2,}(?:-[A-Z0-9]+)+)\]")  # ENV-024, EVT-B01, APP-INT
SPRINT_DIR = re.compile(r"^(\d{3}) dripping-pickle$")


def die(msg):
    print(f"check-board-rows: {msg}", file=sys.stderr)
    sys.exit(2)


def run_json(cmd):
    try:
        return json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)
    except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError) as exc:
        die(f"could not read {' '.join(cmd[:3])}: {exc}")


def read_board():
    data = run_json(["gh", "project", "item-list", PROJECT, "--owner", OWNER, "--limit", "500",
                     "--format", "json"])
    return {i["content"]["number"] for i in data.get("items", []) if i.get("content", {}).get("number")}


def read_open_issues():
    return run_json(["gh", "issue", "list", "-R", REPO, "--state", "open", "--limit", "500",
                     "--json", "number,title,milestone"])


def home_files(root):
    """PLAN + PROMPTS of the ACTIVE sprint and every later one, BACKLOG.md and the drafts."""
    try:
        names = sorted(os.listdir(root))
    except OSError as exc:
        die(f"plan root unreadable: {exc}")
    sprints = [n for n in names if SPRINT_DIR.match(n)]
    active = None
    for n in sprints:
        try:
            head = open(os.path.join(root, n, "PLAN.md"), encoding="utf-8").read(2000)
        except OSError:
            continue
        if re.search(r"^status:\s*ACTIVE", head, re.M):
            active = n
            break
    if active is None:
        die("no sprint folder has a PLAN.md with `status: ACTIVE`")
    files = []
    for n in sprints[sprints.index(active):]:
        files += [os.path.join(root, n, f) for f in ("PLAN.md", "PROMPTS.md")]
    backlog = os.path.join(root, "backlog dripping-pickle")
    files.append(os.path.join(backlog, "BACKLOG.md"))
    files += sorted(os.path.join(backlog, f) for f in os.listdir(backlog) if f.endswith("-draft.md"))
    return active, files


def read_homes(files):
    text = []
    for f in files:
        if not os.path.exists(f):
            continue  # a later sprint may have a PLAN and no PROMPTS yet
        try:
            text.append(open(f, encoding="utf-8").read())
        except OSError as exc:
            die(f"home unreadable: {f}: {exc}")
    if not text:
        die("no home file could be read")
    return "\n".join(text)


def ids_of(title):
    return [m.group(1) for m in (ROW_ID.match(title), ITEM_ID.match(title)) if m]


def is_matched(issue, homes):
    n = issue["number"]
    if re.search(rf"(?<![\w/])#{n}(?!\d)|issues/{n}(?!\d)", homes):
        return True
    return any(re.search(rf"(?<![\w-]){re.escape(i)}(?![\w-])", homes) for i in ids_of(issue["title"]))


def classify(issues, on_board, homes):
    board = [i for i in issues if i["number"] in on_board]
    return {
        "UNMATCHED": [i for i in board if not is_matched(i, homes)],
        "NO-ID": [i for i in board if not ids_of(i["title"])],
        "NO-MILESTONE": [i for i in board if not i.get("milestone")],
        "OFF-BOARD": [i for i in issues if i["number"] not in on_board],
    }


def report(found, total, active):
    print(f"board 2: {total} open issue(s); homes from sprint {active} on, BACKLOG.md and the drafts")
    bad = False
    for kind, items in found.items():
        print(f"  {kind:<13} {len(items)}")
        for i in items:
            print(f"    #{i['number']}  {i['title'][:100]}")
        bad = bad or bool(items)
    print("BOARD NEEDS TRIAGE" if bad else "BOARD OK — every open card has a home, an id and a milestone")
    return 1 if bad else 0


def main_live():
    active, files = home_files(PLAN_ROOT)
    issues = read_open_issues()
    return report(classify(issues, read_board(), read_homes(files)), len(issues), active)


# ── self-test: each failure path fires, and the near misses do not ─────────────────────────────────

def selftest():
    fails = []

    def case(name, got, want):
        print(f"  {'ok  ' if got == want else 'FAIL'}  {name}")
        if got != want:
            fails.append(name)

    homes = "| 2 | **TV1 — …** | [#131](…/issues/131)\nsee #1490 and ENV-024\n## ART2 — x"
    case("row id in title", is_matched({"number": 1, "title": "[002/ART2] x"}, homes), True)
    case("number as #N / issues/N", is_matched({"number": 131, "title": "no id"}, homes), True)
    case("#149 must not match #1490", is_matched({"number": 149, "title": "x"}, homes), False)
    case("item id whole-word", is_matched({"number": 7, "title": "[ENV-024] x"}, homes), True)
    case("TV1 must not match TV", is_matched({"number": 8, "title": "[002/TV] x"}, homes), False)
    case("ENV-02 must not match ENV-024", is_matched({"number": 9, "title": "[ENV-02] x"}, homes), False)
    ms = {"title": "Beta"}
    issues = [{"number": 131, "title": "[002/TV1] a", "milestone": ms},
              {"number": 200, "title": "[ENV-099] rowless", "milestone": ms},
              {"number": 201, "title": "no id at all #131", "milestone": ms},
              {"number": 202, "title": "[PLT-040] no milestone", "milestone": None},
              {"number": 203, "title": "[from Collectivus] off the board", "milestone": None}]
    got = classify(issues, {131, 200, 201, 202}, homes + "\nPLT-040")
    case("UNMATCHED names the rowless card", [i["number"] for i in got["UNMATCHED"]], [200, 201])
    case("NO-ID names the card without an id", [i["number"] for i in got["NO-ID"]], [201])
    case("NO-MILESTONE", [i["number"] for i in got["NO-MILESTONE"]], [202])
    case("OFF-BOARD", [i["number"] for i in got["OFF-BOARD"]], [203])
    with tempfile.TemporaryDirectory() as tmp:
        for n, status in (("001", "CLOSED 2026-09-24"), ("002", "ACTIVE 2026-09-23 → 2026-10-06")):
            os.makedirs(os.path.join(tmp, f"{n} dripping-pickle"))
            open(os.path.join(tmp, f"{n} dripping-pickle", "PLAN.md"), "w").write(f"---\nstatus: {status}\n---\n")
        os.makedirs(os.path.join(tmp, "backlog dripping-pickle"))
        open(os.path.join(tmp, "backlog dripping-pickle", "BACKLOG.md"), "w").write("#1")
        open(os.path.join(tmp, "backlog dripping-pickle", "003-draft.md"), "w").write("#2")
        active, files = home_files(tmp)
        case("active sprint is the ACTIVE one, not the first", active, "002 dripping-pickle")
        case("a closed sprint is not a home", any("001 dripping-pickle" in f for f in files), False)
        case("drafts are homes", any(f.endswith("003-draft.md") for f in files), True)
        try:
            read_homes([os.path.join(tmp, "nothing.md")])
            case("no readable home exits 2", "passed", "exit 2")
        except SystemExit as e:
            case("no readable home exits 2", e.code, 2)
    print("SELFTEST PASS" if not fails else f"SELFTEST FAIL — {len(fails)} case(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv[1:] else main_live())
