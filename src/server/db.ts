import "server-only";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";
import { pgSsl } from "@/lib/pg-ssl";

declare global {
  var __pgPool: Pool | undefined;
}

function makePool() {
  const url = env.DATABASE_URL;
  return new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    ssl: pgSsl(url),
  });
}

export const pool: Pool = globalThis.__pgPool ?? (globalThis.__pgPool = makePool());

export type Q = {
  <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T | null>;
  client: PoolClient;
  userId: string | null;
};

function wrap(client: PoolClient, userId: string | null): Q {
  const q = (async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows) as Q;
  q.one = async (sql, params = []) => {
    const r = await client.query(sql, params);
    return (r.rows[0] as never) ?? null;
  };
  q.client = client;
  q.userId = userId;
  return q;
}

async function inTx<T>(setup: (c: PoolClient) => Promise<void>, fn: (q: Q) => Promise<T>, userId: string | null): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setup(client);
    const out = await fn(wrap(client, userId));
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Runs fn in a transaction with RLS context of the given user. */
export function withUser<T>(userId: string, fn: (q: Q) => Promise<T>): Promise<T> {
  return inTx(async (c) => {
    await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.system', '', true)", [userId]);
  }, fn, userId);
}

/** Runs fn with system context (bypasses RLS policies). Use only for auth bootstrap, cron and purge jobs. */
export function withSystem<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return inTx(async (c) => {
    await c.query("SELECT set_config('app.system', 'on', true), set_config('app.user_id', '', true)");
  }, fn, null);
}
