import { z } from "zod";
import {
  cursorSchema,
  digestSchema,
  idSchema,
  jsonObjectSchema,
  memoryScopeSchema,
  nonEmptyTextSchema,
  paginationSchema,
  providerCredentialScopeSchema,
  providerCredentialStatusSchema,
  providerInstanceScopeSchema,
  providerModuleSchema,
  safeNameSchema,
  timestampSchema,
  visibilitySchema,
} from "./common.js";
import { scheduleSchema } from "./resources.js";

/** Parts accepted from a user. Provider/tool output parts are server-authored only. */
export const userMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(20_000) }).strict(),
  z
    .object({ type: z.literal("file"), artifactId: idSchema, name: safeNameSchema.optional() })
    .strict(),
  z
    .object({ type: z.literal("image"), artifactId: idSchema, alt: z.string().max(500).optional() })
    .strict(),
  z
    .object({
      type: z.literal("audio"),
      artifactId: idSchema,
      durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("artifactRef"),
      artifactId: idSchema,
      purpose: z.string().trim().max(128).optional(),
    })
    .strict(),
  z.object({ type: z.literal("approvalRef"), approvalId: idSchema, digest: digestSchema }).strict(),
]);

export const createSessionInputSchema = z
  .object({
    device: z
      .object({
        name: safeNameSchema.max(128).optional(),
        platform: z.enum(["web", "ios", "android", "macos", "windows", "linux"]).optional(),
      })
      .optional(),
  })
  .strict();

export const listInputSchema = paginationSchema;

export const createWorkspaceInputSchema = z
  .object({
    name: safeNameSchema.max(128),
  })
  .strict();

export const updateWorkspaceInputSchema = z
  .object({ name: safeNameSchema.max(128), archived: z.boolean() })
  .strict()
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const createConversationInputSchema = z
  .object({
    workspaceId: idSchema,
    title: z.string().trim().max(240).default("New conversation"),
    visibility: visibilitySchema.default("private"),
  })
  .strict();

export const updateConversationInputSchema = z
  .object({
    title: z.string().trim().max(240),
    visibility: visibilitySchema,
    archived: z.boolean(),
  })
  .strict()
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const sendMessageInputSchema = z
  .object({
    conversationId: idSchema,
    parts: z.array(userMessagePartSchema).min(1).max(100),
    clientMessageId: idSchema.optional(),
    providerInstanceId: idSchema.optional(),
    model: safeNameSchema.max(256).optional(),
  })
  .strict();

export const createRunInputSchema = z
  .object({
    workspaceId: idSchema,
    conversationId: idSchema.optional(),
    goalId: idSchema.optional(),
    messageId: idSchema.optional(),
    providerInstanceId: idSchema.optional(),
    memorySnapshotId: idSchema.optional(),
    idempotencyKey: idSchema.max(256),
  })
  .strict();

export const cancelRunInputSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const listEventsInputSchema = z
  .object({
    runId: idSchema.optional(),
    cursor: cursorSchema,
    limit: z.number().int().min(1).max(1000).default(100),
    waitSeconds: z.number().int().min(0).max(30).default(0),
  })
  .strict();

export const createGoalInputSchema = z
  .object({
    workspaceId: idSchema,
    title: safeNameSchema.max(240),
    instructions: nonEmptyTextSchema.max(20_000),
    schedule: scheduleSchema.nullable().default(null),
    connectionIds: z.array(idSchema).max(20).default([]),
    memoryIds: z.array(idSchema).max(50).default([]),
  })
  .strict();

export const updateGoalInputSchema = z
  .object({
    title: safeNameSchema.max(240),
    instructions: nonEmptyTextSchema.max(20_000),
    schedule: scheduleSchema.nullable(),
    connectionIds: z.array(idSchema).max(20),
    memoryIds: z.array(idSchema).max(50),
    expectedRevision: z.number().int().positive(),
  })
  .strict()
  .partial()
  .extend({ expectedRevision: z.number().int().positive() });

export const changeGoalStatusInputSchema = z
  .object({
    status: z.enum(["active", "paused", "completed"]),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const listProvidersInputSchema = z
  .object({
    module: providerModuleSchema.optional(),
    includeUnavailable: z.boolean().default(false),
  })
  .strict();

export const providerCredentialBindingSchema = z
  .object({
    name: safeNameSchema.max(128),
    credentialId: idSchema,
  })
  .strict();

/** Provider configuration is non-secret JSON; credential values use the credential API below. */
export const createProviderInstanceInputSchema = z
  .object({
    providerId: idSchema,
    module: providerModuleSchema,
    scope: z.enum(["workspace", "user"]).default("workspace"),
    displayName: safeNameSchema.max(128).optional(),
    config: jsonObjectSchema.default({}),
    credentialBindings: z.array(providerCredentialBindingSchema).max(20).default([]),
    isDefault: z.boolean().default(false),
  })
  .strict();

export const updateProviderInstanceInputSchema = z
  .object({
    displayName: safeNameSchema.max(128).optional(),
    config: jsonObjectSchema.optional(),
    credentialBindings: z.array(providerCredentialBindingSchema).max(20).optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    expectedConfigDigest: digestSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

/**
 * Atomically apply provider configuration and write-only secret values. Secret
 * names are checked against the selected provider catalogue by the API; the
 * transport schema deliberately does not maintain a second provider registry.
 */
export const setupProviderInstanceInputSchema = z
  .object({
    expectedConfigDigest: digestSchema,
    config: jsonObjectSchema.optional(),
    displayName: safeNameSchema.max(128).optional(),
    secrets: z
      .record(
        safeNameSchema.max(128),
        z
          .string()
          .min(1)
          .max(64 * 1024),
      )
      .optional(),
  })
  .strict();

export const listProviderInstancesInputSchema = paginationSchema
  .extend({
    module: providerModuleSchema.optional(),
    scope: providerInstanceScopeSchema.optional(),
    includeUnavailable: z.boolean().default(false),
  })
  .strict();

export const createProviderCredentialInputSchema = z
  .object({
    providerId: idSchema,
    providerInstanceId: idSchema,
    credentialKind: safeNameSchema.max(128),
    scope: providerCredentialScopeSchema.default("user"),
    /** Write-only input. The API encrypts this value before persistence. */
    secret: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

export const updateProviderCredentialInputSchema = z
  .object({
    /** Write-only input. The API encrypts this value before persistence. */
    secret: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

export const listProviderCredentialsInputSchema = paginationSchema
  .extend({
    providerId: idSchema.optional(),
    providerInstanceId: idSchema.optional(),
    scope: providerCredentialScopeSchema.optional(),
    status: providerCredentialStatusSchema.optional(),
  })
  .strict();

export const createConnectionIntentInputSchema = z
  .object({
    workspaceId: idSchema,
    app: z.enum(["gmail", "calendar"]),
    returnPath: z.string().trim().max(2048).optional(),
  })
  .strict();

export const completeConnectionIntentInputSchema = z
  .object({
    intentId: idSchema,
    opaqueState: idSchema.max(2048),
  })
  .strict();

export const revokeConnectionInputSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const decideApprovalInputSchema = z
  .object({
    decision: z.enum(["approve", "deny"]),
    expectedDigest: digestSchema,
  })
  .strict();

export const createArtifactInputSchema = z
  .object({
    workspaceId: idSchema,
    runId: idSchema.optional(),
    kind: z.enum(["file", "image", "audio", "video", "dataset", "snapshot"]),
    name: safeNameSchema.max(512),
    mimeType: z.string().trim().min(1).max(256),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const createMemoryInputSchema = z
  .object({
    workspaceId: idSchema,
    scope: memoryScopeSchema,
    conversationId: idSchema.optional(),
    title: safeNameSchema.max(240),
    content: z.string().max(100_000),
    sensitivity: z.enum(["private", "workspace"]).default("private"),
  })
  .strict();

export const updateMemoryInputSchema = z
  .object({
    title: safeNameSchema.max(240).optional(),
    content: z.string().max(100_000).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const createShareInputSchema = z.discriminatedUnion("subjectType", [
  z
    .object({
      resourceType: z.enum(["conversation", "artifact"]),
      resourceId: idSchema,
      subjectType: z.literal("user"),
      recipientEmail: z.string().trim().email().max(320),
      expiresAt: timestampSchema.optional(),
    })
    .strict(),
  z
    .object({
      resourceType: z.enum(["conversation", "artifact"]),
      resourceId: idSchema,
      subjectType: z.literal("workspace"),
      subjectId: idSchema,
      expiresAt: timestampSchema.optional(),
    })
    .strict(),
]);

export const revokeShareInputSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

export const listSharesInputSchema = z
  .object({
    resourceType: z.enum(["conversation", "artifact"]).optional(),
    resourceId: idSchema.optional(),
    cursor: cursorSchema,
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export type CreateSessionInput = z.input<typeof createSessionInputSchema>;
export type CreateWorkspaceInput = z.input<typeof createWorkspaceInputSchema>;
export type UpdateWorkspaceInput = z.input<typeof updateWorkspaceInputSchema>;
export type CreateConversationInput = z.input<typeof createConversationInputSchema>;
export type UpdateConversationInput = z.input<typeof updateConversationInputSchema>;
export type SendMessageInput = z.input<typeof sendMessageInputSchema>;
export type UserMessagePart = z.input<typeof userMessagePartSchema>;
export type CreateRunInput = z.input<typeof createRunInputSchema>;
export type CancelRunInput = z.input<typeof cancelRunInputSchema>;
export type ListEventsInput = z.input<typeof listEventsInputSchema>;
export type CreateGoalInput = z.input<typeof createGoalInputSchema>;
export type UpdateGoalInput = z.input<typeof updateGoalInputSchema>;
export type ChangeGoalStatusInput = z.input<typeof changeGoalStatusInputSchema>;
export type ListProvidersInput = z.input<typeof listProvidersInputSchema>;
export type CreateProviderInstanceInput = z.input<typeof createProviderInstanceInputSchema>;
export type UpdateProviderInstanceInput = z.input<typeof updateProviderInstanceInputSchema>;
export type SetupProviderInstanceInput = z.input<typeof setupProviderInstanceInputSchema>;
export type ListProviderInstancesInput = z.input<typeof listProviderInstancesInputSchema>;
export type CreateProviderCredentialInput = z.input<typeof createProviderCredentialInputSchema>;
export type UpdateProviderCredentialInput = z.input<typeof updateProviderCredentialInputSchema>;
export type ListProviderCredentialsInput = z.input<typeof listProviderCredentialsInputSchema>;
export type CreateConnectionIntentInput = z.input<typeof createConnectionIntentInputSchema>;
export type CompleteConnectionIntentInput = z.input<typeof completeConnectionIntentInputSchema>;
export type RevokeConnectionInput = z.input<typeof revokeConnectionInputSchema>;
export type DecideApprovalInput = z.input<typeof decideApprovalInputSchema>;
export type CreateArtifactInput = z.input<typeof createArtifactInputSchema>;
export type CreateMemoryInput = z.input<typeof createMemoryInputSchema>;
export type UpdateMemoryInput = z.input<typeof updateMemoryInputSchema>;
export type CreateShareInput = z.input<typeof createShareInputSchema>;
export type RevokeShareInput = z.input<typeof revokeShareInputSchema>;
export type ListSharesInput = z.input<typeof listSharesInputSchema>;
