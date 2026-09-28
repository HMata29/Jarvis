export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskScheduleType = "scheduled" | "delayed" | "cron";

export interface TaskRecord {
  id: string;
  description: string;
  status: TaskStatus;
  scheduleType: TaskScheduleType;
  scheduleInput: string | number;
  scheduleId?: string;
  recurring: boolean;
  createdAt: string;
  updatedAt: string;
  executedAt?: string;
  error?: string;
}

interface SqlAgent {
  sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

function ensureTable(agent: SqlAgent) {
  agent.sql`
    CREATE TABLE IF NOT EXISTS jarvis_tasks (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      schedule_type TEXT NOT NULL,
      schedule_input TEXT NOT NULL,
      schedule_id TEXT,
      recurring INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      executed_at DATETIME,
      error TEXT
    )
  `;
}

function toTaskRecord(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    description: String(row.description),
    status: row.status as TaskStatus,
    scheduleType: row.schedule_type as TaskScheduleType,
    scheduleInput:
      typeof row.schedule_input === "string" && row.schedule_type === "delayed"
        ? Number(row.schedule_input)
        : String(row.schedule_input),
    ...(row.schedule_id ? { scheduleId: String(row.schedule_id) } : {}),
    recurring: Boolean(row.recurring),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.executed_at ? { executedAt: String(row.executed_at) } : {}),
    ...(row.error ? { error: String(row.error) } : {})
  };
}

export function createTask(
  agent: SqlAgent,
  input: {
    description: string;
    scheduleType: TaskScheduleType;
    scheduleInput: string | number;
    recurring?: boolean;
  }
): TaskRecord {
  ensureTable(agent);

  const id = crypto.randomUUID();

  agent.sql`
    INSERT INTO jarvis_tasks (
      id,
      description,
      status,
      schedule_type,
      schedule_input,
      recurring
    )
    VALUES (
      ${id},
      ${input.description},
      'pending',
      ${input.scheduleType},
      ${String(input.scheduleInput)},
      ${input.recurring ? 1 : 0}
    )
  `;

  return getTask(agent, id)!;
}

export function getTask(agent: SqlAgent, id: string): TaskRecord | null {
  ensureTable(agent);

  const rows = agent.sql`
    SELECT *
    FROM jarvis_tasks
    WHERE id = ${id}
  `;

  return rows.length > 0 ? toTaskRecord(rows[0]) : null;
}

export function listTasks(agent: SqlAgent, status?: TaskStatus): TaskRecord[] {
  ensureTable(agent);

  const rows = status
    ? agent.sql`
        SELECT *
        FROM jarvis_tasks
        WHERE status = ${status}
        ORDER BY created_at DESC
      `
    : agent.sql`
        SELECT *
        FROM jarvis_tasks
        ORDER BY created_at DESC
      `;

  return rows.map(toTaskRecord);
}

export function attachScheduleToTask(
  agent: SqlAgent,
  id: string,
  scheduleId: string
): TaskRecord | null {
  ensureTable(agent);

  const existing = getTask(agent, id);

  if (!existing) {
    return null;
  }

  agent.sql`
    UPDATE jarvis_tasks
    SET
      schedule_id = ${scheduleId},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `;

  return getTask(agent, id);
}

export function markTaskRunning(
  agent: SqlAgent,
  id: string
): TaskRecord | null {
  ensureTable(agent);

  const existing = getTask(agent, id);

  if (!existing) {
    return null;
  }

  if (existing.status === "cancelled" || existing.status === "completed") {
    return existing;
  }

  agent.sql`
    UPDATE jarvis_tasks
    SET
      status = 'running',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `;

  return getTask(agent, id);
}

export function markTaskCompleted(
  agent: SqlAgent,
  id: string
): TaskRecord | null {
  ensureTable(agent);

  const existing = getTask(agent, id);

  if (!existing) {
    return null;
  }

  if (existing.recurring) {
    agent.sql`
      UPDATE jarvis_tasks
      SET
        status = 'pending',
        updated_at = CURRENT_TIMESTAMP,
        executed_at = CURRENT_TIMESTAMP,
        error = NULL
      WHERE id = ${id}
    `;
  } else {
    agent.sql`
      UPDATE jarvis_tasks
      SET
        status = 'completed',
        updated_at = CURRENT_TIMESTAMP,
        executed_at = CURRENT_TIMESTAMP,
        error = NULL
      WHERE id = ${id}
    `;
  }

  return getTask(agent, id);
}

export function markTaskFailed(
  agent: SqlAgent,
  id: string,
  error: string
): TaskRecord | null {
  ensureTable(agent);

  const existing = getTask(agent, id);

  if (!existing) {
    return null;
  }

  agent.sql`
    UPDATE jarvis_tasks
    SET
      status = 'failed',
      updated_at = CURRENT_TIMESTAMP,
      executed_at = CURRENT_TIMESTAMP,
      error = ${error}
    WHERE id = ${id}
  `;

  return getTask(agent, id);
}

export function cancelTask(agent: SqlAgent, id: string): TaskRecord | null {
  ensureTable(agent);

  const existing = getTask(agent, id);

  if (!existing) {
    return null;
  }

  if (existing.status === "completed") {
    return existing;
  }

  agent.sql`
    UPDATE jarvis_tasks
    SET
      status = 'cancelled',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `;

  return getTask(agent, id);
}
