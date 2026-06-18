#!/usr/bin/env python3
"""No-install line-coverage measurer (stdlib only) for agent-runtime-probes.

Lives under tools/ so corpus_guard's top-level *.py glob does not treat it as a probe.
Runs every tests/test_*.py under a frame-filtered sys.settrace and reports
executed/executable line ratio per probe (statement-coverage approximation via
dis.findlinestarts). Honors the no-install guardrail — no coverage.py needed.

Usage: python3 tools/coverage_check.py [probe_name_substring ...]
Exit: 0 when tests run cleanly; 2 if any measured test raises or exits nonzero.
Prints per-probe %, overall %, count under 98%, and typed test failures when present.
"""
import sys, os, runpy, glob, dis, time

PROBE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
EXCLUDE = {"corpus_guard.py", "probelib.py"}
TOOL_EXCLUDE = {"coverage_check.py"}
FILTERS = sys.argv[1:]

def candidate_sources(filters):
    sources = [p for p in glob.glob(PROBE_DIR + "/*.py") if os.path.basename(p) not in EXCLUDE]
    if filters:
        sources.extend(p for p in glob.glob(TOOLS_DIR + "/*.py") if os.path.basename(p) not in TOOL_EXCLUDE)
        sources = [p for p in sources if any(f in os.path.basename(p) for f in filters)]
    return sources


probes = candidate_sources(FILTERS)
probe_real = {os.path.realpath(p): p for p in probes}
_cls = {}
executed = {rp: set() for rp in probe_real}


def gtrace(frame, event, arg):
    fn = frame.f_code.co_filename
    rp = _cls.get(fn)
    if rp is None:
        real = os.path.realpath(fn)
        rp = _cls[fn] = real if real in probe_real else False
    return ltrace if rp else None


def ltrace(frame, event, arg):
    if event == 'line':
        rp = _cls.get(frame.f_code.co_filename)
        if rp:
            executed[rp].add(frame.f_lineno)
    return ltrace


def executable_lines(path):
    src_lines = open(path).read().splitlines()
    code = compile("\n".join(src_lines), path, 'exec')
    lines, stack = set(), [code]
    while stack:
        co = stack.pop()
        for _, ln in dis.findlinestarts(co):
            if ln is not None:
                lines.add(ln)
        for c in co.co_consts:
            if hasattr(c, 'co_code'):
                stack.append(c)
    # Exclude un-unit-testable / explicitly-excluded lines (coverage.py convention):
    # the trailing `if __name__ == "__main__":` entrypoint block and any `# pragma: no cover`.
    main_ln = next((i for i, l in enumerate(src_lines, 1)
                    if l.strip().startswith('if __name__') and '__main__' in l), None)
    excluded = {l for l in lines if l <= 0}  # synthetic/module-epilogue bytecode lines
    for i, l in enumerate(src_lines, 1):
        if main_ln and i >= main_ln:
            excluded.add(i)
        elif '# pragma: no cover' in l:
            excluded.add(i)
    return lines - excluded


def record_coverage_run(rc, duration_ms, coverage_pct):
    sys.path.insert(0, TOOLS_DIR)
    try:
        import run_ledger
    except Exception:  # coverage still runs if telemetry cannot import
        run_ledger = None
    if run_ledger is None:
        print('RUN_LEDGER_DEGRADED {"_error":"run_ledger_import_failed","status":"degraded"}', file=sys.stderr)
        return
    status = run_ledger.record({
        "kind": "coverage",
        "name": "coverage_check.py",
        "duration_ms": duration_ms,
        "exit": rc,
        "schema_version": None,
        "leak_hits": 0,
        "coverage_pct": coverage_pct,
    })
    if status.get("status") not in {"ok", "disabled"}:
        marker = {"status": "degraded", "_error": status.get("_error") or status.get("error_type") or "ledger_write_failed"}
        print(f"RUN_LEDGER_DEGRADED {run_ledger.canonical_json(marker)}", file=sys.stderr)


def main():
    started = time.monotonic()
    sys.path.insert(0, PROBE_DIR)
    test_failures = []
    for t in sorted(glob.glob(PROBE_DIR + "/tests/test_*.py")):
        sys.settrace(gtrace)
        try:
            runpy.run_path(t, run_name="__main__")
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
            if code:
                test_failures.append({"test": os.path.basename(t), "error_type": "SystemExit", "exit_code": code})
        except Exception as exc:
            test_failures.append({"test": os.path.basename(t), "error_type": type(exc).__name__, "exit_code": None})
        finally:
            sys.settrace(None)
    total_ex = total_cov = 0
    rows = []
    for rp, path in probe_real.items():
        ex = executable_lines(path)
        cov = executed[rp] & ex
        total_ex += len(ex); total_cov += len(cov)
        pct = 100.0 * len(cov) / len(ex) if ex else 100.0
        rows.append((pct, len(cov), len(ex), os.path.basename(path)))
    rows.sort()
    print("  %cov   cov/exec  probe")
    for pct, c, e, name in rows:
        flag = "  <-- under 98%" if pct < 98 else ""
        print(f"{pct:6.1f}  {c:4d}/{e:<4d} {name}{flag}")
    coverage_pct = None
    if total_ex:
        coverage_pct = 100.0 * total_cov / total_ex
        print(f"\nOVERALL: {total_cov}/{total_ex} = {coverage_pct:.2f}%")
        print(f"probes under 98%: {sum(1 for r in rows if r[0] < 98)}/{len(rows)}")
    rc = 0
    if test_failures:
        print(f"\nTEST_FAILURES: {len(test_failures)}")
        for item in test_failures:
            print(f"{item['test']}: {item['error_type']} exit={item['exit_code']}")
        rc = 2
    record_coverage_run(rc, int((time.monotonic() - started) * 1000), coverage_pct)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
