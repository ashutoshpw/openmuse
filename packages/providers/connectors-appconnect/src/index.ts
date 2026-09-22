import { z } from "zod";
import {
  ProviderOperationError,
  type ConnectorClient,
  type ConnectorConfig,
  type ConnectorConnectionState,
  type ConnectorDriver,
  type ConnectorOperationRequest,
  type ProviderCreateContext,
  type ProviderJsonResult,
  type ProviderOperationContext,
  type JsonValue,
} from "@openmuse/provider-contracts";
import { asRecord, asString, createHttpClient, type FetchLike } from "@openmuse/provider-http";

export interface AppConnectConfig extends ConnectorConfig {
  endpoint: string;
  clientIdSecret: string;
  clientSecretSecret: string;
  redirectUri: string;
  sdkVersion: "0.1.0";
  requestTimeoutMs: number;
  maxResponseBytes: number;
}

/** The normalized tool shape used by the host; HTTP execution maps `toolId` to `tool_id`. */
export interface AppConnectTool {
  id: string;
  tool_id: string;
  service?: string;
  serviceName?: string;
  name?: string;
  displayName?: string;
  description?: string;
  method?: string;
  input_schema?: Record<string, unknown>;
}

export interface AppConnectLinkSession {
  linkToken: string;
  authorizationUrl: string;
  expiresAt: string;
}

export interface AppConnectTokenState {
  status: "pending" | "connected";
  userId?: string;
  state?: string | null;
  message?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: "Bearer";
  expiresAt?: string;
  expiresIn?: number;
  connectedServices?: readonly string[];
}

export interface AppConnectLinkInput {
  userId: string;
  redirectUri?: string;
  state?: string;
  allowedServices?: readonly string[];
  expiresIn?: number;
}

export interface AppConnectConnectionContext {
  connection: ConnectorConnectionState;
  service: string;
  accessToken: string;
}

export interface AppConnectPlatform {
  createLinkToken(
    input: AppConnectLinkInput,
    context: ProviderOperationContext,
  ): Promise<AppConnectLinkSession>;
  exchangeLinkToken(
    input: { linkToken: string },
    context: ProviderOperationContext,
  ): Promise<AppConnectTokenState>;
  exchangeAuthorizationCode(
    input: { code: string; redirectUri?: string },
    context: ProviderOperationContext,
  ): Promise<AppConnectTokenState>;
  refreshToken(
    input: { refreshToken: string },
    context: ProviderOperationContext,
  ): Promise<AppConnectTokenState>;
  listTools(
    accessToken: string,
    context: ProviderOperationContext,
  ): Promise<readonly AppConnectTool[]>;
  searchTools(
    input: { accessToken: string; query?: string; limit?: number },
    context: ProviderOperationContext,
  ): Promise<readonly AppConnectTool[]>;
  executeTool(
    input: { accessToken: string; toolId: string; params: Record<string, unknown> },
    context: ProviderOperationContext,
  ): Promise<ProviderJsonResult>;
  revokeConnection(
    input: { accessToken: string; service: string },
    context: ProviderOperationContext,
  ): Promise<void>;
}

export interface AppConnectClient extends ConnectorClient {
  beginLink(
    input: AppConnectLinkInput,
    context: ProviderOperationContext,
  ): Promise<AppConnectLinkSession>;
  exchangeLinkToken(
    input: { linkToken: string },
    context: ProviderOperationContext,
  ): Promise<AppConnectTokenState>;
  /** Compatibility alias for callers that used the earlier link-code name. */
  exchangeLinkCode(
    input: { linkToken: string },
    context: ProviderOperationContext,
  ): Promise<AppConnectTokenState>;
  exchangeAuthorizationCode(
    input: { code: string; redirectUri?: string },
    context: ProviderOperationContext,
  ): Promise<AppConnectTokenState>;
  refreshToken(
    input: { refreshToken: string },
    context: ProviderOperationContext,
  ): Promise<AppConnectTokenState>;
  listTools(
    connectionId: string,
    context: ProviderOperationContext,
  ): Promise<readonly AppConnectTool[]>;
  searchTools(
    connectionId: string,
    query: string | undefined,
    context: ProviderOperationContext,
  ): Promise<readonly AppConnectTool[]>;
}

export interface AppConnectDriverOptions {
  fetch?: FetchLike;
  platform?: AppConnectPlatform;
  endpoint?: string;
  /** Resolves app-owned connection state; AppConnect tokens never live in this adapter. */
  resolveConnection?: (
    connectionId: string,
    context: ProviderOperationContext,
  ) => Promise<AppConnectConnectionContext>;
}

export interface AppConnectConnectorDriver extends Omit<ConnectorDriver, "create"> {
  create(config: ConnectorConfig, context: ProviderCreateContext): Promise<AppConnectClient>;
}

const configSchema = z
  .object({
    endpoint: z.string().url().default("https://www.appconnecthq.com"),
    clientIdSecret: z.string().trim().min(1),
    clientSecretSecret: z.string().trim().min(1),
    redirectUri: z.string().url(),
    sdkVersion: z.literal("0.1.0").default("0.1.0"),
    requestTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
    maxResponseBytes: z
      .number()
      .int()
      .min(16 * 1024)
      .max(20 * 1024 * 1024)
      .default(5 * 1024 * 1024),
  })
  .strict();

export interface AppConnectHttpPaths {
  createLinkToken: string;
  exchangeLinkToken: string;
  exchangeToken: string;
  listTools: string;
  searchTools: string;
  executeTool: string;
  revokeConnection: string;
}

const defaultPaths: AppConnectHttpPaths = {
  createLinkToken: "/api/link-tokens",
  exchangeLinkToken: "/api/link-tokens/exchange",
  exchangeToken: "/api/oauth/token",
  listTools: "/api/tools",
  searchTools: "/api/tools/search",
  executeTool: "/api/tools/execute",
  revokeConnection: "/api/connections",
};

function context(operation: string) {
  return { providerId: "appconnect", module: "connector" as const, operation };
}

function invalid(operation: string, message: string): ProviderOperationError {
  return new ProviderOperationError({
    code: "failed",
    message,
    safeMessage: "The connection provider returned an invalid response.",
    retryable: false,
    uncertain: false,
    providerId: "appconnect",
    module: "connector",
    operation,
  });
}

function authenticationRequired(operation: string, message: string): ProviderOperationError {
  return new ProviderOperationError({
    code: "authentication_required",
    message,
    safeMessage: "The connection provider is not configured.",
    retryable: false,
    uncertain: false,
    providerId: "appconnect",
    module: "connector",
    operation,
  });
}

function isJsonValue(candidate: unknown): candidate is JsonValue {
  if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean")
    return true;
  if (typeof candidate === "number") return Number.isFinite(candidate);
  if (Array.isArray(candidate)) return candidate.every(isJsonValue);
  if (typeof candidate === "object")
    return Object.values(candidate as Record<string, unknown>).every(isJsonValue);
  return false;
}

function dataRecord(value: unknown, operation: string): Record<string, unknown> {
  const record = asRecord(value, context(operation));
  return "data" in record ? asRecord(record.data, context(operation)) : record;
}

function link(value: unknown, operation: string): AppConnectLinkSession {
  const record = asRecord(value, context(operation));
  return {
    linkToken: asString(record.link_token, "link_token", context(operation)),
    authorizationUrl: asString(record.link_url, "link_url", context(operation)),
    expiresAt: asString(record.expires_at, "expires_at", context(operation)),
  };
}

function tokenState(value: unknown, operation: string, wrapped = false): AppConnectTokenState {
  const record = wrapped ? dataRecord(value, operation) : asRecord(value, context(operation));
  const status =
    record.status === undefined && wrapped
      ? "connected"
      : record.status === "pending" || record.status === "connected"
        ? record.status
        : undefined;
  if (!status) throw invalid(operation, "AppConnect returned an invalid token status.");
  const accessToken = typeof record.access_token === "string" ? record.access_token : undefined;
  const refreshToken = typeof record.refresh_token === "string" ? record.refresh_token : undefined;
  if (status === "connected" && !accessToken)
    throw invalid(operation, "AppConnect returned a connected response without an access token.");
  const connectedServices = record.connected_services;
  if (
    connectedServices !== undefined &&
    (!Array.isArray(connectedServices) ||
      !connectedServices.every((item) => typeof item === "string"))
  )
    throw invalid(operation, "AppConnect returned invalid connected services.");
  const tokenType = record.token_type;
  if (tokenType !== undefined && tokenType !== "Bearer")
    throw invalid(operation, "AppConnect returned an invalid token type.");
  const expiresIn = record.expires_in;
  if (
    expiresIn !== undefined &&
    (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn < 0)
  )
    throw invalid(operation, "AppConnect returned an invalid token lifetime.");
  return {
    status,
    ...(typeof record.user_id === "string" ? { userId: record.user_id } : {}),
    ...(record.state === null || typeof record.state === "string" ? { state: record.state } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(tokenType === "Bearer" ? { tokenType } : {}),
    ...(typeof record.expires_at === "string" ? { expiresAt: record.expires_at } : {}),
    ...(typeof expiresIn === "number" ? { expiresIn } : {}),
    ...(Array.isArray(connectedServices) ? { connectedServices } : {}),
  };
}

function tool(value: unknown, operation: string): AppConnectTool {
  const record = asRecord(value, context(operation));
  const toolId = asString(record.id ?? record.tool_id, "tool.id", context(operation));
  const inputSchema = record.inputSchema ?? record.input_schema;
  return {
    id: toolId,
    tool_id: toolId,
    ...(typeof record.service === "string" ? { service: record.service } : {}),
    ...(typeof record.serviceName === "string" ? { serviceName: record.serviceName } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(typeof record.method === "string" ? { method: record.method } : {}),
    ...(inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
      ? { input_schema: inputSchema as Record<string, unknown> }
      : {}),
  };
}

function tools(value: unknown, operation: string): readonly AppConnectTool[] {
  const record = asRecord(value, context(operation));
  const payload = record.data ?? record.tools;
  if (!Array.isArray(payload))
    throw invalid(operation, "AppConnect returned an invalid tool list.");
  return payload.map((item) => tool(item, operation));
}

function searchTools(value: unknown, operation: string): readonly AppConnectTool[] {
  const record = asRecord(value, context(operation));
  if (!Array.isArray(record.tools))
    throw invalid(operation, "AppConnect returned an invalid tool list.");
  return record.tools.map((item) => tool(item, operation));
}

function result(value: unknown, operation: string): ProviderJsonResult {
  const record = asRecord(value, context(operation));
  const data = "data" in record ? record.data : record;
  if (!isJsonValue(data)) throw invalid(operation, "AppConnect returned a non-JSON tool result.");
  return {
    data,
    ...(typeof record.provider_operation_id === "string"
      ? { providerOperationId: record.provider_operation_id }
      : typeof record.operation_id === "string"
        ? { providerOperationId: record.operation_id }
        : {}),
  };
}

async function resolvePartnerCredentials(
  config: AppConnectConfig,
  createContext: ProviderCreateContext,
): Promise<{ client_id: string; client_secret: string }> {
  if (!createContext.secrets)
    throw authenticationRequired("authenticate", "AppConnect secrets are unavailable.");
  const [clientId, clientSecret] = await Promise.all([
    createContext.secrets.resolve(config.clientIdSecret, createContext.signal),
    createContext.secrets.resolve(config.clientSecretSecret, createContext.signal),
  ]);
  if (!clientId || !clientSecret)
    throw authenticationRequired("authenticate", "AppConnect client credentials are empty.");
  return { client_id: clientId, client_secret: clientSecret };
}

function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function createHttpPlatform(
  config: AppConnectConfig,
  createContext: ProviderCreateContext,
  fetcher: FetchLike,
  paths: AppConnectHttpPaths,
): AppConnectPlatform {
  const http = createHttpClient({
    baseUrl: config.endpoint,
    fetch: fetcher,
    defaultTimeoutMs: config.requestTimeoutMs,
  });
  return {
    async createLinkToken(input, operation) {
      const credentials = await resolvePartnerCredentials(config, createContext);
      return http.json(
        {
          method: "POST",
          path: paths.createLinkToken,
          body: {
            ...credentials,
            user_id: input.userId,
            redirect_uri: input.redirectUri ?? config.redirectUri,
            ...(input.state !== undefined ? { state: input.state } : {}),
            ...(input.allowedServices ? { allowed_services: input.allowedServices } : {}),
            ...(input.expiresIn !== undefined ? { expires_in: input.expiresIn } : {}),
          },
          signal: operation.signal,
          maxResponseBytes: config.maxResponseBytes,
        },
        context("begin_link"),
        (value) => link(value, "begin_link"),
      );
    },
    async exchangeLinkToken(input, operation) {
      const credentials = await resolvePartnerCredentials(config, createContext);
      return http.json(
        {
          method: "POST",
          path: paths.exchangeLinkToken,
          body: { ...credentials, link_token: input.linkToken },
          signal: operation.signal,
          maxResponseBytes: config.maxResponseBytes,
        },
        context("exchange_link"),
        (value) => tokenState(value, "exchange_link"),
      );
    },
    async exchangeAuthorizationCode(input, operation) {
      const credentials = await resolvePartnerCredentials(config, createContext);
      return http.json(
        {
          method: "POST",
          path: paths.exchangeToken,
          body: {
            grant_type: "authorization_code",
            code: input.code,
            ...credentials,
            redirect_uri: input.redirectUri ?? config.redirectUri,
          },
          signal: operation.signal,
          maxResponseBytes: config.maxResponseBytes,
        },
        context("exchange_authorization_code"),
        (value) => tokenState(value, "exchange_authorization_code", true),
      );
    },
    async refreshToken(input, operation) {
      const credentials = await resolvePartnerCredentials(config, createContext);
      return http.json(
        {
          method: "POST",
          path: paths.exchangeToken,
          body: {
            grant_type: "refresh_token",
            refresh_token: input.refreshToken,
            ...credentials,
          },
          signal: operation.signal,
          maxResponseBytes: config.maxResponseBytes,
        },
        context("refresh_token"),
        (value) => tokenState(value, "refresh_token", true),
      );
    },
    async listTools(accessToken, operation) {
      return http.json(
        {
          path: paths.listTools,
          headers: bearer(accessToken),
          signal: operation.signal,
          maxResponseBytes: config.maxResponseBytes,
        },
        context("list_tools"),
        (value) => tools(value, "list_tools"),
      );
    },
    async searchTools(input, operation) {
      const query = new URLSearchParams();
      if (input.query) query.set("q", input.query);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const suffix = query.toString();
      return http.json(
        {
          path: `${paths.searchTools}${suffix ? `?${suffix}` : ""}`,
          headers: bearer(input.accessToken),
          signal: operation.signal,
          maxResponseBytes: config.maxResponseBytes,
        },
        context("search_tools"),
        (value) => searchTools(value, "search_tools"),
      );
    },
    async executeTool(input, operation) {
      return http.json(
        {
          method: "POST",
          path: paths.executeTool,
          headers: bearer(input.accessToken),
          body: { tool_id: input.toolId, params: input.params },
          signal: operation.signal,
          maxResponseBytes: config.maxResponseBytes,
          uncertainOnNetworkFailure: true,
        },
        context("execute_tool"),
        (value) => result(value, "execute_tool"),
      );
    },
    async revokeConnection(input, operation) {
      await http.request(
        {
          method: "DELETE",
          path: `${paths.revokeConnection}?service=${encodeURIComponent(input.service)}`,
          headers: bearer(input.accessToken),
          signal: operation.signal,
          uncertainOnNetworkFailure: true,
        },
        context("revoke_connection"),
      );
    },
  };
}

export function createAppConnectConnectorDriver(
  options: AppConnectDriverOptions = {},
): AppConnectConnectorDriver {
  const providerId = "appconnect";
  return {
    module: "connector",
    providerId,
    metadata: {
      providerId,
      displayName: "AppConnectHQ Platform",
      version: "0.1.0",
      configVersion: "1",
      buildDigest: "builtin:appconnect:0.1.0",
      capabilities: [
        { key: "connection.link" },
        { key: "connection.token.exchange" },
        { key: "connection.token.refresh" },
        { key: "tools.list" },
        { key: "tools.search" },
        { key: "tool.execute" },
        { key: "connection.revoke" },
      ],
      requiredSecrets: [
        {
          name: "clientIdSecret",
          description: "AppConnect partner client ID reference",
          required: true,
        },
        {
          name: "clientSecretSecret",
          description: "AppConnect partner client secret reference",
          required: true,
        },
      ],
      trusted: true,
    },
    config: { version: "1", schema: configSchema },
    async create(
      rawConfig: ConnectorConfig,
      createContext: ProviderCreateContext,
    ): Promise<AppConnectClient> {
      const config = rawConfig as AppConnectConfig;
      const platform =
        options.platform ??
        createHttpPlatform(config, createContext, options.fetch ?? globalThis.fetch, defaultPaths);
      const resolveConnection = async (
        connectionId: string,
        operation: ProviderOperationContext,
      ): Promise<AppConnectConnectionContext> => {
        if (!options.resolveConnection)
          throw authenticationRequired(
            operation.operationId,
            "An app-owned connection resolver is required.",
          );
        return options.resolveConnection(connectionId, operation);
      };
      return {
        async getConnection(connectionId, operation) {
          return (await resolveConnection(connectionId, operation)).connection;
        },
        async execute(request: ConnectorOperationRequest, operation: ProviderOperationContext) {
          if (request.operation !== "execute_tool")
            throw new ProviderOperationError({
              code: "invalid_request",
              message: "AppConnect execute requires operation execute_tool.",
              safeMessage: "The connector operation is invalid.",
              retryable: false,
              uncertain: false,
              providerId,
              module: "connector",
              operation: request.operation,
            });
          const toolId = request.input.tool_id;
          if (typeof toolId !== "string" || toolId.length === 0)
            throw new ProviderOperationError({
              code: "invalid_request",
              message: "AppConnect execute requires tool_id.",
              safeMessage: "The connector operation is invalid.",
              retryable: false,
              uncertain: false,
              providerId,
              module: "connector",
              operation: "execute_tool",
            });
          const args = request.input.arguments;
          if (!args || typeof args !== "object" || Array.isArray(args))
            throw new ProviderOperationError({
              code: "invalid_request",
              message: "AppConnect execute requires object arguments.",
              safeMessage: "The connector operation is invalid.",
              retryable: false,
              uncertain: false,
              providerId,
              module: "connector",
              operation: "execute_tool",
            });
          const resolved = await resolveConnection(request.connectionId, operation);
          return platform.executeTool(
            { accessToken: resolved.accessToken, toolId, params: args as Record<string, unknown> },
            operation,
          );
        },
        async revoke(connectionId, operation) {
          const resolved = await resolveConnection(connectionId, operation);
          await platform.revokeConnection(
            { accessToken: resolved.accessToken, service: resolved.service },
            operation,
          );
        },
        beginLink: (input, operation) => platform.createLinkToken(input, operation),
        exchangeLinkToken: (input, operation) => platform.exchangeLinkToken(input, operation),
        exchangeLinkCode: (input, operation) => platform.exchangeLinkToken(input, operation),
        exchangeAuthorizationCode: (input, operation) =>
          platform.exchangeAuthorizationCode(input, operation),
        refreshToken: (input, operation) => platform.refreshToken(input, operation),
        async listTools(connectionId, operation) {
          const resolved = await resolveConnection(connectionId, operation);
          return platform.listTools(resolved.accessToken, operation);
        },
        async searchTools(connectionId, query, operation) {
          const resolved = await resolveConnection(connectionId, operation);
          return platform.searchTools(
            {
              accessToken: resolved.accessToken,
              ...(query === undefined ? {} : { query }),
            },
            operation,
          );
        },
        async close() {},
      };
    },
  };
}

export { configSchema as appConnectConfigSchema, defaultPaths as appConnectDefaultHttpPaths };
