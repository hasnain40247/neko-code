---
description: Explore git history — find when a bug was introduced, trace a change, or bisect
---

# git-history

Use when the user wants to understand how the codebase got to its current state, or find when something broke.

## Common tasks

### Find when a line was last changed
```bash
git log -S "search string" --source --all
git log -p -- path/to/file.ts | grep -A5 -B5 "pattern"
```

### Blame with context
```bash
git blame -L 40,60 path/to/file.ts
```

### Bisect a regression
```bash
git bisect start
git bisect bad HEAD
git bisect good v1.2.0
# run test after each step, mark good/bad until bisect identifies the commit
```

### Find a deleted function
```bash
git log --all -S "functionName" -- "*.ts"
git show <commit>:path/to/file.ts | grep -A20 "functionName"
```

## Reading a commit

1. `git show <sha>` — full diff
2. Look at the PR number in the message, then `gh pr view <number>` for the full review thread
3. Check related commits: `git log --ancestry-path <sha>^..HEAD -- file`

## Rules

- Never rewrite history on shared branches
- Use `git revert` to undo a merged commit, not `git reset`
