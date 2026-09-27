export interface MemoryRecord {
  id: string;
  content: string;
  category: string;
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
      category TEXT NOT NULL DEFAULT 'general',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;
}

export function rememberMemory(
  agent: SqlAgent,
  content: string,
  category = "general"
): MemoryRecord {
  ensureTable(agent);

  const id = crypto.randomUUID();

  agent.sql`
    INSERT INTO jarvis_memories (
      id,
      content,
      category
    )
    VALUES (
      ${id},
      ${content},
      ${category}
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

  const search = `%${query}%`;

  return agent.sql<MemoryRecord>`
    SELECT *
    FROM jarvis_memories
    WHERE content LIKE ${search}
       OR category LIKE ${search}
    ORDER BY updated_at DESC
    LIMIT 10
  `;
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
  category?: string
): boolean {
  ensureTable(agent);

  const existing = agent.sql<{ id: string }>`
    SELECT id
    FROM jarvis_memories
    WHERE id = ${id}
  `;

  if (existing.length === 0) {
    return false;
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

  return true;
}
