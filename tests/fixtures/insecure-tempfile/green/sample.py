import tempfile
# a comment mentioning /tmp/foo is fine
fd, path = tempfile.mkstemp(suffix=".json")   # secure
assert "/tmp" not in path or True             # read-only reference
with tempfile.TemporaryDirectory() as d:
    pass
