import { z } from "zod";
import {
  apiErrorSchema,
  connectionStatusSchema,
  digestSchema,
  errorCodeSchema,
  eventTypeSchema,
  idSchema,
  jsonObjectSchema,
  jsonValueSchema,
  memoryScopeSchema,
  nonEmptyTextSchema,
  pageInfoSchema,
  providerModuleSchema,
  providerCredentialScopeSchema,
  providerCredentialStatusSchema,
  providerInstanceScopeSchema,
  providerStatusSchema,
  roleSchema,
  runStatusSchema,
  safeNameSchema,
  timestampSchema,
  visibilitySchema,
} from "./common.js";

const baseResourceSchema = z.object({
  id: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const sessionSchema = baseResourceSchema.extend({
  userId: idSchema,
  expiresAt: timestampSchema,
  lastSeenAt: timestampSchema,
  revokedAt: timestampSchema.nullable(),
  device: z
    .object({
      id: idSchema.optional(),
      name: safeNameSchema.max(128).optional(),
      platform: z.enum(["web", "ios", "android", "macos", "windows", "linux"]).optional(),
    })
    .optional(),
  scopes: z.array(nonEmptyTextSchema.max(128)).max(100),
});

export const workspaceSchema = baseResourceSchema.extend({
  name: safeNameSchema.max(128),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
  role: roleSchema,
  archivedAt: timestampSchema.nullable(),
});

export const conversationSchema = baseResourceSchema.extend({
  workspaceId: idSchema,
  ownerUserId: idSchema,
  title: z.string().trim().max(240),
  visibility: visibilitySchema,
  status: z.enum(["active", "archived"]),
  archivedAt: timestampSchema.nullable(),
  metadata: jsonObjectSchema,
});

const messageAuthorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: idSchema }),
  z.object({ type: z.literal("assistant"), providerInstanceId: idSchema.optional() }),
  z.object({ type: z.literal("system") }),
  z.object({ type: z.literal("tool"), toolName: safeNameSchema.max(128) }),
]);

export const messagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(100_000) }),
  z.object({
    type: z.literal("reasoning"),
    text: z.string().max(100_000),
    redacted: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("image"),
    artifactId: idSchema,
    alt: z.string().max(500).optional(),
  }),
  z.object({ type: z.literal("file"), artifactId: idSchema, name: safeNameSchema.optional() }),
  z.object({
    type: z.literal("audio"),
    artifactId: idSchema,
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("artifactRef"),
    artifactId: idSchema,
    purpose: z.string().trim().max(128).optional(),
  }),
  z.object({
    type: z.literal("citation"),
    url: z.string().url(),
    title: z.string().max(500).optional(),
    sourceId: idSchema.optional(),
  }),
  z.object({
    type: z.literal("toolCall"),
    callId: idSchema,
    name: safeNameSchema.max(128),
    arguments: jsonObjectSchema,
  }),
  z.object({
    type: z.literal("toolResult"),
    callId: idSchema,
    ok: z.boolean(),
    result: jsonValueSchema.optional(),
    error: z.string().max(500).optional(),
  }),
  z.object({ type: z.literal("approvalRef"), approvalId: idSchema, digest: digestSchema }),
]);

export const messageSchema = baseResourceSchema.extend({
  workspaceId: idSchema,
  conversationId: idSchema,
  runId: idSchema.nullable(),
  sequence: z.number().int().nonnegative(),
  author: messageAuthorSchema,
  parts: z.array(messagePartSchema).min(1).max(1000),
  status: z.enum(["streaming", "complete", "failed", "redacted"]),
});

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  costMinorUnits: z.number().int().nonnegative().optional(),
});

export const runErrorSchema = z.object({
  code: errorCodeSchema,
  message: nonEmptyTextSchema.max(500),
  retryable: z.boolean(),
  uncertain: z.boolean(),
  providerCode: z.string().max(128).optional(),
});

export const runSchema = baseResourceSchema.extend({
  workspaceId: idSchema,
  userId: idSchema,
  conversationId: idSchema.nullable(),
  goalId: idSchema.nullable(),
  status: runStatusSchema,
  trigger: z.enum(["user", "schedule", "webhook", "retry"]),
  providerInstanceId: idSchema.nullable(),
  configDigest: digestSchema.nullable(),
  memorySnapshotId: idSchema.nullable(),
  currentEventSequence: z.number().int().nonnegative(),
  usage: usageSchema.nullable(),
  error: runErrorSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
});

export const runEventSchema = z.object({
  id: idSchema,
  runId: idSchema,
  workspaceId: idSchema,
  sequence: z.number().int().nonnegative(),
  type: eventTypeSchema,
  occurredAt: timestampSchema,
  payload: jsonObjectSchema,
});

export const approvalSchema = baseResourceSchema.extend({
  workspaceId: idSchema,
  userId: idSchema,
  runId: idSchema,
  toolCallId: idSchema,
  digest: digestSchema,
  nonce: idSchema,
  status: z.enum(["pending", "approved", "denied", "expired", "consumed"]),
  policyVersion: z.string().trim().min(1).max(64),
  connectionId: idSchema.nullable(),
  target: jsonObjectSchema,
  expiresAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  consumedAt: timestampSchema.nullable(),
});

export const providerCapabilitySchema = z.object({
  key: nonEmptyTextSchema.max(128),
  description: z.string().max(500).optional(),
  inputSchemaVersion: z.string().trim().min(1).max(64).optional(),
  outputSchemaVersion: z.string().trim().min(1).max(64).optional(),
});

export const providerSecretReferenceSchema = z.object({
  name: safeNameSchema.max(128),
  required: z.boolean(),
  configured: z.boolean(),
});

export const providerInstanceSchema = baseResourceSchema.extend({
  workspaceId: idSchema.nullable(),
  scope: providerInstanceScopeSchema,
  ownerUserId: idSchema.nullable(),
  providerId: idSchema,
  module: providerModuleSchema,
  displayName: safeNameSchema.max(128),
  status: providerStatusSchema,
  version: z.string().trim().min(1).max(128),
  configVersion: z.string().trim().min(1).max(64),
  configDigest: digestSchema,
  capabilities: z.array(providerCapabilitySchema).max(100),
  requiredSecrets: z.array(providerSecretReferenceSchema).max(100),
  isDefault: z.boolean(),
  metadata: jsonObjectSchema,
});

/** Credential metadata is safe to return; the encrypted or plaintext value is never exposed. */
export const providerCredentialSchema = baseResourceSchema.extend({
  workspaceId: idSchema,
  providerInstanceId: idSchema,
  scope: providerCredentialScopeSchema,
  ownerUserId: idSchema.nullable(),
  providerId: idSchema,
  credentialKind: safeNameSchema.max(128),
  keyVersion: z.number().int().positive(),
  secretRevision: z.number().int().positive(),
  status: providerCredentialStatusSchema,
});

export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    at: timestampSchema,
  }),
  z.object({
    kind: z.literal("interval"),
    everySeconds: z.number().int().min(60).max(31_536_000),
    timezone: z.string().trim().min(1).max(64),
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().trim().min(5).max(120),
    timezone: z.string().trim().min(1).max(64),
  }),
]);

export const goalSchema = baseResourceSchema.extend({
  workspaceId: idSchema,
  ownerUserId: idSchema,
  title: safeNameSchema.max(240),
  instructions: nonEmptyTextSchema.max(20_000),
  revision: z.number().int().positive(),
  status: z.enum(["draft", "active", "paused", "completed", "blocked"]),
  schedule: scheduleSchema.nullable(),
  nextRunAt: timestampSchema.nullable(),
  connectionIds: z.array(idSchema).max(20),
  memoryIds: z.array(idSchema).max(50),
  approvalPolicyVersion: z.string().trim().min(1).max(64),
});

export const artifactSchema = baseResourceSchema.extend({
  workspaceId: idSchema,
  runId: idSchema.nullable(),
  kind: z.enum(["file", "image", "audio", "video", "dataset", "snapshot"]),
  name: safeNameSchema.max(512),
  mimeType: z.string().trim().min(1).max(256),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  downloadUrl: z.string().url().nullable(),
  downloadUrlExpiresAt: timestampSchema.nullable(),
  quarantined: z.boolean(),
});

export const memorySchema = baseResourceSchema.extend({
  workspaceId: idSchema,
  ownerUserId: idSchema,
  scope: memoryScopeSchema,
  conversationId: idSchema.nullable(),
  title: safeNameSchema.max(240),
  content: z.string().max(100_000),
  version: z.number().int().positive(),
  source: z.enum(["user", "assistant", "import", "system"]),
  sensitivity: z.enum(["private", "workspace"]),
  deletedAt: timestampSchema.nullable(),
});

export const connectionSchema = baseResourceSchema.extend({
  workspaceId: idSchema,
  ownerUserId: idSchema,
  providerId: idSchema,
  app: z.enum(["gmail", "calendar"]),
  displayName: safeNameSchema.max(240),
  accountRef: idSchema.optional(),
  status: connectionStatusSchema,
  scopes: z.array(nonEmptyTextSchema.max(256)).max(100),
  capabilities: z.array(nonEmptyTextSchema.max(128)).max(100),
  stateRevision: z.number().int().nonnegative(),
  lastCheckedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
});

export const shareSchema = baseResourceSchema.extend({
  workspaceId: idSchema,
  ownerUserId: idSchema,
  resourceType: z.enum(["conversation", "artifact"]),
  resourceId: idSchema,
  subjectType: z.enum(["user", "workspace"]),
  subjectId: idSchema,
  permission: z.literal("read"),
  status: z.enum(["active", "revoked", "expired"]),
  expiresAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  snapshotDigest: digestSchema,
});

export const listResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), page: pageInfoSchema });

export const apiEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ data, requestId: idSchema.optional() });

export const apiFailureSchema = z.object({ error: apiErrorSchema });

export type Session = z.infer<typeof sessionSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type MessagePart = z.infer<typeof messagePartSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
export type ProviderInstance = z.infer<typeof providerInstanceSchema>;
export type ProviderCredential = z.infer<typeof providerCredentialSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Memory = z.infer<typeof memorySchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type Share = z.infer<typeof shareSchema>;
