import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatPart, Conversation } from "../../data/model";
import { useAuthenticatedApi } from "../../data/useAuthenticatedApi";

function mergePart(parts: ChatPart[], next: ChatPart) {
  const index = parts.findIndex((part) => part.id === next.id);
  if (index === -1) return [...parts, next];
  const copy = parts.slice();
  copy[index] = { ...copy[index], ...next };
  return copy;
}

export function useConversation(conversationId: string) {
  const apiPromise = useAuthenticatedApi();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [parts, setParts] = useState<ChatPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!apiPromise) return;
    const api = await apiPromise;
    const [nextConversation, nextParts] = await Promise.all([
      api.getConversation(conversationId),
      api.listChatParts(conversationId),
    ]);
    setConversation(nextConversation);
    setParts(nextParts.items);
  }, [apiPromise, conversationId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void refresh()
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Unable to load this conversation.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!conversation || (!sending && conversation.status !== "running")) return;
    const interval = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 2500);
    return () => clearInterval(interval);
  }, [conversation, refresh, sending]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
  }, []);

  const send = useCallback(
    async (text: string, attachmentIds: string[] = []) => {
      if (!apiPromise || !text.trim() || sending) return;
      const api = await apiPromise;
      const normalized = text.trim();
      const optimistic: ChatPart = {
        id: `local-${Date.now()}`,
        conversationId,
        role: "user",
        text: normalized,
        attachmentIds,
        createdAt: new Date().toISOString(),
      };
      setParts((current) => [...current, optimistic]);
      setSending(true);
      setError(null);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const stream = await api.streamMessage(
          conversationId,
          normalized,
          attachmentIds,
          controller.signal,
        );
        for await (const event of stream) {
          if (event.type === "part") setParts((current) => mergePart(current, event.part));
          if (event.type === "delta") {
            setParts((current) => {
              const existing = current.find((part) => part.id === event.partId);
              return mergePart(current, {
                id: event.partId,
                conversationId,
                role: existing?.role ?? "assistant",
                text: `${existing?.text ?? ""}${event.text}`,
                streaming: true,
              });
            });
          }
          if (event.type === "status")
            setConversation((current) =>
              current ? { ...current, status: event.status } : current,
            );
          if (event.type === "error") throw new Error(event.message);
        }
        await refresh();
      } catch (cause: unknown) {
        if ((cause as { name?: string })?.name !== "AbortError") {
          setError(cause instanceof Error ? cause.message : "The message could not be sent.");
          await refresh().catch(() => undefined);
        }
      } finally {
        abortRef.current = null;
        setSending(false);
      }
    },
    [apiPromise, conversationId, refresh, sending],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(
    () => ({
      conversation,
      parts,
      loading,
      sending,
      error,
      refresh,
      send,
      stop,
    }),
    [conversation, error, loading, parts, refresh, send, sending, stop],
  );
}
