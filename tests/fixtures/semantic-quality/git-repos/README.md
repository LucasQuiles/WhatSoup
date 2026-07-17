# Semantic Git repository fixtures

The exact-object policy tests construct isolated Git repositories at runtime. Each fixture creates
commits for added, renamed, modified, deleted, malformed, allowlisted, and working-tree-divergent
source shapes so the guard is tested against real object IDs and diff status records.
