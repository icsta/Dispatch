import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import * as db from "./db.mjs";

function createServer() {
  const server = new McpServer({
    name: "dispatch",
    version: "1.0.0",
    instructions: `Dispatch is an agent sprint tracker. Key workflow:
1. get_sprint_context → see the full board (ready, blocked, in-progress, done)
2. claim_next → automatically picks highest-priority unblocked issue (concurrency-safe)
3. log_progress / complete_issue → track and finish work
Dependencies: use add_dependency to define execution order. claim_next skips blocked issues automatically.
Architect agents scope work and set dependencies. Developer agents just call claim_next.`,
  });

  // ==================== PROJECTS ====================

  server.tool("create_project", "Create a new project", {
    name: z.string().describe("Project name"),
    description: z.string().optional().describe("Project description"),
  }, async ({ name, description }) => {
    return text(await db.createProject(name, description));
  });

  server.tool("list_projects", "List all projects with issue and sprint counts", {}, async () => {
    return text(await db.listProjects());
  });

  server.tool("update_project", "Update a project's name, description, or status", {
    project_id: z.string().describe("Project ID"),
    name: z.string().optional().describe("New name"),
    description: z.string().optional().describe("New description"),
    status: z.enum(["active", "paused", "completed", "cancelled"]).optional().describe("New status"),
  }, async ({ project_id, name, description, status }) => {
    return text(await db.updateProject(project_id, { name, description, status }));
  });

  server.tool("delete_project", "Delete a project and all its sprints, issues, tasks, and activity", {
    project_id: z.string().describe("Project ID"),
  }, async ({ project_id }) => {
    return text(await db.deleteProject(project_id));
  });

  // ==================== SPRINTS ====================

  server.tool("create_sprint", "Create a new sprint (planned status). Use update_sprint to activate.", {
    project_id: z.string().describe("Project ID"),
    name: z.string().describe("Sprint name"),
    goal: z.string().optional().describe("Sprint goal — what should be accomplished"),
    start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
    end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
  }, async ({ project_id, name, goal, start_date, end_date }) => {
    return text(await db.createSprint(project_id, name, goal, start_date, end_date));
  });

  server.tool("update_sprint", "Update a sprint's name, goal, status, or dates. One active sprint per project.", {
    sprint_id: z.string().describe("Sprint ID"),
    name: z.string().optional().describe("New name"),
    goal: z.string().optional().describe("New goal"),
    status: z.enum(["planned", "active", "completed"]).optional().describe("New status"),
    start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
    end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
  }, async ({ sprint_id, name, goal, status, start_date, end_date }) => {
    return text(await db.updateSprint(sprint_id, { name, goal, status, startDate: start_date, endDate: end_date }));
  });

  server.tool("list_sprints", "List all sprints for a project with progress counts", {
    project_id: z.string().describe("Project ID"),
  }, async ({ project_id }) => {
    return text(await db.listSprints(project_id));
  });

  server.tool("delete_sprint", "Delete a sprint. Issues in it are unassigned, not deleted.", {
    sprint_id: z.string().describe("Sprint ID"),
  }, async ({ sprint_id }) => {
    return text(await db.deleteSprint(sprint_id));
  });

  // ==================== ISSUES ====================

  server.tool("create_issue", "Create a new issue in a project", {
    project_id: z.string().describe("Project ID"),
    title: z.string().describe("Issue title"),
    description: z.string().optional().describe("Issue description"),
    status: z.enum(["backlog", "todo", "in_progress", "done", "cancelled"]).optional().describe("Status (default: backlog)"),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional().describe("Priority (default: medium)"),
    sprint_id: z.string().optional().describe("Sprint ID to assign to"),
  }, async ({ project_id, title, description, status, priority, sprint_id }) => {
    return text(await db.createIssue(project_id, title, description, status, priority, sprint_id));
  });

  server.tool("update_issue", "Update an issue's fields", {
    issue_id: z.string().describe("Issue ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    status: z.enum(["backlog", "todo", "in_progress", "done", "cancelled"]).optional().describe("New status"),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional().describe("New priority"),
    sprint_id: z.string().optional().describe("Sprint ID (empty string to unassign)"),
  }, async ({ issue_id, title, description, status, priority, sprint_id }) => {
    return text(await db.updateIssue(issue_id, { title, description, status, priority, sprintId: sprint_id }));
  });

  server.tool("delete_issue", "Delete an issue and its tasks/activity", {
    issue_id: z.string().describe("Issue ID"),
  }, async ({ issue_id }) => {
    return text(await db.deleteIssue(issue_id));
  });

  // ==================== DEPENDENCIES ====================

  server.tool("add_dependency", "Add a dependency: issue cannot start until depends_on issue is done. Prevents circular dependencies.", {
    issue_id: z.string().describe("The issue that is blocked"),
    depends_on_id: z.string().describe("The issue it depends on (must be done before issue_id can start)"),
  }, async ({ issue_id, depends_on_id }) => {
    return text(await db.addDependency(issue_id, depends_on_id));
  });

  server.tool("remove_dependency", "Remove a dependency between two issues", {
    issue_id: z.string().describe("The issue that was blocked"),
    depends_on_id: z.string().describe("The issue it depended on"),
  }, async ({ issue_id, depends_on_id }) => {
    return text(await db.removeDependency(issue_id, depends_on_id));
  });

  server.tool("list_dependencies", "Show what blocks an issue and what it unblocks", {
    issue_id: z.string().describe("Issue ID"),
  }, async ({ issue_id }) => {
    return text(await db.listDependencies(issue_id));
  });

  server.tool("search_issues", "Search issues by text, status, or priority", {
    project_id: z.string().describe("Project ID"),
    query: z.string().optional().describe("Search text (matches title and description)"),
    status: z.enum(["backlog", "todo", "in_progress", "done", "cancelled"]).optional().describe("Filter by status"),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional().describe("Filter by priority"),
  }, async ({ project_id, query, status, priority }) => {
    return text(await db.searchIssues(project_id, query, status, priority));
  });

  server.tool("get_issue_detail", "Get full detail on an issue: description, tasks, activity history", {
    issue_id: z.string().describe("Issue ID"),
  }, async ({ issue_id }) => {
    return text(await db.getIssueDetail(issue_id));
  });

  // ==================== TASKS ====================

  server.tool("create_task", "Add a checklist task to an issue", {
    issue_id: z.string().describe("Issue ID"),
    title: z.string().describe("Task title"),
  }, async ({ issue_id, title }) => {
    return text(await db.createTask(issue_id, title));
  });

  server.tool("update_task", "Update a task's title or completion status", {
    task_id: z.string().describe("Task ID"),
    title: z.string().optional().describe("New title"),
    completed: z.boolean().optional().describe("Mark completed (true/false)"),
  }, async ({ task_id, title, completed }) => {
    return text(await db.updateTask(task_id, { title, completed }));
  });

  server.tool("delete_task", "Delete a task", {
    task_id: z.string().describe("Task ID"),
  }, async ({ task_id }) => {
    return text(await db.deleteTask(task_id));
  });

  // ==================== WORKFLOW ====================

  server.tool("get_sprint_context", "Get everything about the active sprint: issues grouped by status, tasks, recent activity. Primary 'orient me' tool.", {
    project_id: z.string().describe("Project ID"),
  }, async ({ project_id }) => {
    return text(await db.getSprintContext(project_id));
  });

  server.tool("sprint_summary", "Compact 3-4 line sprint status check. Minimal tokens.", {
    project_id: z.string().describe("Project ID"),
  }, async ({ project_id }) => {
    return text(await db.sprintSummary(project_id));
  });

  server.tool("claim_next", "Claim the highest-priority unclaimed issue. Concurrency-safe for multiple agents.", {
    project_id: z.string().describe("Project ID"),
    agent_id: z.string().describe("Agent/worktree identifier (e.g., 'wt-auth-1')"),
    prefer_issue_id: z.string().optional().describe("Claim a specific issue instead of auto-selecting"),
    branch: z.string().optional().describe("Git branch name for this work"),
  }, async ({ project_id, agent_id, prefer_issue_id, branch }) => {
    return text(await db.claimNext(project_id, agent_id, prefer_issue_id, branch));
  });

  server.tool("complete_issue", "Mark an issue done, log what was accomplished, complete all tasks.", {
    issue_id: z.string().describe("Issue ID"),
    summary: z.string().describe("What was done — this gets logged in the activity history"),
  }, async ({ issue_id, summary }) => {
    return text(await db.completeIssue(issue_id, summary));
  });

  server.tool("log_progress", "Append a progress note to an issue's activity log.", {
    issue_id: z.string().describe("Issue ID"),
    note: z.string().describe("Progress note"),
    agent_id: z.string().optional().describe("Agent identifier"),
    complete_tasks: z.string().optional().describe("Comma-separated task IDs to mark completed"),
  }, async ({ issue_id, note, agent_id, complete_tasks }) => {
    const taskIds = complete_tasks ? complete_tasks.split(",").map((s) => s.trim()).filter(Boolean) : null;
    return text(await db.logProgress(issue_id, note, agent_id, taskIds));
  });

  server.tool("plan_sprint", "Batch-assign issues to a sprint. Moves backlog items to todo.", {
    sprint_id: z.string().describe("Sprint ID"),
    issues: z.string().describe('JSON array of objects: [{"issue_id": "...", "priority": "high"}, ...]. Priority is optional.'),
  }, async ({ sprint_id, issues: issuesJson }) => {
    let specs;
    try {
      specs = JSON.parse(issuesJson);
    } catch {
      return err("Invalid JSON for issues parameter.");
    }
    return text(await db.planSprint(sprint_id, specs));
  });

  server.tool("backlog", "List all issues not assigned to any sprint, ordered by priority.", {
    project_id: z.string().describe("Project ID"),
  }, async ({ project_id }) => {
    return text(await db.getBacklog(project_id));
  });

  return server;
}

function text(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function err(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ── HTTP Server ──

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on("close", () => {
    transport.close();
    server.close();
  });
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST for MCP requests." });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed." });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3001;

async function start() {
  await db.init();
  console.log("Database initialized.");
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sprint Tracker MCP listening on http://0.0.0.0:${PORT}/mcp`);
  });
}

start().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
