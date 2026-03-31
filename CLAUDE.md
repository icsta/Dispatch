# Dispatch

Agent-native sprint tracker. No UI — pure MCP. Designed for multiple concurrent Claude Code agents working across git worktrees.

## MCP Connection

```bash
claude mcp add -s user -t http dispatch http://<HOST>:3888/mcp
```

## How It Works

Dispatch is built around a multi-agent workflow where different agents play different roles:

1. **Architect agent** scopes work — creates issues, sets priorities, defines dependencies between issues, and determines what can be parallelized
2. **Developer agents** claim and execute work — `claim_next` automatically assigns the highest-priority unblocked issue
3. Multiple developer agents can work in parallel on separate git worktrees, each claiming different issues

`claim_next` is the core workflow tool. It uses PostgreSQL row-level locking (`FOR UPDATE SKIP LOCKED`) so multiple agents calling it simultaneously will never get the same issue. It automatically skips issues whose dependencies aren't resolved.

## Tools

### Projects
- `create_project(name, description?)` — Create a project
- `list_projects()` — List all projects with counts
- `update_project(project_id, name?, description?, status?)` — Update a project
- `delete_project(project_id)` — Delete (must have no sprints or issues)

### Sprints
- `create_sprint(project_id, name, goal?, start_date?, end_date?)` — Create as planned
- `update_sprint(sprint_id, name?, goal?, status?, start_date?, end_date?)` — Activate/complete. One active per project.
- `list_sprints(project_id)` — List all sprints with progress
- `delete_sprint(sprint_id)` — Delete (must have no issues assigned)

### Issues
- `create_issue(project_id, title, description?, status?, priority?, sprint_id?)` — Default: backlog/medium
- `update_issue(issue_id, title?, description?, status?, priority?, sprint_id?)` — Update fields
- `delete_issue(issue_id)` — Delete (must have no tasks)
- `search_issues(project_id, query?, status?, priority?)` — Text search + filters
- `get_issue_detail(issue_id)` — Full detail with tasks and activity history

### Tasks
- `create_task(issue_id, title)` — Add checklist item to an issue
- `update_task(task_id, title?, completed?)` — Toggle completion
- `delete_task(task_id)` — Remove task

### Dependencies
- `add_dependency(issue_id, depends_on_id)` — Issue cannot start until depends_on is done. Circular dependencies are prevented.
- `remove_dependency(issue_id, depends_on_id)` — Remove a dependency link
- `list_dependencies(issue_id)` — Show what blocks an issue and what completing it would unblock

### Workflow
- `get_sprint_context(project_id)` — **Start here.** Everything about the active sprint in one call. Issues are grouped into "ready", "blocked", "in progress", and "done".
- `sprint_summary(project_id)` — Compact 3-4 line status check. Minimal tokens.
- `claim_next(project_id, agent_id, prefer_issue_id?, branch?)` — Claim the highest-priority unblocked, unclaimed issue. Concurrency-safe. Respects dependencies.
- `complete_issue(issue_id, summary)` — Mark done + log what was accomplished. Completing an issue may unblock downstream issues.
- `log_progress(issue_id, note, agent_id?, complete_tasks?)` — Append progress note
- `plan_sprint(sprint_id, issues)` — Batch-assign issues (JSON array of `{issue_id, priority?}`)
- `backlog(project_id)` — List unassigned issues

## Enums

- **Issue status:** `backlog`, `todo`, `in_progress`, `done`, `cancelled`
- **Priority:** `urgent`, `high`, `medium`, `low`, `none`
- **Project status:** `active`, `paused`, `completed`, `cancelled`
- **Sprint status:** `planned`, `active`, `completed`

## Deletion Safety

Deletes are not cascading. You must delete bottom-up:
1. Delete all **tasks** on an issue before deleting the issue
2. Delete all **issues** in a sprint (or reassign them) before deleting the sprint
3. Delete all **sprints** in a project before deleting the project

Dependencies are automatically cleaned up when either issue is deleted.

## Workflow Patterns

### Architect: Scoping and Planning

The architect agent creates issues, sets dependencies, and plans the sprint. This happens before developer agents start work.

```
# 1. Create issues in the backlog
create_issue(project_id, "Set up database schema", priority: "urgent")        → ID: aaa
create_issue(project_id, "Build API endpoints", priority: "high")             → ID: bbb
create_issue(project_id, "Write integration tests", priority: "medium")       → ID: ccc
create_issue(project_id, "Update API documentation", priority: "low")         → ID: ddd

# 2. Define dependencies (what must happen before what)
add_dependency(issue_id: bbb, depends_on_id: aaa)    # API needs database first
add_dependency(issue_id: ccc, depends_on_id: bbb)    # Tests need API first
# ddd has no dependencies — can run in parallel with anything

# 3. Create and populate a sprint
create_sprint(project_id, "Week 14", goal: "Ship API v1", start_date: "2026-03-30", end_date: "2026-04-05")
plan_sprint(sprint_id, '[{"issue_id":"aaa"}, {"issue_id":"bbb"}, {"issue_id":"ccc"}, {"issue_id":"ddd"}]')
update_sprint(sprint_id, status: "active")
```

After this, `get_sprint_context` will show:
- **TODO (ready):** `Set up database schema` [urgent], `Update API documentation` [low]
- **BLOCKED:** `Build API endpoints` (waiting on "Set up database schema"), `Write integration tests` (waiting on "Build API endpoints")

### Developer: Claiming and Executing Work

Developer agents call `claim_next` and it handles everything — picks the right issue, skips blocked ones, prevents double-assignment.

```
# Agent in worktree 1:
get_sprint_context(project_id)                           → see the board
claim_next(project_id, "wt-1", branch: "feature/db")    → gets "Set up database schema" (highest priority, unblocked)

# Agent in worktree 2 (simultaneously):
claim_next(project_id, "wt-2", branch: "feature/docs")  → gets "Update API documentation" (only other unblocked issue)

# Agent in worktree 3:
claim_next(project_id, "wt-3")                           → "No claimable issues" (remaining issues are blocked)
```

### Developer: Progress and Completion

```
# While working
log_progress(issue_id, "Created tables, adding indexes", agent_id: "wt-1")
update_task(task_id, completed: true)

# When done — this may unblock downstream issues
complete_issue(issue_id, "Schema created with all tables, indexes, and seed data")
```

After completing "Set up database schema", `claim_next` will now return "Build API endpoints" since its dependency is resolved.

### Parallelization

Two issues can safely run in parallel when:
- Neither depends on the other (no dependency link between them)
- They modify mostly different files

Two issues should NOT run in parallel when:
- One depends on the other's output
- Both heavily modify the same files (e.g., both rewriting the same module)

The architect expresses this through dependencies. If A and B can't parallelize, make one depend on the other. If they can parallelize, leave them independent — `claim_next` will assign them to different agents.

## Agent ID Convention

Use a descriptive identifier for `agent_id` when claiming issues:
- `wt-auth-1` — worktree 1 working on auth
- `wt-api-2` — worktree 2 working on API
- `agent-main` — agent on the main branch

This identifies who is working on what in `get_sprint_context` output and activity logs.
