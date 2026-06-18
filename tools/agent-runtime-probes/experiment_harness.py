#!/usr/bin/env python3
"""experiment_harness — Phase 3 bead 3.0: the prediction-before-result interlock.

Every metered CAPE experiment (E2-E5) must register its SUCCESS CRITERION before it is run, and a result
can be written ONLY against a pre-existing, immutable, untampered prediction. This is the anti-HARKing /
anti-fabrication guard: you cannot move the goalposts after seeing the data, and you cannot fabricate a
result with no prior hypothesis.

Two operations:
  - register_prediction(prediction, store_dir): persists {experiment_id, hypothesis, success_criterion}
    to `store_dir/<experiment_id>.prediction.json`, IMMUTABLY — re-registering an identical prediction is
    idempotent; re-registering a DIFFERENT one for the same id is refused (`prediction_immutable`). The
    stored record carries a domain-separated prediction_hash over its content.
  - write_result(experiment_id, observed, store_dir): loads the prediction (fail-closed `no_prediction`
    if none was registered), re-derives its hash to detect a post-hoc edit (`prediction_tampered`), then
    DETERMINISTICALLY evaluates the pre-declared success_criterion against the observed metric.

The harness separates experiment INTEGRITY from the SCIENTIFIC OUTCOME:
  - overall_verdict = PASS iff the interlock held (prediction pre-existed, untampered, criterion evaluable);
  - hypothesis_verdict = confirmed | refuted | inconclusive — a REFUTED hypothesis with PASS integrity is a
    perfectly valid experiment, not a failure.

success_criterion = {metric: str, comparator in (lte, gte, lt, gt, eq), threshold: number}. proof_class
`deterministic_verifier`; fail-closed; metadata-only (ids, hashes, enums, the single observed metric value).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from hashlib import sha256
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402  (reuse canonical_bytes for the prediction hash)

SCHEMA = "agent-runtime-experiment-harness"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

PRED_DOMAIN_TAG = b"CAPE-EXP-PRED-v0\x00"
COMPARATORS = ("lte", "gte", "lt", "gt", "eq")
_EXPERIMENT_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")  # filesystem-safe; refuses path traversal


class PredictionError(ValueError):
    """Typed, fail-closed error — never register/evaluate on a malformed or mutated prediction."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _validate_prediction(prediction) -> dict:
    """Validate + normalize a prediction to its canonical, hashable body. Raises malformed_prediction."""
    if not isinstance(prediction, dict):
        raise PredictionError("malformed_prediction", "prediction must be a dict")
    eid = prediction.get("experiment_id")
    hypothesis = prediction.get("hypothesis")
    crit = prediction.get("success_criterion")
    if not isinstance(eid, str) or not _EXPERIMENT_ID_RE.match(eid):
        raise PredictionError("malformed_prediction", f"experiment_id must match {_EXPERIMENT_ID_RE.pattern}")
    if not isinstance(hypothesis, str) or not hypothesis:
        raise PredictionError("malformed_prediction", "hypothesis must be a non-empty string")
    if not isinstance(crit, dict):
        raise PredictionError("malformed_prediction", "success_criterion must be a dict")
    metric, comparator, threshold = crit.get("metric"), crit.get("comparator"), crit.get("threshold")
    if not isinstance(metric, str) or not metric:
        raise PredictionError("malformed_prediction", "success_criterion.metric must be a non-empty string")
    if comparator not in COMPARATORS:
        raise PredictionError("malformed_prediction", f"comparator must be one of {COMPARATORS}")
    if not _is_number(threshold):
        raise PredictionError("malformed_prediction", "success_criterion.threshold must be a number")
    return {
        "experiment_id": eid,
        "hypothesis": hypothesis,
        "success_criterion": {"metric": metric, "comparator": comparator, "threshold": float(threshold)},
    }


def _prediction_hash(body: dict) -> str:
    return sha256(PRED_DOMAIN_TAG + mpc.canonical_bytes(body)).hexdigest()


def _record(body: dict) -> dict:
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "experiment_id": body["experiment_id"],
        "hypothesis": body["hypothesis"],
        "success_criterion": body["success_criterion"],
        "prediction_hash": _prediction_hash(body),
        "registered": True,
    }


def _pred_path(experiment_id: str, store_dir) -> Path:
    if not _EXPERIMENT_ID_RE.match(experiment_id):
        raise PredictionError("malformed_prediction", "experiment_id is not filesystem-safe")
    return Path(store_dir) / f"{experiment_id}.prediction.json"


def register_prediction(prediction, store_dir) -> dict:
    """Register an immutable prediction. Idempotent for an identical prediction; refuses a different one
    for the same experiment_id (`prediction_immutable`)."""
    body = _validate_prediction(prediction)
    record = _record(body)
    store = Path(store_dir)
    try:
        store.mkdir(parents=True, exist_ok=True)
        os.chmod(store, 0o700)
    except OSError as exc:
        raise PredictionError("store_unwritable", f"prediction store dir unwritable: {type(exc).__name__}")
    path = _pred_path(body["experiment_id"], store)
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if existing.get("prediction_hash") == record["prediction_hash"]:
            return existing  # idempotent re-registration of the identical prediction
        raise PredictionError("prediction_immutable",
                              f"a different prediction is already registered for {body['experiment_id']}")
    fd, tmp = tempfile.mkstemp(prefix=".pred-", suffix=".json", dir=str(store))
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(record, fh)
    os.replace(tmp, path)
    return record


def _evaluate(comparator: str, observed: float, threshold: float) -> bool:
    return {
        "lte": observed <= threshold, "gte": observed >= threshold,
        "lt": observed < threshold, "gt": observed > threshold, "eq": observed == threshold,
    }[comparator]


def _result_report(*, experiment_id, prediction_hash, hypothesis, criterion, observed_value,
                   hypothesis_verdict, overall, error_type=None) -> dict:
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "experiment_id": experiment_id,
        "prediction_hash": prediction_hash,
        "hypothesis": hypothesis,
        "success_criterion": criterion,
        "observed_value": observed_value,
        "hypothesis_verdict": hypothesis_verdict,
        "overall_verdict": overall,
        "error_type": error_type,
    })


def write_result(experiment_id: str, observed, store_dir) -> dict:
    """Evaluate observed metrics against the pre-registered, immutable success_criterion. Fail-closed:
    `no_prediction` if none was registered; `prediction_tampered` if the stored prediction was edited."""
    path = _pred_path(experiment_id, store_dir)
    if not path.exists():
        return _result_report(experiment_id=experiment_id, prediction_hash=None, hypothesis=None,
                              criterion=None, observed_value=None, hypothesis_verdict="inconclusive",
                              overall="FAIL", error_type="no_prediction")
    stored = json.loads(path.read_text(encoding="utf-8"))
    body = {"experiment_id": stored.get("experiment_id"), "hypothesis": stored.get("hypothesis"),
            "success_criterion": stored.get("success_criterion")}
    # re-derive the hash over the stored content; a post-hoc edit to the criterion will not match.
    if _prediction_hash(body) != stored.get("prediction_hash"):
        return _result_report(experiment_id=experiment_id, prediction_hash=stored.get("prediction_hash"),
                              hypothesis=stored.get("hypothesis"), criterion=stored.get("success_criterion"),
                              observed_value=None, hypothesis_verdict="inconclusive",
                              overall="FAIL", error_type="prediction_tampered")
    crit = body["success_criterion"]
    obs_value = observed.get(crit["metric"]) if isinstance(observed, dict) else None
    if not _is_number(obs_value):
        verdict = "inconclusive"  # the experiment did not measure the predicted metric
    else:
        verdict = "confirmed" if _evaluate(crit["comparator"], float(obs_value), crit["threshold"]) else "refuted"
    return _result_report(experiment_id=experiment_id, prediction_hash=stored.get("prediction_hash"),
                          hypothesis=body["hypothesis"], criterion=crit,
                          observed_value=obs_value if _is_number(obs_value) else None,
                          hypothesis_verdict=verdict, overall="PASS")


def _load(path: Path, missing: str, malformed: str):
    if not path.exists():
        return None, (missing, f"{path} not found")
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError as exc:
        return None, (malformed, f"JSONDecodeError: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Experiment prediction-before-result interlock (anti-HARKing).")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--register", metavar="PRED_JSON", help="register an immutable prediction file")
    g.add_argument("--result", metavar="OBSERVED_JSON", help="write a result against a registered prediction")
    ap.add_argument("--experiment-id", help="experiment id (required with --result)")
    ap.add_argument("--store-dir", required=True, help="caller-controlled prediction store directory")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    try:
        if args.register:
            pred, err = _load(Path(args.register), "missing_prediction_file", "malformed_prediction_json")
            if err:
                return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1]}, 1)
            return _emit(register_prediction(pred, args.store_dir), 0)
        if not args.experiment_id:
            return _emit({"schema": SCHEMA, "error_type": "missing_experiment_id",
                          "_error": "--experiment-id required with --result"}, 1)
        observed, err = _load(Path(args.result), "missing_observed_file", "malformed_observed_json")
        if err:
            return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1]}, 1)
        report = write_result(args.experiment_id, observed, args.store_dir)
        return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)
    except PredictionError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message}, 1)


if __name__ == "__main__":
    raise SystemExit(main())
