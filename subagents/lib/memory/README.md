# subagent memory lib

Self-contained legacy memory primitives (safety boundary, atomic writes,
working-memory validation, daily-summary rendering) used only by the subagent
runner. The main harness memory moved to `packages/memory`; this library stays
until the subagent loop (steps 8/9) is reworked onto it. Node builtins and
relative imports only.
