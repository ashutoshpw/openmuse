import postgres, { type Options as PostgresOptions, type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema } from "./schema.js";

export type OpenMuseDatabase = PostgresJsDatabase<typeof schema>;

export interface DatabaseClient {
  readonly sql: Sql;
  readonly db: OpenMuseDatabase;
  /**
   * Run a callback while a database-scoped advisory lock is held on a
   * separate, short-lived connection. The separate connection matters for
   * operations whose callback uses this client's pool (for example Better
   * Auth bootstrap with a pool size of one).
   */
  withAdvisoryLock<T>(key: string, callback: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** PostgreSQL connection string. PGlite is intentionally not used here. */
  url: string;
  maxConnections?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
  ssl?: PostgresOptions<{}>["ssl"];
}

/**
 * Create the shared PostgreSQL client. API and worker processes should each
 * create one client and close it on shutdown; repositories never create their
 * own pools.
 */
export function createDatabase(options: DatabaseOptions): DatabaseClient {
  const sql = postgres(options.url, {
    max: options.maxConnections ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
    // RLS context is set with transaction-local set_config. Prepared
    // statements are safe, but disabling them keeps PgBouncer transaction
    // pooling compatible for self-hosted deployments.
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return {
    sql,
    db,
    withAdvisoryLock: async <T>(key: string, callback: () => Promise<T>): Promise<T> => {
      if (!key.trim()) throw new Error("An advisory lock key is required");
      // Do not consume a connection from the caller's pool while the callback
      // runs. A one-connection auth pool must still be able to perform the
      // Better Auth writes protected by this lock.
      const lockSql = postgres(options.url, {
        max: 1,
        idle_timeout: 5,
        connect_timeout: options.connectTimeoutSeconds ?? 10,
        ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
        prepare: false,
      });
      try {
        return (await lockSql.begin(async (transaction) => {
          await transaction`
            select pg_advisory_xact_lock(hashtextextended(${key}, 0))
          `;
          return callback();
        })) as T;
      } finally {
        await lockSql.end({ timeout: 5 });
      }
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export async function pingDatabase(client: DatabaseClient): Promise<void> {
  await client.sql`select 1 as ok`;
}
