import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import type { DatabaseClient } from "@openmuse/db";
import { authAccounts, authSessions, authVerifications, users } from "@openmuse/db";
import { and, eq } from "drizzle-orm";

export interface OpenMuseAuthConfig {
  secret: string;
  baseURL: string;
  trustedOrigins: readonly string[];
  /** A one-shot operator secret used only by the explicit bootstrap command. */
  bootstrapToken?: string;
  secureCookies?: boolean;
  google?: { clientId: string; clientSecret: string };
  environment?: "development" | "test" | "production";
}

export interface RequestIdentity {
  userId: string;
  email: string;
  name?: string;
  sessionId: string;
  createdAt?: Date;
  lastSeenAt?: Date;
  expiresAt: Date;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
    readonly code = "unauthenticated",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface OpenMuseAuth {
  readonly auth: ReturnType<typeof betterAuth>;
  readonly handler: (request: Request) => Promise<Response>;
  getIdentity(request: Request): Promise<RequestIdentity>;
  revokeSession(request: Request, sessionId: string): Promise<void>;
  acceptInvite(input: { token: string; userId: string; email: string }): Promise<string>;
  bootstrapFirstUser(input: {
    token: string;
    email: string;
    password: string;
    name?: string;
  }): Promise<{ id: string; email: string; name?: string }>;
}

function validateConfig(config: OpenMuseAuthConfig): void {
  if (config.secret.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters");
  if (!/^https?:\/\//.test(config.baseURL))
    throw new Error("AUTH_URL must be an absolute http(s) URL");
  if (config.trustedOrigins.length === 0)
    throw new Error("At least one trusted auth origin is required");
  if (config.environment === "production" && config.baseURL.startsWith("http://")) {
    throw new Error("Production Better Auth must use an HTTPS base URL");
  }
}

function hashInvite(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInvite(token) };
}

/**
 * Better Auth is the only session issuer. No local-user, development bypass,
 * or static bearer key is accepted by this package. Public sign-up is disabled;
 * the first account must be created by an explicitly controlled bootstrap
 * process, after which workspace invites grant membership.
 */
export function createOpenMuseAuth(db: DatabaseClient, config: OpenMuseAuthConfig): OpenMuseAuth {
  validateConfig(config);
  const options: BetterAuthOptions = {
    database: drizzleAdapter(db.db, {
      provider: "pg",
      schema: {
        user: users,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [...config.trustedOrigins],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    advanced: {
      useSecureCookies: config.secureCookies ?? config.environment === "production",
    },
    // Native Expo clients keep this session token in SecureStore and send it
    // as Authorization: Bearer. Better Auth's bearer plugin validates that
    // header and projects it into the normal session lookup path.
    plugins: [bearer()],
    ...(config.google
      ? {
          socialProviders: {
            google: {
              clientId: config.google.clientId,
              clientSecret: config.google.clientSecret,
            },
          },
        }
      : {}),
  };
  const auth = betterAuth(options);
  return {
    auth,
    handler: (request) => auth.handler(request),
    async getIdentity(request) {
      const result = await auth.api.getSession({ headers: request.headers });
      if (!result?.user || !result.session) throw new AuthError("Sign in to OpenMuse");
      const user = result.user as { id: string; email: string; name?: string | null };
      const session = result.session as {
        id: string;
        expiresAt: Date | string;
        createdAt?: Date | string;
        updatedAt?: Date | string;
      };
      const expiresAt = new Date(session.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
        throw new AuthError("Session expired. Sign in again.");
      }
      return {
        userId: user.id,
        email: user.email,
        ...(user.name ? { name: user.name } : {}),
        sessionId: session.id,
        ...(session.createdAt ? { createdAt: new Date(session.createdAt) } : {}),
        ...(session.updatedAt ? { lastSeenAt: new Date(session.updatedAt) } : {}),
        expiresAt,
      };
    },
    async acceptInvite(input) {
      if (!input.token || !input.userId || !input.email)
        throw new AuthError("Invite details are required", 400, "invalid_request");
      const workspaceResult = await db.sql.begin(async (transaction) => {
        const [row] = await transaction<{ workspace_id: string }[]>`
          select openmuse_accept_invite(${hashInvite(input.token)}, ${input.userId}, ${input.email}) as workspace_id
        `;
        return row?.workspace_id;
      });
      if (!workspaceResult)
        throw new AuthError("Invite is invalid or expired", 400, "invalid_request");
      return workspaceResult;
    },
    async revokeSession(request, sessionId) {
      const identity = await this.getIdentity(request);
      const rows = await db.db
        .select({ token: authSessions.token })
        .from(authSessions)
        .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, identity.userId)))
        .limit(1);
      const token = rows[0]?.token;
      if (!token) throw new AuthError("Session not found", 404, "not_found");
      await auth.api.revokeSession({ headers: request.headers, body: { token } });
    },
    async bootstrapFirstUser(input) {
      if (!config.bootstrapToken || !safeEqualSecret(config.bootstrapToken, input.token))
        throw new AuthError("Bootstrap authorization failed", 403, "forbidden");
      if (!input.email.trim() || input.password.length < 12)
        throw new AuthError(
          "A valid email and a 12-character password are required",
          400,
          "invalid_request",
        );

      // This method is deliberately not exposed through `handler`. It creates
      // a short-lived Better Auth instance with sign-up enabled only for the
      // operator-controlled CLI. Public requests continue to use the normal
      // instance above, where sign-up is disabled.
      const bootstrapAuth = betterAuth({
        ...options,
        emailAndPassword: { enabled: true, disableSignUp: false },
      });
      // Serialize the empty-database check and first sign-up with a
      // transaction-scoped advisory lock. Better Auth performs its writes on
      // the shared auth pool, so the lock is acquired through a separate,
      // short-lived connection; this remains safe when that pool has only one
      // connection. A second operator observes the committed first user
      // instead of racing into a second account.
      return db.withAdvisoryLock("openmuse.bootstrap.first-user", async () => {
        const existing = await db.sql<{ id: string }[]>`
          select id from users limit 1
        `;
        if (existing.length > 0)
          throw new AuthError(
            "The OpenMuse account has already been bootstrapped",
            409,
            "conflict",
          );

        const result = (await bootstrapAuth.api.signUpEmail({
          body: {
            email: input.email.trim().toLowerCase(),
            password: input.password,
            name: input.name?.trim() || input.email.trim().split("@")[0] || "OpenMuse user",
          },
        })) as unknown as {
          user?: { id?: string; email?: string; name?: string | null };
        };
        if (!result.user?.id || !result.user.email)
          throw new AuthError("The bootstrap account could not be created", 500, "internal");
        return {
          id: result.user.id,
          email: result.user.email,
          ...(result.user.name ? { name: result.user.name } : {}),
        };
      });
    },
  };
}

export function safeEqualSecret(expected: string, supplied: string): boolean {
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(left, right);
}
