import type {
  AsyncDisposable,
  ProviderConfigDefinition,
  ProviderCreateContext,
  ProviderOperationContext,
  ProviderRegistration,
} from "./types.js";

export interface SearchConfig { endpoint?: string; defaultIndex?: string }
export interface SearchRequest { query: string; limit?: number; cursor?: string; domains?: string[]; }
export interface SearchResult {
  id: string;
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  source?: string;
  contentHash?: string;
}
export interface SearchResponse { results: SearchResult[]; nextCursor?: string; searchedAt: string; providerOperationId?: string }
export interface SearchClient extends AsyncDisposable {
  search(request: SearchRequest, context: ProviderOperationContext): Promise<SearchResponse>;
}
export interface SearchDriver extends ProviderRegistration<SearchConfig, SearchClient> {
  readonly module: "search";
  readonly config: ProviderConfigDefinition<SearchConfig>;
}
