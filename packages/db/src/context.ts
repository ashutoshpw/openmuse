import { sql as drizzleSql } from "drizzle-orm";
import type { OpenMuseDatabase } from "./client.js";

/** The identity that must be attached to every tenant transaction. */
export interface TenantScope {
  workspaceId: string;
  actorId: string;
}

/**
 * Infer Drizzle's transaction type without exporting its internal generic
 * configuration. Keeping this type here means callers can compose typed
 * repositories while the package remains portable across Drizzle releases.
 */
export type DbTransaction = Parameters<Parameters<OpenMuseDatabase["transaction"]>[0]>[0];

function assertScope(scope: TenantScope): void {
  if (!scope.workspaceId.trim() || !scope.actorId.trim()) {
    throw new Error("A non-empty workspaceId and actorId are required for a database scope");
  }
}

/**
 * Establish RLS settings transaction-locally. The settings are never applied
 * to a pooled session outside this transaction, preventing actor leakage
 * between concurrent API requests.
 */
export async function withTenantContext<T>(
  db: OpenMuseDatabase,
  scope: TenantScope,
  callback: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  assertScope(scope);
  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`select set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.actor_id', ${scope.actorId}, true)`,
    );
    return callback(tx);
  });
}

/**
 * A scoped handle is deliberately required by repositories. There is no
 * unscoped read/write method for tenant data, which makes accidentally running
 * a query without both RLS settings difficult.
 */
export class ScopedDatabase {
  constructor(
    private readonly db: OpenMuseDatabase,
    readonly scope: TenantScope,
  ) {}

  run<T>(callback: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withTenantContext(this.db, this.scope, callback);
  }
}
