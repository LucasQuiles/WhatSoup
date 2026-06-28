import tempfile
from pathlib import Path
from tempfile import mktemp                   # FN-3: direct import; py-mktemp
tmp = Path(tempfile.mktemp(suffix=".json"))   # py-mktemp
open("/tmp/red-fixture-out", "w").write("x")  # py-tmp-write
open("/tmp/kw-mode", mode="w").write("y")     # FN-2: keyword mode=; py-tmp-write
Path('/tmp/pathlib-write').open('w').write("z")      # FN-1a: pathlib .open positional; py-tmp-write
Path("/tmp/pathlib-kw").open(mode="w").write("q")    # FN-1b: pathlib .open mode=; py-tmp-write
open(f"/tmp/{name}-out", "w")                        # f-string open write; py-tmp-write
Path(f"/tmp/{x}").write_text("data")                 # f-string pathlib write_text; py-tmp-write
