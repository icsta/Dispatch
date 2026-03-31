import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgres://sprint:sprint@localhost:5432/sprint_tracker",
});

export async function init() {
  const sql = readFileSync(join(__dirname, "init.sql"), "utf-8");
  await pool.query(sql);
}

// ── Helpers ──

function shortId(uuid) {
  return uuid.slice(0, 8);
}

function relativeTime(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDate(d) {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

// ── Projects ──

export async function createProject(name, description) {
  const { rows } = await pool.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING *`,
    [name, description || null]
  );
  const p = rows[0];
  return `Created project: ${p.name} (${shortId(p.id)})\nID: ${p.id}`;
}

export async function listProjects() {
  const { rows } = await pool.query(`
    SELECT p.*,
      (SELECT count(*) FROM sprints WHERE project_id = p.id) AS sprint_count,
      (SELECT count(*) FROM issues WHERE project_id = p.id) AS issue_count
    FROM projects p ORDER BY p.updated_at DESC
  `);
  if (!rows.length) return "No projects yet.";
  return rows
    .map((p) => `[${p.status}] ${shortId(p.id)} "${p.name}" | ${p.issue_count} issues, ${p.sprint_count} sprints\nID: ${p.id}`)
    .join("\n");
}

export async function updateProject(projectId, updates) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      sets.push(`${key} = $${i}`);
      vals.push(val);
      i++;
    }
  }
  if (!sets.length) return "Nothing to update.";
  sets.push(`updated_at = now()`);
  vals.push(projectId);
  const { rows } = await pool.query(
    `UPDATE projects SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return "Project not found.";
  const p = rows[0];
  return `Updated project: "${p.name}" [${p.status}]\nID: ${p.id}`;
}

export async function deleteProject(projectId) {
  const { rows: sprints } = await pool.query(
    `SELECT count(*)::int AS count FROM sprints WHERE project_id = $1`, [projectId]
  );
  if (sprints[0].count > 0) {
    return `Cannot delete: project still has ${sprints[0].count} sprint(s). Delete all sprints first.`;
  }
  const { rows: issues } = await pool.query(
    `SELECT count(*)::int AS count FROM issues WHERE project_id = $1`, [projectId]
  );
  if (issues[0].count > 0) {
    return `Cannot delete: project still has ${issues[0].count} issue(s). Delete all issues first.`;
  }
  const { rowCount } = await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  if (!rowCount) return "Project not found.";
  return "Project deleted.";
}

// ── Sprints ──

export async function createSprint(projectId, name, goal, startDate, endDate) {
  const { rows } = await pool.query(
    `INSERT INTO sprints (project_id, name, goal, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [projectId, name, goal || null, startDate || null, endDate || null]
  );
  const s = rows[0];
  const dates = s.start_date && s.end_date
    ? ` (${formatDate(s.start_date)} - ${formatDate(s.end_date)})`
    : "";
  return `Created sprint: "${s.name}"${dates} [${s.status}]\nID: ${s.id}`;
}

export async function updateSprint(sprintId, updates) {
  // Enforce one active sprint per project
  if (updates.status === "active") {
    const { rows: sprint } = await pool.query(`SELECT project_id FROM sprints WHERE id = $1`, [sprintId]);
    if (!sprint.length) return "Sprint not found.";
    const { rows: active } = await pool.query(
      `SELECT id, name FROM sprints WHERE project_id = $1 AND status = 'active' AND id != $2`,
      [sprint[0].project_id, sprintId]
    );
    if (active.length) {
      return `Error: Sprint "${active[0].name}" (${shortId(active[0].id)}) is already active. Complete it first.`;
    }
  }

  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      const col = key === "startDate" ? "start_date" : key === "endDate" ? "end_date" : key;
      sets.push(`${col} = $${i}`);
      vals.push(val);
      i++;
    }
  }
  if (!sets.length) return "Nothing to update.";
  sets.push(`updated_at = now()`);
  vals.push(sprintId);

  const { rows } = await pool.query(
    `UPDATE sprints SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return "Sprint not found.";
  const s = rows[0];
  return `Updated sprint: "${s.name}" [${s.status}]\nID: ${s.id}`;
}

export async function listSprints(projectId) {
  const { rows } = await pool.query(
    `SELECT s.*,
      (SELECT count(*) FROM issues WHERE sprint_id = s.id) AS issue_count,
      (SELECT count(*) FROM issues WHERE sprint_id = s.id AND status = 'done') AS done_count
     FROM sprints s WHERE s.project_id = $1 ORDER BY s.created_at DESC`,
    [projectId]
  );
  if (!rows.length) return "No sprints yet.";
  return rows
    .map((s) => {
      const dates = s.start_date && s.end_date
        ? ` (${formatDate(s.start_date)} - ${formatDate(s.end_date)})`
        : "";
      return `[${s.status}] ${shortId(s.id)} "${s.name}"${dates} | ${s.done_count}/${s.issue_count} done${s.goal ? ` | Goal: ${s.goal}` : ""}\nID: ${s.id}`;
    })
    .join("\n");
}

export async function deleteSprint(sprintId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM issues WHERE sprint_id = $1`, [sprintId]
  );
  if (rows[0].count > 0) {
    return `Cannot delete: sprint still has ${rows[0].count} issue(s). Remove or reassign them first (update_issue with sprint_id: "" to unassign).`;
  }
  const { rowCount } = await pool.query(`DELETE FROM sprints WHERE id = $1`, [sprintId]);
  if (!rowCount) return "Sprint not found.";
  return "Sprint deleted.";
}

// ── Issues ──

export async function createIssue(projectId, title, description, status, priority, sprintId) {
  const { rows: maxRows } = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM issues WHERE project_id = $1`,
    [projectId]
  );
  const { rows } = await pool.query(
    `INSERT INTO issues (project_id, title, description, status, priority, sprint_id, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      projectId, title, description || null,
      status || "backlog", priority || "medium",
      sprintId || null, maxRows[0].next_order,
    ]
  );
  const issue = rows[0];
  return `Created issue: [${issue.priority}] "${issue.title}" [${issue.status}]\nID: ${issue.id}`;
}

export async function updateIssue(issueId, updates) {
  const sets = [];
  const vals = [];
  let i = 1;
  const fieldMap = { sprintId: "sprint_id", assignedTo: "assigned_to" };
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      const col = fieldMap[key] || key;
      sets.push(`${col} = $${i}`);
      vals.push(val === "" ? null : val);
      i++;
    }
  }
  if (!sets.length) return "Nothing to update.";
  sets.push(`updated_at = now()`);
  vals.push(issueId);

  const { rows } = await pool.query(
    `UPDATE issues SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return "Issue not found.";
  const issue = rows[0];
  return `Updated: [${issue.priority}] "${issue.title}" [${issue.status}]\nID: ${issue.id}`;
}

export async function deleteIssue(issueId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM tasks WHERE issue_id = $1`, [issueId]
  );
  if (rows[0].count > 0) {
    return `Cannot delete: issue still has ${rows[0].count} task(s). Delete all tasks first.`;
  }
  // Activity log is cleaned up automatically (CASCADE on activity_log FK)
  const { rowCount } = await pool.query(`DELETE FROM issues WHERE id = $1`, [issueId]);
  if (!rowCount) return "Issue not found.";
  return "Issue deleted.";
}

// ── Dependencies ──

export async function addDependency(issueId, dependsOnId) {
  // Verify both issues exist
  const { rows: issues } = await pool.query(
    `SELECT id, title FROM issues WHERE id = ANY($1)`, [[issueId, dependsOnId]]
  );
  if (issues.length < 2) return "One or both issues not found.";
  if (issueId === dependsOnId) return "An issue cannot depend on itself.";

  // Check for circular dependency (would dependsOnId already depend on issueId?)
  const { rows: circular } = await pool.query(
    `WITH RECURSIVE chain AS (
       SELECT depends_on_id FROM dependencies WHERE issue_id = $1
       UNION
       SELECT d.depends_on_id FROM dependencies d JOIN chain c ON d.issue_id = c.depends_on_id
     )
     SELECT 1 FROM chain WHERE depends_on_id = $2 LIMIT 1`,
    [dependsOnId, issueId]
  );
  if (circular.length) return "Cannot add: this would create a circular dependency.";

  try {
    await pool.query(
      `INSERT INTO dependencies (issue_id, depends_on_id) VALUES ($1, $2)`,
      [issueId, dependsOnId]
    );
  } catch (e) {
    if (e.code === "23505") return "Dependency already exists.";
    throw e;
  }

  const issueMap = Object.fromEntries(issues.map((i) => [i.id, i.title]));
  return `Dependency added: "${issueMap[issueId]}" depends on "${issueMap[dependsOnId]}"`;
}

export async function removeDependency(issueId, dependsOnId) {
  const { rowCount } = await pool.query(
    `DELETE FROM dependencies WHERE issue_id = $1 AND depends_on_id = $2`,
    [issueId, dependsOnId]
  );
  if (!rowCount) return "Dependency not found.";
  return "Dependency removed.";
}

export async function listDependencies(issueId) {
  const { rows: issue } = await pool.query(`SELECT title FROM issues WHERE id = $1`, [issueId]);
  if (!issue.length) return "Issue not found.";

  const { rows: dependsOn } = await pool.query(
    `SELECT i.id, i.title, i.status, i.priority
     FROM dependencies d JOIN issues i ON i.id = d.depends_on_id
     WHERE d.issue_id = $1 ORDER BY i.sort_order`,
    [issueId]
  );

  const { rows: dependedOnBy } = await pool.query(
    `SELECT i.id, i.title, i.status, i.priority
     FROM dependencies d JOIN issues i ON i.id = d.issue_id
     WHERE d.depends_on_id = $1 ORDER BY i.sort_order`,
    [issueId]
  );

  let out = `Dependencies for "${issue[0].title}":\n`;

  if (dependsOn.length) {
    const allDone = dependsOn.every((i) => i.status === "done");
    out += `\nBlocked by (${allDone ? "all resolved" : "BLOCKED"}):\n`;
    for (const i of dependsOn) {
      out += `  [${i.status}] [${i.priority}] ${shortId(i.id)} "${i.title}"\n`;
    }
  } else {
    out += `\nBlocked by: nothing\n`;
  }

  if (dependedOnBy.length) {
    out += `\nBlocks:\n`;
    for (const i of dependedOnBy) {
      out += `  [${i.status}] [${i.priority}] ${shortId(i.id)} "${i.title}"\n`;
    }
  } else {
    out += `Blocks: nothing\n`;
  }

  return out.trim();
}

export async function searchIssues(projectId, query, status, priority) {
  let sql = `SELECT * FROM issues WHERE project_id = $1`;
  const vals = [projectId];
  let i = 2;
  if (query) {
    sql += ` AND (title ILIKE $${i} OR description ILIKE $${i})`;
    vals.push(`%${query}%`);
    i++;
  }
  if (status) {
    sql += ` AND status = $${i}`;
    vals.push(status);
    i++;
  }
  if (priority) {
    sql += ` AND priority = $${i}`;
    vals.push(priority);
    i++;
  }
  sql += ` ORDER BY sort_order ASC`;
  const { rows } = await pool.query(sql, vals);
  if (!rows.length) return "No matching issues.";
  return rows
    .map((r) => `[${r.priority}] ${shortId(r.id)} "${r.title}" [${r.status}]${r.assigned_to ? ` (${r.assigned_to})` : ""}`)
    .join("\n");
}

// ── Tasks ──

export async function createTask(issueId, title) {
  const { rows: maxRows } = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM tasks WHERE issue_id = $1`,
    [issueId]
  );
  const { rows } = await pool.query(
    `INSERT INTO tasks (issue_id, title, sort_order) VALUES ($1, $2, $3) RETURNING *`,
    [issueId, title, maxRows[0].next_order]
  );
  return `Added task: "[ ] ${rows[0].title}"\nID: ${rows[0].id}`;
}

export async function updateTask(taskId, updates) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      sets.push(`${key} = $${i}`);
      vals.push(val);
      i++;
    }
  }
  if (!sets.length) return "Nothing to update.";
  vals.push(taskId);
  const { rows } = await pool.query(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return "Task not found.";
  const t = rows[0];
  return `Updated task: [${t.completed ? "x" : " "}] "${t.title}"`;
}

export async function deleteTask(taskId) {
  const { rowCount } = await pool.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
  if (!rowCount) return "Task not found.";
  return "Task deleted.";
}

// ── Activity Log ──

export async function logActivity(issueId, entry, agent) {
  await pool.query(
    `INSERT INTO activity_log (issue_id, entry, agent) VALUES ($1, $2, $3)`,
    [issueId, entry, agent || null]
  );
}

// ── Workflow: get_sprint_context ──

export async function getSprintContext(projectId) {
  // Find active sprint
  const { rows: sprints } = await pool.query(
    `SELECT * FROM sprints WHERE project_id = $1 AND status = 'active' LIMIT 1`,
    [projectId]
  );
  if (!sprints.length) return "No active sprint for this project.";
  const sprint = sprints[0];

  // Get all issues in sprint
  const { rows: issues } = await pool.query(
    `SELECT * FROM issues WHERE sprint_id = $1 ORDER BY sort_order ASC`,
    [sprint.id]
  );

  // Get tasks for in-progress issues
  const inProgressIds = issues.filter((i) => i.status === "in_progress").map((i) => i.id);
  let tasksByIssue = {};
  if (inProgressIds.length) {
    const { rows: tasks } = await pool.query(
      `SELECT * FROM tasks WHERE issue_id = ANY($1) ORDER BY sort_order ASC`,
      [inProgressIds]
    );
    for (const t of tasks) {
      (tasksByIssue[t.issue_id] ||= []).push(t);
    }
  }

  // Get dependencies for all sprint issues
  const issueIds = issues.map((i) => i.id);
  let blockersByIssue = {};
  if (issueIds.length) {
    const { rows: deps } = await pool.query(
      `SELECT d.issue_id, i.id AS blocker_id, i.title AS blocker_title, i.status AS blocker_status
       FROM dependencies d JOIN issues i ON i.id = d.depends_on_id
       WHERE d.issue_id = ANY($1) AND i.status != 'done'`,
      [issueIds]
    );
    for (const d of deps) {
      (blockersByIssue[d.issue_id] ||= []).push(d);
    }
  }

  // Get recent activity
  let recentActivity = [];
  if (issueIds.length) {
    const { rows } = await pool.query(
      `SELECT a.*, i.title AS issue_title FROM activity_log a
       JOIN issues i ON i.id = a.issue_id
       WHERE a.issue_id = ANY($1)
       ORDER BY a.created_at DESC LIMIT 10`,
      [issueIds]
    );
    recentActivity = rows;
  }

  // Group issues by status
  const groups = { in_progress: [], todo: [], backlog: [], done: [], cancelled: [] };
  for (const issue of issues) {
    (groups[issue.status] ||= []).push(issue);
  }

  // Sort non-done groups by priority
  for (const key of ["in_progress", "todo", "backlog"]) {
    groups[key].sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 4) - (PRIORITY_ORDER[b.priority] ?? 4));
  }

  const total = issues.length;
  const doneCount = groups.done.length;
  const ipCount = groups.in_progress.length;
  const todoCount = groups.todo.length + groups.backlog.length;

  const dates = sprint.start_date && sprint.end_date
    ? ` (${formatDate(sprint.start_date)} - ${formatDate(sprint.end_date)})`
    : "";

  let out = `SPRINT: "${sprint.name}"${dates} [active]\n`;
  if (sprint.goal) out += `GOAL: ${sprint.goal}\n`;
  out += `PROGRESS: ${doneCount}/${total} done | ${ipCount} in_progress | ${todoCount} todo\n`;

  // In Progress
  if (groups.in_progress.length) {
    out += `\n--- IN PROGRESS ---\n`;
    for (const issue of groups.in_progress) {
      out += `[${issue.priority}] ${shortId(issue.id)} "${issue.title}"`;
      if (issue.assigned_to) out += ` (agent: ${issue.assigned_to})`;
      out += `\n`;
      if (issue.branch) out += `  Branch: ${issue.branch}\n`;
      const tasks = tasksByIssue[issue.id] || [];
      if (tasks.length) {
        const done = tasks.filter((t) => t.completed).length;
        const remaining = tasks.filter((t) => !t.completed);
        out += `  Tasks: ${done}/${tasks.length}`;
        if (remaining.length) out += ` | ${remaining.map((t) => `[ ] ${t.title}`).join(" ")}`;
        out += `\n`;
      }
      // Last activity for this issue
      const lastAct = recentActivity.find((a) => a.issue_id === issue.id);
      if (lastAct) out += `  Last: "${lastAct.entry}" (${relativeTime(lastAct.created_at)})\n`;
    }
  }

  // Todo — split into ready and blocked
  const todoItems = [...groups.backlog, ...groups.todo].sort(
    (a, b) => (PRIORITY_ORDER[a.priority] ?? 4) - (PRIORITY_ORDER[b.priority] ?? 4)
  );
  const readyItems = todoItems.filter((i) => !blockersByIssue[i.id]);
  const blockedItems = todoItems.filter((i) => blockersByIssue[i.id]);

  if (readyItems.length) {
    out += `\n--- TODO (ready) ---\n`;
    for (const issue of readyItems) {
      out += `[${issue.priority}] ${shortId(issue.id)} "${issue.title}"\n`;
    }
  }
  if (blockedItems.length) {
    out += `\n--- BLOCKED ---\n`;
    for (const issue of blockedItems) {
      const blockers = blockersByIssue[issue.id];
      const blockerNames = blockers.map((b) => `"${b.blocker_title}"`).join(", ");
      out += `[${issue.priority}] ${shortId(issue.id)} "${issue.title}" <- waiting on ${blockerNames}\n`;
    }
  }

  // Done
  if (groups.done.length) {
    out += `\n--- DONE ---\n`;
    for (const issue of groups.done) {
      out += `${shortId(issue.id)} "${issue.title}"\n`;
    }
  }

  // Cancelled
  if (groups.cancelled.length) {
    out += `\n--- CANCELLED ---\n`;
    for (const issue of groups.cancelled) {
      out += `${shortId(issue.id)} "${issue.title}"\n`;
    }
  }

  // Recent activity
  if (recentActivity.length) {
    out += `\n--- RECENT ACTIVITY ---\n`;
    for (const a of recentActivity.slice(0, 5)) {
      out += `${relativeTime(a.created_at)} [${shortId(a.issue_id)}] "${a.entry}"`;
      if (a.agent) out += ` (${a.agent})`;
      out += `\n`;
    }
  }

  return out.trim();
}

// ── Workflow: sprint_summary ──

export async function sprintSummary(projectId) {
  const { rows: sprints } = await pool.query(
    `SELECT * FROM sprints WHERE project_id = $1 AND status = 'active' LIMIT 1`,
    [projectId]
  );
  if (!sprints.length) return "No active sprint for this project.";
  const sprint = sprints[0];

  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS count FROM issues WHERE sprint_id = $1 GROUP BY status`,
    [sprint.id]
  );
  const counts = { backlog: 0, todo: 0, in_progress: 0, done: 0, cancelled: 0 };
  for (const r of rows) counts[r.status] = r.count;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pct = total ? Math.round((counts.done / total) * 100) : 0;

  const dates = sprint.start_date && sprint.end_date
    ? ` | ${formatDate(sprint.start_date)} - ${formatDate(sprint.end_date)}`
    : "";

  let out = `Sprint "${sprint.name}"${dates}`;
  if (sprint.goal) out += ` | Goal: ${sprint.goal}`;
  out += `\n`;
  out += `done:${counts.done} in_progress:${counts.in_progress} todo:${counts.todo} backlog:${counts.backlog} cancelled:${counts.cancelled} | ${pct}% complete\n`;

  // Active issues
  const { rows: active } = await pool.query(
    `SELECT * FROM issues WHERE sprint_id = $1 AND status = 'in_progress' ORDER BY sort_order ASC`,
    [sprint.id]
  );
  if (active.length) {
    const parts = active.map(
      (i) => `"${i.title}" [${i.priority}]${i.assigned_to ? ` (${i.assigned_to})` : ""}`
    );
    out += `Active: ${parts.join(" | ")}\n`;
  }

  // Next up
  const { rows: next } = await pool.query(
    `SELECT * FROM issues WHERE sprint_id = $1 AND status IN ('todo', 'backlog') AND assigned_to IS NULL
     ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, sort_order ASC
     LIMIT 1`,
    [sprint.id]
  );
  if (next.length) {
    out += `Next: "${next[0].title}" [${next[0].priority}]`;
  }

  return out.trim();
}

// ── Workflow: claim_next ──

export async function claimNext(projectId, agentId, preferIssueId, branch) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Find active sprint
    const { rows: sprints } = await client.query(
      `SELECT id FROM sprints WHERE project_id = $1 AND status = 'active' LIMIT 1`,
      [projectId]
    );
    if (!sprints.length) {
      await client.query("ROLLBACK");
      return "No active sprint for this project.";
    }

    let issue;
    if (preferIssueId) {
      // Claim specific issue
      const { rows } = await client.query(
        `SELECT * FROM issues WHERE id = $1 AND status IN ('todo', 'backlog') FOR UPDATE SKIP LOCKED`,
        [preferIssueId]
      );
      issue = rows[0];
      if (!issue) {
        await client.query("ROLLBACK");
        return "Issue not found or already claimed.";
      }
      // Check dependencies
      const { rows: blockers } = await client.query(
        `SELECT i.id, i.title, i.status FROM dependencies d
         JOIN issues i ON i.id = d.depends_on_id
         WHERE d.issue_id = $1 AND i.status != 'done'`,
        [preferIssueId]
      );
      if (blockers.length) {
        await client.query("ROLLBACK");
        const list = blockers.map((b) => `  [${b.status}] ${shortId(b.id)} "${b.title}"`).join("\n");
        return `Cannot claim: issue is blocked by ${blockers.length} unresolved dependency/dependencies:\n${list}`;
      }
    } else {
      // Auto-select highest priority unclaimed issue with all dependencies resolved
      const { rows } = await client.query(
        `SELECT i.* FROM issues i
         WHERE i.sprint_id = $1 AND i.status IN ('todo', 'backlog') AND i.assigned_to IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM dependencies d
             JOIN issues blocker ON blocker.id = d.depends_on_id
             WHERE d.issue_id = i.id AND blocker.status != 'done'
           )
         ORDER BY CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                  i.sort_order ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [sprints[0].id]
      );
      issue = rows[0];
      if (!issue) {
        await client.query("ROLLBACK");
        return "No claimable issues in the active sprint (all are claimed, done, or blocked by dependencies).";
      }
    }

    // Claim it
    await client.query(
      `UPDATE issues SET status = 'in_progress', assigned_to = $1, branch = $2, updated_at = now() WHERE id = $3`,
      [agentId, branch || null, issue.id]
    );

    // Log activity
    await client.query(
      `INSERT INTO activity_log (issue_id, entry, agent) VALUES ($1, $2, $3)`,
      [issue.id, "Started work", agentId]
    );

    // Get tasks
    const { rows: tasks } = await client.query(
      `SELECT * FROM tasks WHERE issue_id = $1 ORDER BY sort_order ASC`,
      [issue.id]
    );

    await client.query("COMMIT");

    let out = `CLAIMED: ${shortId(issue.id)} "${issue.title}" [${issue.priority}]\n`;
    out += `ID: ${issue.id}\n`;
    if (branch) out += `Branch: ${branch}\n`;
    if (issue.description) out += `\n${issue.description}\n`;
    if (tasks.length) {
      out += `\nTasks:\n`;
      for (const t of tasks) {
        out += `- [${t.completed ? "x" : " "}] ${t.title}\n`;
      }
    }
    return out.trim();
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── Workflow: complete_issue ──

export async function completeIssue(issueId, summary) {
  const { rows: issues } = await pool.query(`SELECT * FROM issues WHERE id = $1`, [issueId]);
  if (!issues.length) return "Issue not found.";
  const issue = issues[0];

  // Mark done, clear assignment
  await pool.query(
    `UPDATE issues SET status = 'done', assigned_to = NULL, updated_at = now() WHERE id = $1`,
    [issueId]
  );

  // Complete all tasks
  await pool.query(`UPDATE tasks SET completed = true WHERE issue_id = $1`, [issueId]);

  // Log activity
  await pool.query(
    `INSERT INTO activity_log (issue_id, entry, agent) VALUES ($1, $2, $3)`,
    [issueId, `Completed: ${summary}`, issue.assigned_to]
  );

  // Sprint progress
  let progressLine = "";
  if (issue.sprint_id) {
    const { rows } = await pool.query(
      `SELECT status, count(*)::int AS count FROM issues WHERE sprint_id = $1 GROUP BY status`,
      [issue.sprint_id]
    );
    const counts = { backlog: 0, todo: 0, in_progress: 0, done: 0, cancelled: 0 };
    for (const r of rows) counts[r.status] = r.count;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const pct = total ? Math.round((counts.done / total) * 100) : 0;
    progressLine = `Sprint: ${counts.done}/${total} done (${pct}%) | ${counts.in_progress} in_progress | ${counts.todo + counts.backlog} todo`;
  }

  let out = `DONE: "${issue.title}"\nLogged: "${summary}"`;
  if (progressLine) out += `\n${progressLine}`;
  return out;
}

// ── Workflow: log_progress ──

export async function logProgress(issueId, note, agentId, completeTaskIds) {
  const { rows: issues } = await pool.query(`SELECT title FROM issues WHERE id = $1`, [issueId]);
  if (!issues.length) return "Issue not found.";

  await logActivity(issueId, note, agentId);

  // Complete specified tasks
  if (completeTaskIds && completeTaskIds.length) {
    await pool.query(
      `UPDATE tasks SET completed = true WHERE id = ANY($1) AND issue_id = $2`,
      [completeTaskIds, issueId]
    );
  }

  // Task progress
  const { rows: tasks } = await pool.query(
    `SELECT completed FROM tasks WHERE issue_id = $1`,
    [issueId]
  );
  let taskLine = "";
  if (tasks.length) {
    const done = tasks.filter((t) => t.completed).length;
    taskLine = `\nTasks: ${done}/${tasks.length} completed`;
  }

  return `Logged on "${issues[0].title}": "${note}"${taskLine}`;
}

// ── Workflow: plan_sprint ──

export async function planSprint(sprintId, issueSpecs) {
  const { rows: sprints } = await pool.query(`SELECT * FROM sprints WHERE id = $1`, [sprintId]);
  if (!sprints.length) return "Sprint not found.";

  let added = 0;
  for (const spec of issueSpecs) {
    const sets = [`sprint_id = $1`, `updated_at = now()`];
    const vals = [sprintId];
    let i = 2;

    if (spec.priority) {
      sets.push(`priority = $${i}`);
      vals.push(spec.priority);
      i++;
    }

    // Move from backlog to todo
    sets.push(`status = CASE WHEN status = 'backlog' THEN 'todo' ELSE status END`);

    vals.push(spec.issue_id);
    await pool.query(`UPDATE issues SET ${sets.join(", ")} WHERE id = $${i}`, vals);
    added++;
  }

  // Return sprint overview
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS count FROM issues WHERE sprint_id = $1 GROUP BY status`,
    [sprintId]
  );
  const counts = { backlog: 0, todo: 0, in_progress: 0, done: 0, cancelled: 0 };
  for (const r of rows) counts[r.status] = r.count;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return `Added ${added} issue(s) to sprint "${sprints[0].name}".\nSprint now has ${total} issues: ${counts.todo} todo, ${counts.in_progress} in_progress, ${counts.done} done`;
}

// ── Workflow: backlog ──

export async function getBacklog(projectId) {
  const { rows } = await pool.query(
    `SELECT * FROM issues WHERE project_id = $1 AND sprint_id IS NULL
     ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
              sort_order ASC`,
    [projectId]
  );
  if (!rows.length) return "Backlog is empty.";
  return `BACKLOG (${rows.length} issues):\n` +
    rows.map((r) => `[${r.priority}] ${shortId(r.id)} "${r.title}" [${r.status}]\n  ID: ${r.id}`).join("\n");
}

// ── Issue detail ──

export async function getIssueDetail(issueId) {
  const { rows: issues } = await pool.query(`SELECT * FROM issues WHERE id = $1`, [issueId]);
  if (!issues.length) return "Issue not found.";
  const issue = issues[0];

  const { rows: tasks } = await pool.query(
    `SELECT * FROM tasks WHERE issue_id = $1 ORDER BY sort_order ASC`,
    [issueId]
  );
  const { rows: activity } = await pool.query(
    `SELECT * FROM activity_log WHERE issue_id = $1 ORDER BY created_at DESC`,
    [issueId]
  );

  let out = `ISSUE: "${issue.title}" [${issue.status}] [${issue.priority}]\n`;
  out += `ID: ${issue.id}\n`;
  if (issue.assigned_to) out += `Assigned: ${issue.assigned_to}\n`;
  if (issue.branch) out += `Branch: ${issue.branch}\n`;
  if (issue.sprint_id) out += `Sprint: ${issue.sprint_id}\n`;
  if (issue.description) out += `\n${issue.description}\n`;

  if (tasks.length) {
    const done = tasks.filter((t) => t.completed).length;
    out += `\nTasks (${done}/${tasks.length}):\n`;
    for (const t of tasks) {
      out += `- [${t.completed ? "x" : " "}] ${t.title} (${t.id})\n`;
    }
  }

  if (activity.length) {
    out += `\nActivity:\n`;
    for (const a of activity) {
      out += `${relativeTime(a.created_at)} "${a.entry}"`;
      if (a.agent) out += ` (${a.agent})`;
      out += `\n`;
    }
  }

  return out.trim();
}
