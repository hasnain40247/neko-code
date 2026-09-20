---
description: Explain a file, function, or concept clearly — for any experience level
---

# explain-code

Use when the user wants to understand how something works, not change it.

## Approach

1. Read the target code in full
2. Identify: what it does, what it takes as input, what it produces, what side effects it has
3. Trace any non-obvious control flow (recursion, effect chains, event loops)
4. Explain in plain language first, then reference line numbers for specifics

## Layered explanation format

```
### What it does
<one paragraph, no jargon>

### How it works
<step-by-step walkthrough with file:line references>

### Key concepts
<only if domain knowledge is needed — e.g. monads, CRDTs, LSM trees>

### Gotchas
<non-obvious behavior, footguns, or known issues>
```

## Rules

- Match depth to the user's level — a junior gets analogies, a senior gets precise terminology
- Never explain WHAT variable names say — only explain WHY the code does what it does
- If the code is bad, say so — don't just describe it neutrally
