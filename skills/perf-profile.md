---
description: Profile and diagnose performance issues — CPU, memory, or latency
---

# perf-profile

Use when the user reports slowness, high memory usage, or latency spikes.

## Diagnosis flow

1. **Measure first** — never optimize without a number to beat
2. Identify bottleneck type: CPU-bound, I/O-bound, memory pressure, or lock contention
3. Find the hot path — the 20% of code causing 80% of the cost
4. Fix the bottleneck, re-measure, confirm improvement

## Quick checks by symptom

| Symptom | Check first |
|---|---|
| Slow startup | Synchronous I/O at import time, large bundle |
| High memory | Unbounded caches, retained closures, large allocations |
| Slow queries | Missing indexes, N+1 queries, full table scans |
| API latency | Waterfall fetches that could be parallel, cold starts |
| CPU spike | Tight loops, regex on large strings, unthrottled timers |

## Profiling commands

```bash
# Node.js CPU profile
node --prof app.js && node --prof-process isolate-*.log

# Bun memory
bun --smol run app.ts

# SQL query plan
EXPLAIN ANALYZE SELECT ...;
```

## Rules

- Always profile in production-like conditions — dev builds lie
- Never cache without a TTL or eviction strategy
- Document the before/after numbers in the PR description
