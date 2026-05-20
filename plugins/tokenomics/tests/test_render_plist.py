import plistlib
import pathlib
import subprocess
import sys


PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT_PATH = PLUGIN_ROOT / "scripts" / "render-plist.py"
BOT = "target-bot"
HOME = "/tmp/tokenomics-target-home"
INSTANCE_PATH = "/tmp/tokenomics-target-home/instances/target-bot"
WHATSOUP_REPO = "/tmp/tokenomics-target-repo"


def render_args(plugin_root, out_path):
    return [
        sys.executable,
        str(SCRIPT_PATH),
        "--bot",
        BOT,
        "--plugin-root",
        str(plugin_root),
        "--home",
        HOME,
        "--instance-path",
        INSTANCE_PATH,
        "--ceiling",
        "103000000",
        "--cooldown",
        "1800",
        "--whatsoup-repo",
        WHATSOUP_REPO,
        "--out",
        str(out_path),
    ]


def test_render_plist_requires_all_flags(tmp_path):
    required_flags = [
        "--bot",
        "--plugin-root",
        "--home",
        "--instance-path",
        "--ceiling",
        "--cooldown",
        "--whatsoup-repo",
        "--out",
    ]
    full_args = render_args(tmp_path / "tokenomics", tmp_path / "out.plist")

    for flag in required_flags:
        args = full_args.copy()
        index = args.index(flag)
        del args[index : index + 2]
        result = subprocess.run(args, text=True, capture_output=True, check=False)
        assert result.returncode != 0, flag


def test_rendered_plist_parses_and_has_no_placeholders(tmp_path):
    plugin_root = tmp_path / "tokenomics"
    out_path = tmp_path / "com.target-bot.token-budget-watchdog.plist"
    args = render_args(plugin_root, out_path)

    result = subprocess.run(args, text=True, capture_output=True, check=False)

    assert result.returncode == 0, result.stderr
    raw = out_path.read_bytes()
    assert b"$" not in raw
    plist = plistlib.loads(raw)
    assert plist["Label"] == "com.target-bot.token-budget-watchdog"
    assert plist["ProgramArguments"] == [
        "/usr/bin/python3",
        str(plugin_root / "scripts" / "token-budget-watchdog"),
    ]
    assert plist["StartInterval"] == 60
    assert plist["RunAtLoad"] is True
    assert plist["StandardOutPath"] == f"{HOME}/Library/Logs/{BOT}-tokenomics/budget-watchdog.out.log"
    assert plist["StandardErrorPath"] == f"{HOME}/Library/Logs/{BOT}-tokenomics/budget-watchdog.err.log"
    assert plist["EnvironmentVariables"] == {
        "TOKENOMICS_BOT": BOT,
        "TOKENOMICS_INSTANCE_PATH": INSTANCE_PATH,
        "TOKENOMICS_CEILING": "103000000",
        "TOKENOMICS_ALERT_COOLDOWN_SECONDS": "1800",
        "WHATSOUP_REPO": WHATSOUP_REPO,
    }
