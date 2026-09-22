export type JsonObject = Record<string, unknown>;

export type User = {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
};

export type Session = {
  token: string;
  sessionId?: string;
  user: User;
  workspaceId?: string;
};

export type Workspace = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member" | "viewer" | string;
  memberCount?: number;
};

export type Conversation = {
  id: string;
  workspaceId: string;
  title: string;
  preview?: string;
  updatedAt?: string;
  status?: "idle" | "running" | "paused" | "failed" | string;
};

export type ChatPart = {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system" | string;
  text: string;
  createdAt?: string;
  streaming?: boolean;
  kind?: "message" | "tool" | "artifact" | "attachment" | string;
  toolName?: string;
  artifactId?: string;
  attachmentIds?: string[];
};

export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  url?: string;
  status?: "uploading" | "ready" | "failed" | string;
};

export type Artifact = {
  id: string;
  workspaceId?: string;
  title: string;
  kind: string;
  mimeType?: string;
  size?: number;
  url?: string;
  summary?: string;
  createdAt?: string;
};

export type Goal = {
  id: string;
  workspaceId: string;
  title: string;
  detail?: string;
  status: "active" | "paused" | "completed" | "failed" | string;
  nextRunAt?: string;
  schedule?: string;
  revision?: number;
};

export type Approval = {
  id: string;
  workspaceId: string;
  title: string;
  detail?: string;
  action?: string;
  status: "pending" | "approved" | "denied" | "expired" | string;
  digest?: string;
  createdAt?: string;
  expiresAt?: string;
};

export type ProviderConnection = {
  id: string;
  provider: string;
  label: string;
  status: "connected" | "disconnected" | "needs_setup" | "error" | string;
  scopes?: string[];
  accountLabel?: string;
  supportsByok?: boolean;
  authorizationUrl?: string;
  intentId?: string;
};

export type Memory = {
  id: string;
  workspaceId?: string;
  title?: string;
  text: string;
  source?: string;
  updatedAt?: string;
  enabled: boolean;
  version?: number;
  sensitivity?: string;
};

export type ShareSnapshot = {
  id: string;
  workspaceId?: string;
  resourceType?: "conversation" | "artifact" | string;
  resourceId?: string;
  title: string;
  url?: string;
  visibility: "private" | "link" | "workspace" | string;
  createdAt?: string;
  expiresAt?: string;
  readOnly: true;
};

export type ListResult<T> = {
  items: T[];
  nextCursor?: string;
};

export type StreamEvent =
  | { type: "part"; part: ChatPart }
  | { type: "delta"; conversationId: string; partId: string; text: string }
  | { type: "status"; conversationId: string; status: Conversation["status"] }
  | { type: "error"; message: string }
  | { type: "done" };

export type SignInInput = {
  email: string;
  password: string;
};

export type ApiErrorCode = "setup_required" | "unauthorized" | "network" | "server" | "invalid";

export class OpenMuseApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status?: number;

  constructor(message: string, code: ApiErrorCode, status?: number) {
    super(message);
    this.name = "OpenMuseApiError";
    this.code = code;
    this.status = status;
  }
}
