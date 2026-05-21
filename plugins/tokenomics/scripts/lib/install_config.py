import dataclasses
import json
import pathlib
import re
from typing import Any, Mapping


class InstallConfigError(ValueError):
    pass


@dataclasses.dataclass(frozen=True)
class InstallConfig:
    bot: str
    instance_path: pathlib.Path
    ceiling: int
    cooldown_seconds: int
    whatsoup_repo: pathlib.Path
    plugin_root: pathlib.Path


_BOT_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_REQUIRED_KEYS = ("bot", "instance_path", "ceiling", "cooldown_seconds", "whatsoup_repo", "plugin_root")


def _validate_payload(payload: Mapping[str, Any]) -> InstallConfig:
    missing = [k for k in _REQUIRED_KEYS if k not in payload]
    if missing:
        raise InstallConfigError(f"missing required keys: {missing}")

    bot = payload["bot"]
    if not isinstance(bot, str) or not _BOT_RE.match(bot):
        raise InstallConfigError(
            f"invalid bot name: {bot!r}; must match {_BOT_RE.pattern}"
        )

    try:
        return InstallConfig(
            bot=bot,
            instance_path=pathlib.Path(payload["instance_path"]).resolve(),
            ceiling=int(payload["ceiling"]),
            cooldown_seconds=int(payload["cooldown_seconds"]),
            whatsoup_repo=pathlib.Path(payload["whatsoup_repo"]).resolve(),
            plugin_root=pathlib.Path(payload["plugin_root"]).resolve(),
        )
    except (TypeError, ValueError) as err:
        raise InstallConfigError(f"invalid config field: {err}") from err


def load_install_config(path: pathlib.Path) -> InstallConfig:
    payload = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise InstallConfigError("config root must be a JSON object")
    return _validate_payload(payload)
