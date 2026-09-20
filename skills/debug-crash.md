---
description: Diagnose a runtime crash or panic from a stack trace or error log
---

# debug-crash

Use when the user pastes a stack trace, panic output, segfault, or unhandled exception.

## Process

1. Identify the crashing frame — the first non-runtime, non-stdlib line in the trace
2. Read that file at that line and surrounding context
3. Trace backward through callers to find the root cause
4. Check for: nil/null dereference, out-of-bounds access, type assertion failure, uninitialized state, race condition

## Common patterns

| Error pattern | Likely cause |
|---|---|
| `cannot read property of undefined` | async value consumed before it resolves |
| `index out of range` | slice/array access without length check |
| `SIGSEGV` | dangling pointer or use-after-free |
| `effect fiber interrupted` | upstream effect cancelled mid-execution |
| `unexpected end of JSON` | empty body from failed HTTP response |

## Output

- Pinpoint the exact line causing the crash
- Explain WHY it crashes (not just what)
- Show a minimal fix
- Note if a test could have caught this
