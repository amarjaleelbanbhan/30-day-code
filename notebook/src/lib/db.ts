import { Pool, type PoolClient, type QueryResultRow } from "pg";

const globalForPool = globalThis as unknown as { __nbPool?: Pool };

export function pool(): Pool {
  if (!globalForPool.__nbPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForPool.__nbPool = new Pool({ connectionString: url, max: 10 });
  }
  return globalForPool.__nbPool;
}

export async function q<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool().query<T>(sql, params)).rows;
}

export async function q1<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
  return (await pool().query<T>(sql, params)).rows[0] ?? null;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
