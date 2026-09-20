---
description: Refactor code for clarity, performance, or maintainability without changing behavior
---

# refactor

Use when the user wants to clean up, simplify, or restructure existing code.

## Pre-flight checklist

Before touching anything:
1. Confirm there are tests — if not, write them first or warn the user
2. Understand the full call graph — never refactor a function without knowing all its callers
3. Run the existing test suite to get a green baseline

## Refactor types

| Goal | Approach |
|---|---|
| Reduce duplication | Extract shared logic into a named helper |
| Simplify conditionals | Flatten nested ifs, use early returns |
| Improve naming | Rename to match intent, not implementation |
| Split large file | Group by responsibility, one concept per module |
| Improve types | Replace `any` / `unknown` with precise types |
| Reduce coupling | Inject dependencies, avoid deep imports |

## Rules

- One refactor type per PR — don't mix concerns
- Preserve public API shape unless the user explicitly asks to change it
- After refactoring, run tests and confirm the diff is behavior-neutral
- Don't add features during a refactor — log them as follow-ups
