import type {
  AsyncDisposable,
  ProviderConfigDefinition,
  ProviderOperationContext,
  ProviderRegistration,
} from "./types.js";

export interface NotificationConfig {
  endpoint?: string;
  channel?: string;
}
export interface NotificationSendRequest {
  recipientUserId: string;
  channel: "in_app" | "push" | "email";
  title: string;
  body: string;
  dedupeKey: string;
  deepLink?: string;
}
export interface NotificationReceipt {
  accepted: boolean;
  providerMessageId?: string;
  acceptedAt: string;
}
export interface NotificationClient extends AsyncDisposable {
  send(
    request: NotificationSendRequest,
    context: ProviderOperationContext,
  ): Promise<NotificationReceipt>;
}
export interface NotificationDriver extends ProviderRegistration<
  NotificationConfig,
  NotificationClient
> {
  readonly module: "notification";
  readonly config: ProviderConfigDefinition<NotificationConfig>;
}
