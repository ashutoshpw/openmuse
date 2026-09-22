import React, { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  NativeBadge,
  NativeButton,
  NativeCard,
  NativeColumn,
  NativeDivider,
  NativeRow,
  NativeText,
  colors,
  spacing,
  useNativeTheme,
} from "@openmuse/ui-native";
import { ChatComposer } from "../../src/features/chat/ChatComposer";
import { ChatTranscript } from "../../src/features/chat/ChatTranscript";
import { useConversation } from "../../src/features/chat/useConversation";
import { useLiveVoice, useRecordedVoice } from "../../src/features/voice/useVoice";
import {
  useAuthenticatedApi,
  type AuthenticatedApiPromise,
} from "../../src/data/useAuthenticatedApi";
import { runCurrent } from "../../src/data/current";
import type { Artifact, Attachment } from "../../src/data/model";
import type { OpenMuseApi } from "../../src/data/api";
import { useWorkspace } from "../../src/state";
import { ErrorBanner, PageHeader, RequireSession, Screen } from "../../src/components/Screen";
import { EmptyState, LoadingState } from "../../src/components/ResourceStates";
import { LinkButton } from "../../src/components/LinkButton";

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function AttachmentRow({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <NativeRow spacing={spacing.xs} style={styles.attachmentRow}>
      {attachments.map((attachment) => (
        <NativeBadge
          key={attachment.id}
          tone={attachment.status === "failed" ? "danger" : "neutral"}
        >
          {attachment.name}
        </NativeBadge>
      ))}
    </NativeRow>
  );
}

function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <NativeCard>
      <NativeColumn spacing={spacing.sm}>
        <NativeText variant="heading">Artifacts from this work</NativeText>
        {artifacts.map((artifact) => (
          <NativeRow key={artifact.id} alignment="center" spacing={spacing.sm}>
            <NativeColumn spacing={spacing.xs} style={styles.artifactCopy}>
              <NativeText variant="bodyStrong">{artifact.title}</NativeText>
              {artifact.summary ? (
                <NativeText variant="caption">{artifact.summary}</NativeText>
              ) : null}
            </NativeColumn>
            {artifact.url ? <LinkButton href={artifact.url} label="Open" variant="text" /> : null}
          </NativeRow>
        ))}
      </NativeColumn>
    </NativeCard>
  );
}

function ConversationContent({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const theme = useNativeTheme();
  const apiPromise = useAuthenticatedApi();
  const { workspace } = useWorkspace();
  const { conversation, parts, loading, sending, error, refresh, send, stop } =
    useConversation(conversationId);
  const [resolvedApi, setResolvedApi] = useState<{
    promise: AuthenticatedApiPromise;
    api: OpenMuseApi;
  } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<"live" | "recorded">("live");
  const workspaceId = workspace?.id;
  const attachmentIdSet = useMemo(() => new Set(attachmentIds), [attachmentIds]);

  useEffect(() => {
    let active = true;
    if (!apiPromise) {
      return () => {
        active = false;
      };
    }
    void apiPromise
      .then((next) => {
        if (active && apiPromise.isCurrent()) setResolvedApi({ promise: apiPromise, api: next });
      })
      .catch(() => {
        if (active && apiPromise.isCurrent()) setResolvedApi(null);
      });
    return () => {
      active = false;
    };
  }, [apiPromise]);

  const loadResources = useCallback(async () => {
    if (!apiPromise) return;
    const currentApi = apiPromise;
    if (!currentApi.isCurrent()) return;
    try {
      const result = await runCurrent(currentApi, async (client) => {
        const [nextAttachments, nextArtifacts] = await Promise.all([
          client.listAttachments(conversationId),
          client.listArtifacts(conversationId, workspaceId),
        ]);
        return { nextAttachments, nextArtifacts };
      });
      if (result.status === "stale") return;
      setAttachments(result.value.nextAttachments.items);
      setArtifacts(result.value.nextArtifacts.items);
    } catch (cause: unknown) {
      if (currentApi.isCurrent())
        setResourceError(
          cause instanceof Error ? cause.message : "Unable to load attachments and artifacts.",
        );
    }
  }, [apiPromise, conversationId, workspaceId]);

  useEffect(() => {
    void Promise.resolve().then(() => loadResources());
  }, [loadResources]);

  const activeApi = apiPromise && resolvedApi?.promise === apiPromise ? resolvedApi.api : null;
  const liveVoice = useLiveVoice({ api: activeApi, workspaceId, conversationId });
  const recordedVoice = useRecordedVoice({ api: activeApi, workspaceId, conversationId });
  const activeVoice = voiceMode === "live" ? liveVoice : recordedVoice;

  const upload = async () => {
    if (!apiPromise) return;
    const picked = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: "*/*",
    });
    if (picked.canceled || !picked.assets[0]) return;
    try {
      const asset = picked.assets[0];
      const body = new FormData();
      body.append("file", {
        uri: asset.uri,
        name: asset.name,
        type: asset.mimeType ?? "application/octet-stream",
      } as unknown as Blob);
      const uploaded = await (await apiPromise).uploadAttachment(conversationId, body);
      setAttachments((current) => [...current, uploaded]);
      setAttachmentIds((current) => [...current, uploaded.id]);
      setResourceError(null);
    } catch (cause: unknown) {
      setResourceError(
        cause instanceof Error ? cause.message : "Unable to upload that attachment.",
      );
    }
  };

  const sendMessage = async (text: string) => {
    await send(text, attachmentIds);
    setAttachmentIds([]);
  };

  const toggleVoice = async () => {
    if (activeVoice.isActive) {
      await activeVoice.stop();
      return;
    }
    await activeVoice.start();
  };

  const voiceDetail = useMemo(() => {
    if (activeVoice.state === "error") return activeVoice.error ?? "Voice is unavailable.";
    if (activeVoice.state === "listening") return "Live voice is connected.";
    if (activeVoice.state === "recording") return "Recording a server-backed voice note.";
    if (activeVoice.state === "connecting" || activeVoice.state === "requesting-permission")
      return "Connecting to the microphone…";
    return voiceMode === "live"
      ? "Live voice · development build required"
      : "Recorded fallback · upload after stopping";
  }, [activeVoice.error, activeVoice.state, voiceMode]);

  return (
    <Screen scroll={false} contentStyle={styles.screen}>
      <PageHeader
        eyebrow={conversation?.status === "running" || sending ? "Working" : "Conversation"}
        title={conversation?.title ?? "Conversation"}
        detail={
          conversation?.status === "paused"
            ? "Waiting for approval or a connection."
            : "Transcript and work events are stored on the server."
        }
        onBack={() => router.back()}
      />
      {loading ? <LoadingState label="Replaying the conversation…" /> : null}
      {error ? <ErrorBanner message={error} onDismiss={() => void refresh()} /> : null}
      {resourceError ? (
        <ErrorBanner message={resourceError} onDismiss={() => setResourceError(null)} />
      ) : null}
      {!loading ? <ChatTranscript parts={parts} style={styles.transcript} /> : null}
      <AttachmentRow attachments={attachments.filter((item) => attachmentIdSet.has(item.id))} />
      <NativeRow alignment="center" spacing={spacing.sm}>
        <NativeText variant="caption" color={theme.mutedInk}>
          {voiceDetail}
        </NativeText>
        <View style={styles.flex} />
        <NativeButton
          label={voiceMode === "live" ? "Use recording" : "Use live"}
          variant="text"
          onPress={() => setVoiceMode((mode) => (mode === "live" ? "recorded" : "live"))}
          disabled={activeVoice.isActive}
        />
      </NativeRow>
      {activeVoice.error ? (
        <NativeText variant="caption" color={colors.danger}>
          {activeVoice.error}
        </NativeText>
      ) : null}
      {sending ? <NativeButton label="Stop generating" variant="outlined" onPress={stop} /> : null}
      <NativeDivider />
      <ChatComposer
        onAttach={() => void upload()}
        onSend={sendMessage}
        onVoice={() => void toggleVoice()}
        voiceState={activeVoice.state}
        disabled={sending}
      />
      <ArtifactList artifacts={artifacts} />
      <NativeRow spacing={spacing.sm}>
        <LinkButton
          href={`/sharing?conversationId=${encodeURIComponent(conversationId)}`}
          label="Share read-only"
          variant="outlined"
        />
        {artifacts.length > 0 ? (
          <LinkButton href="/sharing" label="Manage shares" variant="text" />
        ) : null}
      </NativeRow>
    </Screen>
  );
}

export default function ConversationRoute() {
  const params = useLocalSearchParams<{ conversationId?: string | string[] }>();
  const conversationId = firstParam(params.conversationId);
  if (!conversationId)
    return (
      <EmptyState
        title="Conversation not found"
        detail="This conversation link is missing its server id."
      />
    );
  return (
    <RequireSession>
      <ConversationContent conversationId={conversationId} />
    </RequireSession>
  );
}

const styles = StyleSheet.create({
  screen: { paddingBottom: spacing.lg },
  transcript: { flex: 1, minHeight: 180 },
  attachmentRow: { flexWrap: "wrap" },
  artifactCopy: { flex: 1 },
  flex: { flex: 1 },
});
