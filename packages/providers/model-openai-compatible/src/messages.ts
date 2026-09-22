import type { MessagePart } from "@openmuse/contracts";
import {
  ProviderOperationError,
  type ModelMessage,
  type ProviderOperationContext,
} from "@openmuse/provider-contracts";
import { toBase64 } from "@openmuse/provider-http";

export interface ResolvedArtifact {
  url?: string;
  bytes?: Uint8Array;
  contentType: string;
  fileName?: string;
}

export interface ArtifactResolver {
  resolve(artifactId: string, context: ProviderOperationContext): Promise<ResolvedArtifact>;
}

function invalid(message: string): ProviderOperationError {
  return new ProviderOperationError({
    code: "invalid_request",
    message,
    safeMessage: "The model input contains an unsupported or unavailable artifact.",
    retryable: false,
    uncertain: false,
    module: "model",
    operation: "resolve_artifact",
  });
}

function dataUrl(artifact: ResolvedArtifact): string {
  if (artifact.url) return artifact.url;
  if (artifact.bytes) return `data:${artifact.contentType};base64,${toBase64(artifact.bytes)}`;
  throw invalid("Artifact resolver returned neither a URL nor bytes.");
}

async function mapPart(
  part: MessagePart,
  resolver: ArtifactResolver | undefined,
  context: ProviderOperationContext,
): Promise<unknown> {
  if (part.type === "text" || part.type === "reasoning") return { type: "text", text: part.text };
  if (part.type === "approvalRef") return { type: "text", text: `[approval:${part.approvalId}]` };
  if (part.type === "citation")
    return { type: "text", text: `[citation:${part.title ?? part.url}]` };
  if (part.type === "toolCall" || part.type === "toolResult")
    throw invalid("Tool parts must be represented by their message role.");
  if (!resolver)
    throw invalid(
      `Artifact ${"artifactId" in part ? part.artifactId : "unknown"} requires an artifact resolver.`,
    );
  const artifactId = "artifactId" in part ? part.artifactId : undefined;
  if (!artifactId) throw invalid("Artifact part is missing an artifact ID.");
  const artifact = await resolver.resolve(artifactId, context);
  if (artifact.bytes && artifact.bytes.byteLength > 20 * 1024 * 1024)
    throw invalid("Artifact exceeds the model input size limit.");
  if (part.type === "image") return { type: "image_url", image_url: { url: dataUrl(artifact) } };
  if (part.type === "audio") {
    if (!artifact.bytes)
      throw invalid("Audio artifacts must resolve to bytes for compatible models.");
    const format = artifact.contentType.split("/")[1] ?? "wav";
    return { type: "input_audio", input_audio: { data: toBase64(artifact.bytes), format } };
  }
  return {
    type: "file",
    file: {
      file_data: dataUrl(artifact),
      filename: artifact.fileName ?? `${artifactId}.${artifact.contentType.split("/")[1] ?? "bin"}`,
    },
  };
}

export async function toCompatibleMessages(
  messages: ModelMessage[],
  resolver: ArtifactResolver | undefined,
  context: ProviderOperationContext,
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    messages.map(async (message) => {
      const toolCalls = message.parts.filter((part) => part.type === "toolCall");
      const contentParts = message.parts.filter(
        (part) => part.type !== "toolCall" && part.type !== "toolResult",
      );
      const parts = await Promise.all(contentParts.map((part) => mapPart(part, resolver, context)));
      const result: Record<string, unknown> = {
        role: message.role,
        content:
          parts.length === 1 && (parts[0] as { type?: string })?.type === "text"
            ? (parts[0] as { text: string }).text
            : parts,
      };
      if (toolCalls.length > 0) {
        result.tool_calls = toolCalls.map((part) => {
          if (part.type !== "toolCall") return undefined;
          return {
            id: part.callId,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.arguments) },
          };
        });
      }
      const toolResult = message.parts.find((part) => part.type === "toolResult");
      if (message.role === "tool" && toolResult?.type === "toolResult") {
        result.content = toolResult.ok
          ? JSON.stringify(toolResult.result ?? null)
          : JSON.stringify({ error: toolResult.error ?? "tool failed" });
        result.tool_call_id = toolResult.callId;
      }
      if (message.toolCallId) result.tool_call_id = message.toolCallId;
      return result;
    }),
  );
}
