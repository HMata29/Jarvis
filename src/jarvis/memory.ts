export type MemoryCategory =
  | "personal"
  | "preference"
  | "work"
  | "project"
  | "technical"
  | "routine"
  | "other";

export type MemorySource = "explicit";

export interface MemoryRecord {
  id: string;
  content: string;
  category: MemoryCategory;
  source: MemorySource;
  created_at: string;
  updated_at: string;
}

interface SqlAgent {
  sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

function ensureTable(agent: SqlAgent) {
  agent.sql`
    CREATE TABLE IF NOT EXISTS jarvis_memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      source TEXT NOT NULL DEFAULT 'explicit',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;
}

export function rememberMemory(
  agent: SqlAgent,
  content: string,
  category: MemoryCategory = "other"
): MemoryRecord {
  ensureTable(agent);

  const id = crypto.randomUUID();

  agent.sql`
    INSERT INTO jarvis_memories (
      id,
      content,
      category,
      source
    )
    VALUES (
      ${id},
      ${content},
      ${category},
      'explicit'
    )
  `;

  const rows = agent.sql<MemoryRecord>`
    SELECT *
    FROM jarvis_memories
    WHERE id = ${id}
  `;

  return rows[0];
}

export function listMemories(agent: SqlAgent): MemoryRecord[] {
  ensureTable(agent);

  return agent.sql<MemoryRecord>`
    SELECT *
    FROM jarvis_memories
    ORDER BY created_at DESC
  `;
}

export function searchMemories(agent: SqlAgent, query: string): MemoryRecord[] {
  ensureTable(agent);

  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[%_]/g, ""))
    .filter(Boolean);

  if (terms.length === 0) {
    return [];
  }

  const results: MemoryRecord[] = [];

  for (const term of terms) {
    const search = `%${term}%`;

    const rows = agent.sql<MemoryRecord>`
      SELECT *
      FROM jarvis_memories
      WHERE content LIKE ${search}
         OR category LIKE ${search}
      ORDER BY updated_at DESC
      LIMIT 10
    `;

    for (const row of rows) {
      if (!results.some((existing) => existing.id === row.id)) {
        results.push(row);
      }
    }
  }

  return results.slice(0, 10);
}

export function forgetMemory(agent: SqlAgent, id: string): boolean {
  ensureTable(agent);

  const existing = agent.sql<{ id: string }>`
    SELECT id
    FROM jarvis_memories
    WHERE id = ${id}
  `;

  if (existing.length === 0) {
    return false;
  }

  agent.sql`
    DELETE FROM jarvis_memories
    WHERE id = ${id}
  `;

  return true;
}

export function updateMemory(
  agent: SqlAgent,
  id: string,
  content: string,
  category?: MemoryCategory
): MemoryRecord | null {
  ensureTable(agent);

  const existing = agent.sql<{ id: string }>`
    SELECT id
    FROM jarvis_memories
    WHERE id = ${id}
  `;

  if (existing.length === 0) {
    return null;
  }

  if (category !== undefined) {
    agent.sql`
      UPDATE jarvis_memories
      SET
        content = ${content},
        category = ${category},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
    `;
  } else {
    agent.sql`
      UPDATE jarvis_memories
      SET
        content = ${content},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
    `;
  }

  const rows = agent.sql<MemoryRecord>`
    SELECT *
    FROM jarvis_memories
    WHERE id = ${id}
  `;

  return rows[0] ?? null;
}
