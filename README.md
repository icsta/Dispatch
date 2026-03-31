# Dispatch

An agent-native sprint tracker built exclusively for AI agents. No web UI, no REST API — just a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server backed by PostgreSQL.

Built for [Claude Code](https://claude.ai/code) agents that need to coordinate work across multiple worktrees and track progress through sprints. Think of it as a headless, agent-optimized alternative to Linear or Jira.

## Why This Exists

Traditional project management tools are designed for humans: kanban boards, drag-and-drop, color-coded labels, rich text editors. Agents don't need any of that. They need:

- **One call to understand the full sprint state** instead of navigating a UI
- **Concurrency-safe work claiming** so multiple agents don't grab the same issue
- **Dependency tracking** so agents don't start work that's blocked
- **Token-efficient responses** that don't waste context window on verbose JSON
- **Workflow-oriented tools** that handle multi-step operations in a single call

## Architecture

```
Claude Code agents (one or many)
    |
    | MCP over Streamable HTTP
    v
Express server (Docker container, port 3888)
    |
    | node-postgres
    v
PostgreSQL 17 (Docker container, port 5432)
```

Two Docker containers. Four dependencies (`@modelcontextprotocol/sdk`, `express`, `pg`, `zod`). No ORM, no build step, no frontend framework.

## Quick Start

### Prerequisites

- Docker and Docker Compose
- [Claude Code](https://claude.ai/code) CLI

### 1. Start the containers

```bash
git clone https://github.com/icsta/Dispatch.git dispatch
cd dispatch
docker compose up -d
```

This starts PostgreSQL and the MCP server. The database schema is applied automatically on first boot.

### 2. Connect Claude Code

```bash
claude mcp add -s user -t http dispatch http://localhost:3888/mcp
```

This registers the MCP server globally so it's available in all Claude Code sessions.

### 3. Start using it

In any Claude Code session, the tools are now available:

```
> Create a project called "My App" and set up a sprint for this week
> Add some issues to the backlog, set dependencies, and plan the sprint
> What's the sprint status?
```

## Multi-Agent Workflow

Dispatch is designed around a multi-agent pattern where different agents play different roles:

### The Architect-Developer Pattern

```
ARCHITECT AGENT                    DEVELOPER AGENTS
      |                                  |
  Scopes work                     Claim and execute
  Creates issues                  One issue at a time
  Sets priorities                 Work in git worktrees
  Defines dependencies            Log progress
  Plans sprints                   Complete issues
      |                                  |
      v                                  v
  "A must finish          claim_next → gets highest
   before B starts"        priority unblocked issue
```

1. **Architect agent** scopes and plans — creates issues, sets priorities, defines dependencies between issues, and plans the sprint. The architect decides what can be parallelized by choosing which issues depend on each other.

2. **Developer agents** claim and execute — each calls `claim_next`, which automatically assigns the highest-priority issue that isn't blocked by unresolved dependencies. Multiple developer agents can run in parallel across separate git worktrees.

### Dependencies Drive Parallelization

Instead of explicitly marking what can run in parallel, the architect defines what *can't* — through dependencies:

```
Set up database (urgent)     ← no dependencies, ready immediately
    |
    v depends on
Build API endpoints (high)   ← blocked until database is done
    |
    v depends on
Write integration tests (medium) ← blocked until API is done

Update documentation (low)   ← no dependencies, ready immediately
```

When two developer agents call `claim_next`:
- **Agent 1** gets "Set up database" (urgent, unblocked)
- **Agent 2** gets "Update documentation" (low priority, but it's the only other unblocked issue)
- "Build API endpoints" is skipped even though it's higher priority — it's blocked

When Agent 1 completes the database issue, "Build API endpoints" is automatically unblocked and will be returned by the next `claim_next` call.

### Concurrency Safety

`claim_next` uses PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`. If two agents call it at the exact same millisecond, they'll get different issues. No race conditions, no double-assignment.

## Tools

Dispatch exposes 26 MCP tools.

### CRUD Tools

| Tool | Description |
|------|-------------|
| `create_project` | Create a new project |
| `list_projects` | List all projects with issue and sprint counts |
| `update_project` | Update a project's name, description, or status |
| `delete_project` | Delete a project (must have no sprints or issues) |
| `create_sprint` | Create a new sprint (starts as "planned") |
| `update_sprint` | Update sprint name, goal, status, or dates |
| `list_sprints` | List all sprints for a project with progress |
| `delete_sprint` | Delete a sprint (must have no issues assigned) |
| `create_issue` | Create an issue with title, description, priority, status |
| `update_issue` | Update any field on an issue |
| `delete_issue` | Delete an issue (must have no tasks) |
| `search_issues` | Search by text, status, or priority |
| `get_issue_detail` | Full issue detail with tasks and activity history |
| `create_task` | Add a checklist item to an issue |
| `update_task` | Update a task's title or mark it completed |
| `delete_task` | Delete a task |

### Dependency Tools

| Tool | Description |
|------|-------------|
| `add_dependency` | Issue A cannot start until issue B is done. Circular dependencies are prevented. |
| `remove_dependency` | Remove a dependency link |
| `list_dependencies` | Show what blocks an issue and what completing it would unblock |

### Workflow Tools

| Tool | Description |
|------|-------------|
| `get_sprint_context` | Everything about the active sprint in one call. Issues grouped into ready, blocked, in-progress, and done. **Start here.** |
| `sprint_summary` | Compact 3-4 line status check. Minimal tokens. |
| `claim_next` | Claim the highest-priority unblocked, unclaimed issue. Concurrency-safe. Respects dependencies. |
| `complete_issue` | Mark done, log what was accomplished, auto-complete all tasks. May unblock downstream issues. |
| `log_progress` | Append a progress note and optionally complete tasks in one call. |
| `plan_sprint` | Batch-assign issues to a sprint with optional priority overrides. |
| `backlog` | List all unassigned issues, ordered by priority. |

## Response Format

All tool responses are plain text, not JSON. Plain text is more token-efficient and more readable for agents.

**`get_sprint_context`** — the primary orientation tool:
```
SPRINT: "Week 14" (2026-03-30 - 2026-04-05) [active]
GOAL: Ship API v1
PROGRESS: 1/4 done | 1 in_progress | 2 todo

--- IN PROGRESS ---
[high] 3d377dd3 "Build API endpoints" (agent: wt-api-1)
  Branch: feature/api-endpoints
  Tasks: 2/5 | [ ] Auth middleware [ ] Error handling [ ] Rate limiting
  Last: "CRUD endpoints done, adding auth" (12m ago)

--- TODO (ready) ---
[low] 8a9b0c1d "Update API documentation"

--- BLOCKED ---
[medium] de93a524 "Write integration tests" <- waiting on "Build API endpoints"

--- DONE ---
154b3807 "Set up database schema"

--- RECENT ACTIVITY ---
12m ago [3d377dd3] "CRUD endpoints done, adding auth" (wt-api-1)
1h ago [154b3807] "Completed: Schema with all tables and indexes" (wt-db-1)
```

**`sprint_summary`** — minimal tokens:
```
Sprint "Week 14" | 2026-03-30 - 2026-04-05 | Goal: Ship API v1
done:1 in_progress:1 todo:1 backlog:0 cancelled:0 | 25% complete
Active: "Build API endpoints" [high] (wt-api-1)
Next: "Update API documentation" [low]
```

**`claim_next`** — what the developer agent receives:
```
CLAIMED: 3d377dd3 "Build API endpoints" [high]
ID: 3d377dd3-596e-42e7-812d-5053360dc5db
Branch: feature/api-endpoints

Build REST endpoints for all CRUD operations on the core data models.

Tasks:
- [ ] User endpoints
- [ ] Project endpoints
- [ ] Auth middleware
- [ ] Error handling
- [ ] Rate limiting
```

## Data Model

Six tables:

```
projects
  └── sprints (one active per project)
        └── issues (status, priority, assigned agent, branch)
              ├── tasks (checklist items)
              ├── activity_log (timestamped progress notes)
              └── dependencies (issue-to-issue dependency links)
```

### Statuses and Priorities

| Entity | Values |
|--------|--------|
| Project status | `active`, `paused`, `completed`, `cancelled` |
| Sprint status | `planned`, `active`, `completed` |
| Issue status | `backlog`, `todo`, `in_progress`, `done`, `cancelled` |
| Issue priority | `urgent`, `high`, `medium`, `low`, `none` |

### Key Constraints

- **One active sprint per project.** Activating a sprint while another is active returns an error.
- **Priority defaults to `medium`**, not `none`. Every issue should carry a priority signal.
- **No cascading deletes.** Must delete bottom-up: tasks, then issues, then sprints, then projects. This prevents accidental data loss.
- **No circular dependencies.** `add_dependency` checks the full dependency chain before allowing a link.
- **Dependencies cascade on issue deletion.** Deleting an issue removes its dependency links automatically.

## Building Agents Around Dispatch

### Architect Agent

An architect agent should have instructions to:
1. Read the current sprint state with `get_sprint_context`
2. Review the `backlog` for unplanned work
3. Create new issues with clear titles, descriptions, and priorities
4. Add `create_task` checklists so developer agents know what steps to take
5. Set `add_dependency` links to define execution order
6. Use `plan_sprint` to batch-assign issues when starting a new sprint

The architect's key judgment call: **which issues depend on each other.** Two issues that modify the same files should have a dependency between them. Two issues that touch entirely different parts of the codebase can be left independent for parallel execution.

### Developer Agent

A developer agent should have instructions to:
1. Call `get_sprint_context` or `sprint_summary` to orient itself
2. Call `claim_next` with its `agent_id` and optionally a `branch` name
3. Do the work described in the issue and its tasks
4. Call `log_progress` periodically to record what's been done
5. Call `complete_issue` with a summary when finished
6. Optionally call `claim_next` again to pick up the next issue

Developer agents don't need to understand dependencies — `claim_next` handles it. They just call it and get work.

### Manager / Orchestrator Agent

If you have a manager agent that spawns sub-agents:
1. Call `get_sprint_context` to see the full board
2. Count how many issues are in "TODO (ready)" — that's how many developer agents can run in parallel
3. Spawn that many developer agents, each in its own git worktree
4. Each developer agent calls `claim_next` independently
5. When a developer completes an issue, previously-blocked issues may become ready — the manager can spawn additional agents

## Deployment

### Local Development

```bash
docker compose up -d        # Start Postgres + MCP server
docker compose logs -f app  # Watch server logs
docker compose down          # Stop everything (data persists in volume)
```

### Unraid / Remote Server

See [unraid-deploy.md](unraid-deploy.md) for the full deployment guide. The short version:

```bash
# Build for amd64, transfer, start on Unraid
docker buildx build --platform linux/amd64 -t dispatch . --load
docker save dispatch | gzip > /tmp/dispatch.tar.gz
scp /tmp/dispatch.tar.gz root@<UNRAID_IP>:/mnt/user/appdata/dispatch/

# On Unraid: load and run (see unraid-deploy.md for full commands)
```

Then connect Claude Code to the remote server:

```bash
claude mcp add -s user -t http dispatch http://<UNRAID_IP>:3888/mcp
```

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /mcp` | MCP Streamable HTTP transport |
| `GET /health` | Health check (returns `{"status":"ok"}`) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://sprint:sprint@localhost:5432/sprint_tracker` | PostgreSQL connection string |
| `PORT` | `3001` | Server listen port (mapped to 3888 externally) |

## Project Structure

```
dispatch/
  server.mjs           Express + MCP server + 26 tool definitions
  db.mjs               PostgreSQL queries + workflow logic
  init.sql             Database schema (6 tables + indexes)
  package.json         4 dependencies
  Dockerfile           Two-stage node:20-alpine build
  docker-compose.yml   Postgres + app containers
  CLAUDE.md            Agent-facing tool reference and workflow patterns
  unraid-deploy.md     Remote deployment guide
```

Eight files. No build step. No framework beyond Express for HTTP.
