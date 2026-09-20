---
description: Write unit or integration tests for a function, module, or feature
---

# write-tests

Use when the user asks to add tests, increase coverage, or test a specific code path.

## Strategy

1. Read the code under test fully before writing anything
2. Identify: happy path, error paths, edge cases, boundary conditions
3. Match the existing test style — don't introduce a new framework if one is already in use
4. Prefer real I/O over mocks unless the boundary is truly external (network, clock)

## Test naming convention

```
<unit>_<scenario>_<expected outcome>
// e.g.
parseDate_emptyString_returnsNull
createUser_duplicateEmail_throwsConflict
```

## Coverage targets

- Every exported function gets at least one test
- Error branches must be explicitly exercised
- Side effects (DB writes, file writes, events emitted) must be asserted, not just the return value

## Rules

- Never mock the database if integration tests already hit a real one
- Don't write snapshot tests for logic — only for UI output
- If the code is untestable as-is, refactor the interface first, then write tests
