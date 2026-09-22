import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../../../../packages/auth/node_modules/better-auth/dist/crypto/index.mjs";
import { createDatabase, migrateDatabase, type DatabaseClient } from "@openmuse/db";

const migrationDirectory = fileURLToPath(
  new URL("../../../../packages/db/migrations/", import.meta.url),
);

const PASSWORD = "openmuse-integration-password-2026";
const AUTH_MARKER_ROLE = "openmuse_auth_service";

export interface OpenMuseIntegrationHarness {
  readonly admin: DatabaseClient;
  readonly owner: DatabaseClient;
  readonly runtime: DatabaseClient;
  readonly auth: DatabaseClient;
  readonly databaseName: string;
  readonly runtimeRole: string;
  readonly authRole: string;
  readonly password: string;
  readonly ids: {
    userA: string;
    userB: string;
    workspace: string;
    conversation: string;
    run: string;
    message: string;
    approval: string;
    artifact: string;
  };
  close(): Promise<void>;
}

export interface IntegrationDatabaseOptions {
  seed?: boolean;
  ownerMaxConnections?: number;
}

/**
 * Provision a fresh database and two non-owner roles for integration tests.
 *
 * TEST_DATABASE_URL must point at a disposable PostgreSQL database using a
 * role allowed to create databases and roles. The test database itself is
 * created per process and dropped by close(); no existing database is reset.
 * The owner connection applies migrations and fixtures, while runtime/auth
 * connections exercise RLS as ordinary roles.
 */
export async function provisionIntegrationDatabase(
  adminUrl = process.env.TEST_DATABASE_URL,
  options: IntegrationDatabaseOptions = {},
): Promise<OpenMuseIntegrationHarness> {
  if (!adminUrl) throw new Error("TEST_DATABASE_URL is required for database integration tests");

  const admin = createDatabase({ url: adminUrl, connectTimeoutSeconds: 5 });
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const databaseName = `openmuse_it_${suffix}`;
  const runtimeRole = `openmuse_runtime_${suffix}`;
  const authRole = `openmuse_auth_${suffix}`;
  const runtimePassword = randomUUID();
  const authPassword = randomUUID();

  const ownerUrl = withDatabase(adminUrl, databaseName);
  let owner: DatabaseClient | undefined;
  let runtime: DatabaseClient | undefined;
  let auth: DatabaseClient | undefined;
  let databaseCreated = false;
  let rolesCreated = false;
  let authMarkerRoleCreated = false;

  try {
    await admin.sql.unsafe(`create database ${identifier(databaseName)}`);
    databaseCreated = true;

    owner = createDatabase({
      url: ownerUrl,
      maxConnections: options.ownerMaxConnections,
      connectTimeoutSeconds: 5,
    });
    await migrateDatabase(owner.sql, migrationDirectory);

    const markerRoles = await admin.sql<{ exists: boolean }[]>`
      select exists(select 1 from pg_roles where rolname = ${AUTH_MARKER_ROLE}) as exists
    `;
    if (!markerRoles[0]?.exists) {
      await admin.sql.unsafe(`create role ${identifier(AUTH_MARKER_ROLE)} nologin`);
      authMarkerRoleCreated = true;
    }

    await admin.sql.unsafe(
      `create role ${identifier(runtimeRole)} login password ${literal(runtimePassword)} ` +
        "nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls",
    );
    await admin.sql.unsafe(
      `create role ${identifier(authRole)} login password ${literal(authPassword)} ` +
        "nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls",
    );
    await admin.sql.unsafe(`grant ${identifier(AUTH_MARKER_ROLE)} to ${identifier(authRole)}`);
    await admin.sql.unsafe(`alter role ${identifier(authRole)} set app.auth_service = 'true'`);
    rolesCreated = true;

    await grantRuntimePrivileges(owner, runtimeRole);
    await grantAuthPrivileges(owner, authRole);

    runtime = createDatabase({
      url: withCredentials(ownerUrl, runtimeRole, runtimePassword),
      connectTimeoutSeconds: 5,
    });
    auth = createDatabase({
      url: withCredentials(ownerUrl, authRole, authPassword),
      connectTimeoutSeconds: 5,
    });

    const ids = {
      userA: `user-a-${suffix}`,
      userB: `user-b-${suffix}`,
      workspace: `workspace-a-${suffix}`,
      conversation: `conversation-a-${suffix}`,
      run: `run-a-${suffix}`,
      message: `message-a-${suffix}`,
      approval: `approval-a-${suffix}`,
      artifact: `artifact-a-${suffix}`,
    };
    if (options.seed !== false) {
      const passwordHash = await hashPassword(PASSWORD);
      await seedFixtures(owner, ids, passwordHash);
    }

    return {
      admin,
      owner,
      runtime,
      auth,
      databaseName,
      runtimeRole,
      authRole,
      password: PASSWORD,
      ids,
      close: async () => {
        await closeClient(auth);
        await closeClient(runtime);
        await closeClient(owner);
        await admin.sql.unsafe(`drop database if exists ${identifier(databaseName)} with (force)`);
        if (rolesCreated) {
          await admin.sql.unsafe(`drop role if exists ${identifier(runtimeRole)}`);
          await admin.sql.unsafe(`drop role if exists ${identifier(authRole)}`);
        }
        if (authMarkerRoleCreated) {
          await admin.sql.unsafe(`drop role if exists ${identifier(AUTH_MARKER_ROLE)}`);
        }
        await admin.close();
      },
    };
  } catch (error) {
    await closeClient(auth);
    await closeClient(runtime);
    await closeClient(owner);
    if (databaseCreated) {
      await admin.sql
        .unsafe(`drop database if exists ${identifier(databaseName)} with (force)`)
        .catch(() => undefined);
    }
    if (rolesCreated) {
      await admin.sql
        .unsafe(`drop role if exists ${identifier(runtimeRole)}`)
        .catch(() => undefined);
      await admin.sql.unsafe(`drop role if exists ${identifier(authRole)}`).catch(() => undefined);
    }
    if (authMarkerRoleCreated) {
      await admin.sql
        .unsafe(`drop role if exists ${identifier(AUTH_MARKER_ROLE)}`)
        .catch(() => undefined);
    }
    await admin.close();
    throw error;
  }
}

async function grantRuntimePrivileges(owner: DatabaseClient, role: string): Promise<void> {
  const roleName = identifier(role);
  await owner.sql.unsafe(`grant usage on schema public to ${roleName}`);
  await owner.sql.unsafe(
    `grant select, insert, update, delete on all tables in schema public to ${roleName}`,
  );
  await owner.sql.unsafe(`grant usage, select on all sequences in schema public to ${roleName}`);

  const functions = [
    "openmuse_workspace_id()",
    "openmuse_actor_id()",
    "openmuse_is_member(text)",
    "openmuse_can_admin(text)",
    "openmuse_is_bootstrap_owner(text)",
    "openmuse_can_read_snapshot(text)",
    "openmuse_can_grant_snapshot(text)",
    "openmuse_can_read_conversation(text)",
    "openmuse_can_read_conversation_row(text,text,text)",
    "openmuse_can_read_run(text)",
    "openmuse_can_read_task(text)",
    "openmuse_can_read_artifact(text)",
    "openmuse_can_read_approval(text)",
    "openmuse_can_enqueue_task(text,text,text)",
    "openmuse_accept_invite(text,text,text)",
    "openmuse_resolve_conversation_workspace(text,text)",
    "openmuse_list_actor_workspaces(text)",
    "openmuse_resolve_resource_workspace(text,text,text)",
  ];
  for (const fn of functions) {
    await owner.sql.unsafe(`grant execute on function ${fn} to ${roleName}`);
  }
}

async function grantAuthPrivileges(owner: DatabaseClient, role: string): Promise<void> {
  const roleName = identifier(role);
  await owner.sql.unsafe(`grant usage on schema public to ${roleName}`);
  await owner.sql.unsafe(
    `grant select, insert, update, delete on table users, session, account, verification to ${roleName}`,
  );
  await owner.sql.unsafe(`grant usage, select on all sequences in schema public to ${roleName}`);
  await owner.sql.unsafe(
    `grant execute on function openmuse_accept_invite(text,text,text) to ${roleName}`,
  );
}

async function seedFixtures(
  owner: DatabaseClient,
  ids: OpenMuseIntegrationHarness["ids"],
  passwordHash: string,
): Promise<void> {
  const now = new Date().toISOString();
  await owner.sql.begin(async (tx) => {
    await tx`
      insert into users (id, email, name, email_verified, created_at, updated_at)
      values
        (${ids.userA}, ${`a-${ids.userA}@example.test`}, 'User A', true, ${now}, ${now}),
        (${ids.userB}, ${`b-${ids.userB}@example.test`}, 'User B', true, ${now}, ${now})
    `;
    await tx`
      insert into account
        (id, account_id, provider_id, user_id, password, created_at, updated_at)
      values
        (${`account-a-${ids.userA}`}, ${ids.userA}, 'credential', ${ids.userA}, ${passwordHash}, ${now}, ${now}),
        (${`account-b-${ids.userB}`}, ${ids.userB}, 'credential', ${ids.userB}, ${passwordHash}, ${now}, ${now})
    `;
    await tx`
      insert into workspaces (id, name, slug, created_by, settings, created_at, updated_at)
      values (${ids.workspace}, 'Workspace A', ${`workspace-a-${ids.workspace}`.replaceAll("_", "-")}, ${ids.userA}, '{}'::jsonb, ${now}, ${now})
    `;
    await tx`
      insert into workspace_members
        (workspace_id, user_id, role, status, invited_by, created_at, updated_at)
      values
        (${ids.workspace}, ${ids.userA}, 'owner', 'active', ${ids.userA}, ${now}, ${now}),
        (${ids.workspace}, ${ids.userB}, 'member', 'active', ${ids.userA}, ${now}, ${now})
    `;
    await tx`
      insert into conversations
        (id, workspace_id, created_by, title, visibility, status, metadata, created_at, updated_at)
      values
        (${ids.conversation}, ${ids.workspace}, ${ids.userA}, 'Private fixture', 'private', 'active', '{}'::jsonb, ${now}, ${now})
    `;
    await tx`
      insert into conversation_members
        (conversation_id, user_id, permission, added_by, created_at)
      values (${ids.conversation}, ${ids.userA}, 'owner', ${ids.userA}, ${now})
    `;
    await tx`
      insert into runs
        (id, workspace_id, conversation_id, requested_by, status, provider, created_at, updated_at)
      values
        (${ids.run}, ${ids.workspace}, ${ids.conversation}, ${ids.userA}, 'succeeded', 'fixture', ${now}, ${now})
    `;
    await tx`
      insert into run_events
        (run_id, workspace_id, sequence, event_type, payload, created_at)
      values (${ids.run}, ${ids.workspace}, 1, 'completed', '{"fixture":true}'::jsonb, ${now})
    `;
    await tx`
      insert into messages
        (id, workspace_id, conversation_id, author_id, role, status, sequence, content, created_at, updated_at)
      values
        (${ids.message}, ${ids.workspace}, ${ids.conversation}, ${ids.userA}, 'user', 'complete', 1,
          '[{"type":"text","text":"private fixture"}]'::jsonb, ${now}, ${now})
    `;
    await tx`
      insert into approvals
        (id, workspace_id, run_id, requested_by, action_type, payload, payload_hash, nonce, digest, expires_at, created_at)
      values
        (${ids.approval}, ${ids.workspace}, ${ids.run}, ${ids.userA}, 'fixture.action',
          '{"fixture":true}'::jsonb, repeat('b', 64), repeat('c', 32), repeat('d', 64),
          now() + interval '1 hour', ${now})
    `;
    await tx`
      insert into artifacts
        (id, workspace_id, created_by, kind, run_id, name, storage_key, content_type, byte_size, checksum, metadata, created_at)
      values
        (${ids.artifact}, ${ids.workspace}, ${ids.userA}, 'file', ${ids.run}, 'private.txt', ${`private/${ids.artifact}`},
          'text/plain', 14, repeat('a', 64), '{}'::jsonb, ${now})
    `;
    await tx`
      insert into provider_credentials
        (id, workspace_id, user_id, provider, credential_kind, encrypted_value, key_version, status, created_at, updated_at)
      values
        (${`credential-a-${ids.userA}`}, ${ids.workspace}, ${ids.userA}, 'fixture', 'api_key',
          'encrypted-fixture-value', 1, 'revoked', ${now}, ${now})
    `;
  });
}

async function closeClient(client: DatabaseClient | undefined): Promise<void> {
  await client?.close().catch(() => undefined);
}

function withDatabase(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function withCredentials(url: string, username: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}

function identifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
