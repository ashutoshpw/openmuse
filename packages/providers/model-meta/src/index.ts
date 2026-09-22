import type { ModelDriver } from "@openmuse/provider-contracts";
import {
  createOpenAiCompatibleModelDriver,
  type OpenAiCompatibleDriverOptions,
} from "@openmuse/provider-model-openai-compatible";

export interface MetaModelDriverOptions extends Omit<
  OpenAiCompatibleDriverOptions,
  "providerId" | "displayName" | "defaultEndpoint"
> {
  defaultEndpoint?: string;
}

/** Meta's compatibility endpoint is intentionally adapted through HTTP, not a vendor SDK. */
export function createMetaModelDriver(options: MetaModelDriverOptions = {}): ModelDriver {
  return createOpenAiCompatibleModelDriver({
    ...options,
    providerId: "meta-llama",
    displayName: "Meta Llama model",
    defaultEndpoint: options.defaultEndpoint ?? "https://api.llama.com/compat/v1",
  });
}
