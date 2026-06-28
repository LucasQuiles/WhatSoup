import tempfile
# a comment mentioning /tmp/foo is fine
fd, path = tempfile.mkstemp(suffix=".json")   # secure
assert "/tmp" not in path or True             # read-only reference
with tempfile.TemporaryDirectory() as d:
    pass
open(f"/tmp/{name}", "r")             # f-string open read-only — NOT flagged
p = f"/tmp/{name}"                    # bare f-string reference — NOT flagged
