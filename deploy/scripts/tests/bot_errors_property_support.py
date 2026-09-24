"""Generated cases own their stores and patches, independently of pytest fixtures."""
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from hypothesis import settings
import pytest

properties = settings(max_examples=16, derandomize=True, database=None, deadline=None)


@contextmanager
def private_case():
    with TemporaryDirectory(prefix="bot-errors-property-") as directory:
        with pytest.MonkeyPatch.context() as patch:
            root = Path(directory)
            patch.setenv("HOME", str(root))
            patch.setenv("TMPDIR", str(root))
            patch.setenv("BOT_ERRORS_STATE_DIR", str(root / "state"))
            patch.setenv("BOT_ERRORS_OUTBOX_DIR", str(root / "state/outbox"))
            patch.delenv("BOT_ERRORS_DRY_SEND_CAPTURE", raising=False)
            patch.delenv("BOT_ERRORS_DRY_SEND_FAIL", raising=False)
            yield root, patch
