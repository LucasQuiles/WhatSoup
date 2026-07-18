"""Stable qSesh error registry and typed operational failures."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

type ErrorScope = Literal["candidate", "run", "command", "installation"]

_PHASE_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9._-]{0,63}")
_DETAIL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._, -]{0,254}")


@dataclass(frozen=True, slots=True)
class ErrorSpec:
    code: str
    message_template: str
    scope: ErrorScope
    retryable: bool
    remediation_action: str
    runbook_anchor: str


_ERROR_SPECS = (
    ErrorSpec(
        "QS-E-USAGE",
        "command input failed validation at {phase}",
        "command",
        False,
        "correct the command input",
        "#cli-errors",
    ),
    ErrorSpec(
        "QS-E-CONFIG",
        "qSesh configuration failed validation at {phase}",
        "command",
        False,
        "correct configuration and rerun doctor",
        "#configuration",
    ),
    ErrorSpec(
        "QS-E-CAPABILITY",
        "required runtime capability unavailable at {phase}: {detail}",
        "run",
        False,
        "select a supported runtime",
        "#capabilities",
    ),
    ErrorSpec(
        "QS-E-PATH-CONFINEMENT",
        "qSesh-owned path escaped or crossed a protected root at {phase}",
        "run",
        False,
        "stop and correct the path boundary",
        "#path-confinement",
    ),
    ErrorSpec(
        "QS-E-BOUNDARY",
        "read-only or network boundary violation detected at {phase}",
        "run",
        False,
        "stop and inspect the boundary receipt",
        "#source-boundaries",
    ),
    ErrorSpec(
        "QS-E-SOURCE-READ",
        "session source could not be read at {phase}",
        "candidate",
        True,
        "repair source presence or permissions",
        "#source-read-errors",
    ),
    ErrorSpec(
        "QS-E-SOURCE-VERSION",
        "session source version is unsupported at {phase}",
        "run",
        False,
        "use or review an accepted source version",
        "#source-versions",
    ),
    ErrorSpec(
        "QS-E-SOURCE-SCHEMA",
        "stable session source uses unsupported or malformed schema at {phase}",
        "candidate",
        False,
        "inspect quarantine and update the extractor",
        "#source-schema",
    ),
    ErrorSpec(
        "QS-E-OPENCODE-LIST",
        "OpenCode session discovery failed at {phase}",
        "run",
        True,
        "verify the pure list contract",
        "#opencode-source",
    ),
    ErrorSpec(
        "QS-E-OPENCODE-EXPORT",
        "OpenCode session export failed at {phase}",
        "candidate",
        True,
        "verify the pure export contract",
        "#opencode-source",
    ),
    ErrorSpec(
        "QS-E-TIMEOUT",
        "bounded operation timed out at {phase}",
        "run",
        True,
        "confirm process cleanup and retry",
        "#timeouts",
    ),
    ErrorSpec(
        "QS-E-QID-COLLISION",
        "visible qID maps to a different full identity digest at {phase}",
        "run",
        False,
        "stop and review the identity contract",
        "#qid-collisions",
    ),
    ErrorSpec(
        "QS-E-RESOLVE-AMBIGUOUS",
        "native session identifier matched multiple scoped identities at {phase}",
        "command",
        False,
        "repeat with an explicit harness or host",
        "#resolve",
    ),
    ErrorSpec(
        "QS-E-ARCHIVE",
        "archive publication or verification failed at {phase}",
        "candidate",
        True,
        "repair the data root and inventory residue",
        "#archive-recovery",
    ),
    ErrorSpec(
        "QS-E-ARCHIVE-COLLISION",
        "archive path contains a different verified digest at {phase}",
        "run",
        False,
        "stop and preserve collision evidence",
        "#archive-collisions",
    ),
    ErrorSpec(
        "QS-E-DISTILL",
        "canonical events violated distillation invariants at {phase}",
        "candidate",
        False,
        "inspect the canonical golden contract",
        "#distillation",
    ),
    ErrorSpec(
        "QS-E-SQLITE",
        "qSesh database operation failed at {phase}",
        "run",
        True,
        "run doctor and inspect database state",
        "#database-recovery",
    ),
    ErrorSpec(
        "QS-E-MIGRATION",
        "schema migration failed at {phase}",
        "run",
        False,
        "verify rollback and backup state",
        "#migrations",
    ),
    ErrorSpec(
        "QS-E-COUNT-MISMATCH",
        "ingest terminal-state accounting did not reconcile at {phase}",
        "run",
        False,
        "inspect terminal-state accounting",
        "#ingest-accounting",
    ),
    ErrorSpec(
        "QS-E-TELEMETRY",
        "required operational evidence could not be recorded at {phase}",
        "run",
        True,
        "repair the evidence writer",
        "#telemetry",
    ),
    ErrorSpec(
        "QS-E-INSTALL-CONFLICT",
        "installation target is not owned by qSesh at {phase}",
        "installation",
        False,
        "resolve target ownership",
        "#installation",
    ),
    ErrorSpec(
        "QS-E-ALREADY-RUNNING",
        "scheduled index was not started because another invocation owns "
        "the lock at {phase}",
        "run",
        True,
        "inspect the active run",
        "#scheduled-index",
    ),
    ErrorSpec(
        "QS-E-ROLLBACK",
        "recovery failed after a causal error at {phase}",
        "run",
        False,
        "stop forward work and preserve evidence",
        "#rollback",
    ),
    ErrorSpec(
        "QS-E-INTERNAL",
        "unexpected internal failure at {phase}",
        "run",
        False,
        "inspect the private evidence reference",
        "#internal-errors",
    ),
)

ERROR_REGISTRY: Mapping[str, ErrorSpec] = MappingProxyType(
    {spec.code: spec for spec in _ERROR_SPECS}
)
if len(ERROR_REGISTRY) != len(_ERROR_SPECS):
    raise RuntimeError("duplicate qSesh error code")


class QseshError(RuntimeError):
    """A safe, registry-backed error whose message never embeds source content."""

    def __init__(
        self,
        code: str,
        *,
        phase: str,
        scope: ErrorScope | None = None,
        retryable: bool | None = None,
        detail: str | None = None,
    ) -> None:
        try:
            spec = ERROR_REGISTRY[code]
        except KeyError as error:
            raise ValueError("unregistered qSesh error code") from error
        if not isinstance(phase, str) or _PHASE_PATTERN.fullmatch(phase) is None:
            raise ValueError("phase must be a safe identifier")
        if detail is not None and (
            not isinstance(detail, str) or _DETAIL_PATTERN.fullmatch(detail) is None
        ):
            raise ValueError("detail must contain only safe identifier characters")
        resolved_scope = spec.scope if scope is None else scope
        if resolved_scope not in {"candidate", "run", "command", "installation"}:
            raise ValueError("scope must be a registered error scope")
        resolved_retryable = spec.retryable if retryable is None else retryable
        if not isinstance(resolved_retryable, bool):
            raise TypeError("retryable must be a boolean")
        self.code = code
        self.phase = phase
        self.scope = resolved_scope
        self.retryable = resolved_retryable
        self.detail = detail
        super().__init__(
            spec.message_template.format(
                phase=phase,
                detail=phase if detail is None else detail,
            )
        )
