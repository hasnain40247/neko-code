---
description: Review a GitHub pull request — summary, risks, and inline suggestions
---

# review-pr

Triggered when the user asks to review a PR, check a diff, or audit changes before merge.

## What to do

1. Fetch the PR diff via `gh pr diff <number>`
2. Read changed files in full where needed for context
3. Check for:
   - Logic bugs and off-by-one errors
   - Missing error handling at boundaries
   - Security issues (injection, auth bypass, secrets in code)
   - Test coverage gaps
   - Breaking API changes

## Output format

Return a structured review:

```
## Summary
<2-3 sentence overview of what the PR does>

## Risks
- <risk 1>
- <risk 2>

## Suggestions
- `path/to/file.ts:42` — <suggestion>
- `path/to/file.ts:88` — <suggestion>

## Verdict
APPROVE / REQUEST CHANGES / COMMENT
```

## Rules

- Never approve a PR that adds secrets or credentials to source
- Flag any DB schema changes that lack a migration
- If tests are missing for new public functions, always flag it
