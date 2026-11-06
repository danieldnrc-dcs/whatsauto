import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { config } from "./config.ts";

// One pool per process. Tests may place their own pool on globalThis.__pool.
const g = globalThis as unknown as { __pool?: pg.Pool };

function pool(): pg.Pool {
  if (!g.__pool) {
    const url = config.databaseUrl;
    const local = /@(127\.0\.0\.1|localhost|postgres|db)(:\d+)?\//.test(url);
    g.__pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX || 5),
      connectionTimeoutMillis: 10_000,
      query_timeout: 25_000,
      // Remote databases: always verify the server certificate.
      ssl: local ? undefined : { rejectUnauthorized: true },
    });
    g.__pool.on("error", (e) => console.error("database pool:", e.message));
  }
  return g.__pool;
}

export async function q<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool().query<T>(sql, params as any[])).rows;
}
export async function q1<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(sql, params))[0] ?? null;
}
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
export async function closeDb() {
  await g.__pool?.end();
  g.__pool = undefined;
}
