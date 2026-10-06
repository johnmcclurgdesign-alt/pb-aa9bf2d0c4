#!/usr/bin/env python3
"""check-plan-size.py — the active sprint's plan files stay small enough to read at every boot.

PL1 (2026-09-24, Josh): adopt the app program's [007/TOK1] rule. Sprint 001 closed with PROMPTS.md at
76 KB, PLAN.md at 45 KB (the outcome ledger alone ~30 KB, one line reaching 4.9 KB) and JOSH-LIST.md
at 25 KB — two thirds of it ticked items — and every session reads all three at boot
(ORCHESTRATION §2). Nothing here deletes: every rule is met by MOVING text to a file no session reads
at boot.

  1. CLOSED  a `## ` block whose heading carries `✅ DONE` or `⛔ RETIRED` may not sit in PROMPTS.md;
             it moves, whole, to PROMPTS-closed.md. PROMPTS.md must carry an `# Open` heading.
  2. LEDGER  a PLAN.md §5 outcome-ledger line is at most 600 characters: the verdict and a pointer
             to the handoff. The findings live in the handoff.
  3. TICKED  JOSH-LIST.md holds open items only; a ticked `- [x]` moves to JOSH-LIST-done.md.
  4. BUDGET  PLAN 80 KB, PROMPTS 150 KB, JOSH-LIST 30 KB (KB = 1024 B). WARN at 80 %, FAIL at 100 %.

Scope: the ACTIVE sprint folder (the one whose PLAN.md says `status: ACTIVE`), or --sprint-dir.

    python3 tools/check-plan-size.py
    python3 tools/check-plan-size.py --sprint-dir "<folder>"
    python3 tools/check-plan-size.py --selftest

Exit 0 clean (WARNs allowed) · 1 a FAIL · 2 UNDETERMINED (a required file unreadable — not a pass).
"""
import os
import re
import sys
import tempfile

KB = 1024
BUDGETS = {"PLAN.md": 80 * KB, "PROMPTS.md": 150 * KB, "JOSH-LIST.md": 30 * KB}
WARN_AT, LEDGER_MAX = 0.80, 600
CLOSED_MARK = re.compile(r"✅\s*DONE|⛔\s*RETIRED")
TICKED = re.compile(r"^\s*(?:- |\d+\. )\[[xX]\]")
PLAN_ROOT = os.environ.get("DP_PLAN_ROOT") or os.path.expanduser(
    "~/Library/Mobile Documents/com~apple~CloudDocs/_ Josh's Brain Organization/Projects/"
    "collectivus/collectivus loops/03 client loops/dripping-pickle/dripping pickle - loop")


def undetermined(msg):
    print(f"check-plan-size: UNDETERMINED — {msg}", file=sys.stderr)
    sys.exit(2)


def read(path):
    try:
        return open(path, encoding="utf-8").read()
    except OSError as exc:
        undetermined(f"{path}: {exc}")


def active_sprint(root):
    for n in sorted(os.listdir(root)):
        if re.match(r"^\d{3} dripping-pickle$", n) and os.path.exists(os.path.join(root, n, "PLAN.md")):
            if re.search(r"^status:\s*ACTIVE", read(os.path.join(root, n, "PLAN.md"))[:2000], re.M):
                return os.path.join(root, n)
    undetermined("no sprint folder has a PLAN.md with `status: ACTIVE`")


def rule_closed(prompts):
    if not re.search(r"^# Open\s*$", prompts, re.M):
        return ["PROMPTS.md has no `# Open` heading"]
    open_part = re.split(r"^# Closed\s*$", prompts, maxsplit=1, flags=re.M)[0]
    return [f"closed block still in PROMPTS.md: {h[:90]}"
            for h in re.findall(r"^## .*$", open_part, re.M) if CLOSED_MARK.search(h)]


def rule_ledger(plan):
    m = re.search(r"^## §5\..*?$(.*?)(?=^## |\Z)", plan, re.M | re.S)
    if not m:
        return ["PLAN.md has no `## §5.` outcome ledger"]
    rows = [l for l in m.group(1).splitlines()
            if l.startswith("|") and not re.match(r"^\|\s*(Row|-+)\s*\|", l)]
    return [f"ledger line {len(l)} chars > {LEDGER_MAX}: {l[:60]}…" for l in rows if len(l) > LEDGER_MAX]


def rule_ticked(josh):
    return [f"ticked item in JOSH-LIST.md: {l.strip()[:90]}" for l in josh.splitlines() if TICKED.match(l)]


def rule_budget(sizes):
    fails, warns = [], []
    for name, size in sizes.items():
        cap = BUDGETS[name]
        if size >= cap:
            fails.append(f"{name} {size / KB:.1f} KB ≥ budget {cap // KB} KB")
        elif size >= cap * WARN_AT:
            warns.append(f"{name} {size / KB:.1f} KB is ≥ 80 % of {cap // KB} KB")
    return fails, warns


def check(sprint_dir):
    files = {n: read(os.path.join(sprint_dir, n)) for n in BUDGETS}
    fails = rule_closed(files["PROMPTS.md"]) + rule_ledger(files["PLAN.md"]) + rule_ticked(files["JOSH-LIST.md"])
    bfails, warns = rule_budget({n: len(t.encode("utf-8")) for n, t in files.items()})
    return fails + bfails, warns, {n: len(t.encode("utf-8")) for n, t in files.items()}


def main(sprint_dir):
    fails, warns, sizes = check(sprint_dir)
    print(f"{os.path.basename(sprint_dir)}: " + " · ".join(f"{n} {s / KB:.1f} KB" for n, s in sizes.items()))
    for w in warns:
        print(f"  WARN  {w}")
    for f in fails:
        print(f"  FAIL  {f}")
    print("PLAN SIZE OK" if not fails else f"PLAN SIZE FAIL — {len(fails)} finding(s); move, never delete")
    return 1 if fails else 0


def selftest():
    bad = []

    def case(name, got, want):
        print(f"  {'ok  ' if got == want else 'FAIL'}  {name}")
        if got != want:
            bad.append(name)

    good_prompts = "# Sprint\n\n# Open\n\n## ART2 — x · **Opus 5.5** · high · ATTENDED\n\n# Closed\n\n## TV0 — y · (✅ DONE 20260925)\n"
    case("clean PROMPTS passes (a done block under # Closed is allowed)", rule_closed(good_prompts), [])
    case("done block under # Open fails", len(rule_closed(good_prompts.replace("## ART2 — x", "## ART2 — x · (✅ DONE 20260925 — session 001, Opus 5.5)"))), 1)
    case("retired block under # Open fails", len(rule_closed("# Open\n## X — y · (⛔ RETIRED 20260925 — DO NOT RUN)\n")), 1)
    case("missing # Open fails", len(rule_closed("## X — y\n")), 1)
    plan = "## §5. Outcome ledger\n\n| Row | Session | Outcome |\n| --- | --- | --- |\n| A | 1 | short |\n"
    case("short ledger passes", rule_ledger(plan), [])
    case("601-char ledger line fails", len(rule_ledger(plan + "| B | 2 | " + "x" * 600 + " |\n")), 1)
    case("a long line OUTSIDE §5 is not judged", rule_ledger("## §3. Scope\n| " + "y" * 900 + " |\n" + plan), [])
    case("missing §5 fails", len(rule_ledger("## §3. Scope\n")), 1)
    case("open items pass", rule_ticked("- [ ] **A** — x\n"), [])
    case("ticked item fails", len(rule_ticked("- [ ] a\n- [x] **B** — done\n")), 1)
    f, w = rule_budget({"PLAN.md": 70 * KB, "PROMPTS.md": 10, "JOSH-LIST.md": 30 * KB})
    case("80 % warns, 100 % fails", (len(w), len(f)), (1, 1))
    with tempfile.TemporaryDirectory() as tmp:
        try:
            check(tmp)
            case("a missing file is UNDETERMINED (exit 2)", "passed", "exit 2")
        except SystemExit as e:
            case("a missing file is UNDETERMINED (exit 2)", e.code, 2)
    print("SELFTEST PASS" if not bad else f"SELFTEST FAIL — {len(bad)} case(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--selftest" in args:
        sys.exit(selftest())
    if "--sprint-dir" in args:
        sys.exit(main(args[args.index("--sprint-dir") + 1]))
    sys.exit(main(active_sprint(PLAN_ROOT)))
