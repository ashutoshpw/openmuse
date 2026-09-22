import type {
  AsyncDisposable,
  ProviderConfigDefinition,
  ProviderCreateContext,
  ProviderOperationContext,
  ProviderReference,
  ProviderRegistration,
} from "./types.js";

export interface BrowserConfig {
  endpoint?: string;
  authTokenSecret?: string;
  maxPages?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  allowedHosts?: string[];
}
export interface BrowserPage { id: string; url: string; title?: string; text?: string; screenshot?: ProviderReference }
export interface BrowserClient extends AsyncDisposable {
  open(url: string, context: ProviderOperationContext): Promise<BrowserPage>;
  navigate(pageId: string, url: string, context: ProviderOperationContext): Promise<BrowserPage>;
  extract(pageId: string, selector: string | undefined, context: ProviderOperationContext): Promise<string>;
  closePage(pageId: string, context: ProviderOperationContext): Promise<void>;
}
export interface BrowserDriver extends ProviderRegistration<BrowserConfig, BrowserClient> {
  readonly module: "browser";
  readonly config: ProviderConfigDefinition<BrowserConfig>;
  create(config: BrowserConfig, context: ProviderCreateContext): Promise<BrowserClient>;
}
