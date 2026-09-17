# Neko - Roadmap of Differentiating Features

Ideas for features that would set Neko apart from Claude Code. Split into
quality-of-life polish (things Claude Code has partial answers for, but that we
could do better) and genuine feature bets (capabilities Claude Code does not
have today).

---

## Headline feature: Ticket-to-PR Context Orchestrator

A first-class "Work Context" layer that pulls from Jira, Linear, GitHub, GitLab,
Slack, and Notion, then synthesizes a single guiding brief for the agent before
any code is written. The user types `/work NEKO-142` (or picks from a Jira/Linear
tray in the TUI) and Neko:

1. Fetches the ticket, its comments, linked epics, and acceptance criteria.
2. Finds the correct repo(s) based on ticket metadata and past mappings.
3. Pulls recent Slack threads or Notion docs that mention the ticket ID, PR
   number, or feature name.
4. Reads open PRs, CI status on the base branch, and the last three commits
   touching the relevant files.
5. Compiles a synthesized "engagement brief" (goal, constraints, files at play,
   likely blockers, review conventions) and pins it to the session as read-only
   context.
6. Proposes a branch name and PR template that match the org's conventions,
   inferred from the last N merged PRs.
7. On session end, writes the ticket back with a status update, links the PR,
   and drops a summary comment in the relevant Slack thread.

Why this beats Claude Code today: Claude Code has MCP, but it is a raw tool
surface. The user still has to prompt "check Jira, then find the repo, then read
the ticket". Neko would ship a curated *orchestration layer* on top of MCP, so
the context arrives pre-synthesized. The value proposition is "from ticket ID to
merge-ready PR, no hand-holding".

Sub-features:
- Per-org convention learning: infer branch naming, commit style, PR body
  template, CI expectations from git history and past PRs.
- Repo router: given a ticket, guess the right repo(s) using a learned mapping
  of ticket labels -> repos.
- CI-aware loop: watch the CI run on the pushed branch, read failing logs, and
  self-correct before asking the user.
- Reviewer inference: suggest reviewers based on `git blame` and PR history.
- Slack digest on PR merge: post a formatted summary to a configured channel.

---

## Quality-of-life improvements

Refinements to existing behavior. These are areas where Claude Code has a
partial or clumsy answer and Neko can do it better in a TUI-native way.

### Session and navigation
- Command palette (Ctrl+K) with fuzzy search across slash commands, MCP tools,
  saved prompts, past sessions, and open files.
- Session bookmarks: mark a point in the timeline, jump back later without
  losing forward history.
- Global search across every past session's transcripts and tool calls, with
  filters by date, agent, model, and repo.
- Rich `/timeline` scrubbing: preview the state at any past turn (files
  touched, tokens used, cost) without rewinding.
- Split pane view: run two agents side by side in the same TUI, share context
  between them explicitly.

### Prompt ergonomics
- Extended `@` mentions: `@ticket`, `@pr`, `@commit`, `@teammate`, `@doc` in
  addition to `@file`.
- Prompt macros: save a prompt with placeholders, invoke with `/m fix-flake`.
- Draft autosave: if the user quits mid-prompt, restore the draft next launch.
- Inline image paste into the TUI (screenshots of designs, error dialogs).
- Voice dictation mode with a push-to-talk key, transcribed inline.

### Feedback and control
- Cost meter and hard cap per session with a soft warning at 80 percent.
- Context window meter with a "what would compaction drop" preview.
- Model switch mid-conversation without losing tool state.
- Semantic undo: revert the last agent action (files, git, MCP tool effects)
  as a single unit, not a per-file rollback.
- Dry-run toggle: show the plan and every tool call the agent intends to make,
  approve or edit inline before it runs.

### Diff and review
- Neko-native diff viewer with syntax highlighting, collapse-by-hunk, and
  inline comments the agent can respond to.
- Pre-commit review pane: the agent explains each hunk in one line, user can
  accept, reject, or ask a follow-up per hunk.
- Keyboard-only PR review mode for reviewing GitHub PRs entirely inside Neko.

### Notifications and long tasks
- OS-level notification when a long-running task finishes (build, CI, agent
  loop) so the user can tab away safely.
- Background agent status bar: see running subagents, their progress, and
  estimated cost without leaving the current chat.

### Errors and observability
- "Explain this error" one-shot on any tool failure with a proposed fix.
- Auto-suggest MCP tool when the user asks for something an installed MCP can
  do (e.g. types "check Sentry" -> suggests `sentry.list_issues`).

---

## Genuine features

Capabilities Claude Code does not offer today. Each is a real bet, not a polish
item.

### Local codebase knowledge graph
Build a persistent graph of the codebase: symbols, imports, call sites, tests,
owners, and change frequency. Sits alongside the LLM as a queryable index the
agent can traverse instead of grepping blind. Refreshed incrementally on file
save. Enables questions like "what breaks if I change this function" or "show
me every consumer of this API within two hops" without a full re-read.

### Skill capture (teach by watching)
While the user codes manually, Neko watches (opt-in) and offers to codify
repeated patterns as a named skill. Example: after the user manually formats
three commit messages the same way, Neko offers to save it as a skill and use
it automatically next time. This flips the flow from user-writes-instructions
to agent-proposes-instructions.

### Parallel worktree agents
Native git worktree management. Spawn N subagents on N branches, each in its
own worktree, run in parallel, then merge or pick winners. The TUI shows all N
with a scoreboard (tests passing, tokens spent, files touched). Good for
"try three approaches to this refactor" workflows.

### Ambient teammate mode
Neko runs as a background daemon that ingests configured feeds (Slack DMs to
you, Jira tickets assigned to you, PR review requests, on-call pages). It
surfaces a proactive "here is what changed while you were away and here is what
I would work on next" briefing when you open the TUI. Optionally, it can draft
first-pass replies or PR reviews and hold them for your approval.

### Cross-session organization memory
A shared, org-wide memory bank (separate from user auto-memory) that captures
decisions, ADRs, and "why we did it this way" notes. Populated by the agent
after any session where a non-obvious decision was made. Any teammate running
Neko against the same repo pulls from the same memory. Distinct from CLAUDE.md
because it is agent-maintained, versioned, and query-able by topic.

### Offline / local fallback
Run a local model (e.g. via Ollama or llama.cpp) as a fallback tier for cheap
or offline turns: file summarization, symbol renames, doc lookups. Route by
task class, not by user toggle. Keeps the session usable on planes and cuts
cost on trivial calls.

### Cost-aware routing
Per-turn, choose the model (Claude Opus vs Sonnet vs Haiku vs DeepSeek vs
local) based on the task class and remaining session budget. Show the routing
decision inline so the user can override. Claude Code has model selection but
not per-turn routing.

### Session as reproducible artifact
Export a session as a runnable script: the exact prompts, tool calls, and
model versions, replayable against a fresh checkout. Useful for onboarding
("watch how we usually add a new endpoint") and for filing bug reports against
Neko itself.

### Native PR-first workflow
A workflow mode where every session is anchored to a branch and PR from the
start. Neko manages the branch, keeps commits atomic and well-messaged,
watches CI, responds to review comments, and holds the PR at "ready to merge"
without the user asking. Claude Code can do these steps but does not orchestrate
them as one continuous workflow.

### Semantic search over tool call history
Every tool call the agent has ever made is indexed. Ask "when did we last run
the migration script and what was the output" and Neko surfaces the exact past
invocation and result. Useful for debugging flaky commands and for teaching
new teammates how the codebase actually gets operated.

### Interactive REPL on tool outputs
When a tool returns structured output (JSON, a table, a file list), drop the
user into an inline mini-REPL to filter, pivot, or pipe the result into the
next prompt without copy-pasting. Think jq plus the shell, native in the TUI.

### Guardrails as first-class config
Declarative guardrails per repo or per agent: "never touch files in
infra/prod", "always run tests before committing", "require human approval for
package.json edits". Enforced by the runtime, not by prompting. Violations
show up as blocked tool calls the user can override.

### Presence-aware pair mode
If two teammates are both in Neko against the same repo, show it. Optionally
share a live session where both can watch the same agent turn and add
prompts. Not full multi-user but enough for pair debugging.

---

## Non-goals (for clarity)

- Full multi-user tenancy. Neko is single-user by design; ambient teammate
  mode and presence are single-user features that read shared state, not
  multi-tenant surfaces.
- Cloud-hosted mode. Local-first is a differentiator; a hosted control plane
  would dilute it.
- IDE embedding. The TUI is the product surface; keep it that way.
