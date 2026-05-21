import dataclasses
import shutil
from typing import Callable, Optional, Sequence


REQUIRED_TOOLS: Sequence[str] = ("rg",)
RECOMMENDED_TOOLS: Sequence[str] = ("fd", "rga", "ast-grep")


@dataclasses.dataclass(frozen=True)
class ToolchainReport:
    required: dict[str, Optional[str]]
    missing_required: list[str]
    missing_recommended: list[str]


class MissingToolchainError(RuntimeError):
    def __init__(self, missing: Sequence[str]) -> None:
        self.missing = list(missing)
        super().__init__(
            f"required search tools missing from PATH: {', '.join(self.missing)}"
        )


def check_toolchain(
    *,
    which_fn: Callable[[str], Optional[str]] = shutil.which,
) -> ToolchainReport:
    required = {name: which_fn(name) for name in REQUIRED_TOOLS}
    missing_required = [name for name, path in required.items() if path is None]
    missing_recommended = [name for name in RECOMMENDED_TOOLS if which_fn(name) is None]
    return ToolchainReport(
        required=required,
        missing_required=missing_required,
        missing_recommended=missing_recommended,
    )


def require_toolchain(report: ToolchainReport) -> None:
    if report.missing_required:
        raise MissingToolchainError(report.missing_required)
    return None


__all__ = [
    "REQUIRED_TOOLS",
    "RECOMMENDED_TOOLS",
    "MissingToolchainError",
    "ToolchainReport",
    "check_toolchain",
    "require_toolchain",
]
