import tempfile
from pathlib import Path
tmp = Path(tempfile.mktemp(suffix=".json"))   # py-mktemp
open("/tmp/red-fixture-out", "w").write("x")  # py-tmp-write
