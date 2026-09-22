import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import {
  NativeBadge,
  NativeButton,
  NativeCard,
  NativeColumn,
  NativeEmptyState,
  NativeLoadingState,
  NativeRow,
  NativeSheet,
  NativeText,
  colors,
  spacing,
  useNativeTheme,
} from "@openmuse/ui-native";
import {
  PageHeader,
  RequireSession,
  Screen,
  SectionHeader,
  ErrorBanner,
} from "../../src/components/Screen";
import { LinkButton } from "../../src/components/LinkButton";
import { useAuthenticatedApi } from "../../src/data/useAuthenticatedApi";
import { runCurrent } from "../../src/data/current";
import type { Conversation } from "../../src/data/model";
import { useWorkspace } from "../../src/state";
import { WorkspaceScope } from "../../src/components/WorkspaceScope";

function ConversationCard({
  conversation,
  onPress,
}: {
  conversation: Conversation;
  onPress: () => void;
}) {
  const theme = useNativeTheme();
  return (
    <NativeCard>
      <NativeRow spacing={spacing.md} alignment="center">
        <NativeColumn spacing={spacing.xs} style={styles.cardCopy}>
          <NativeText variant="heading">{conversation.title}</NativeText>
          <NativeText variant="caption" color={theme.mutedInk}>
            {conversation.preview ?? "No messages yet"}
          </NativeText>
        </NativeColumn>
        {conversation.status === "running" ? <NativeBadge>WORKING</NativeBadge> : null}
        <NativeButton label="Open" variant="text" onPress={onPress} />
      </NativeRow>
    </NativeCard>
  );
}

function WorkspaceContent() {
  const router = useRouter();
  const apiPromise = useAuthenticatedApi();
  const {
    workspaces,
    workspace,
    loading: workspaceLoading,
    error: workspaceError,
    selectWorkspace,
    refresh: refreshWorkspaces,
  } = useWorkspace();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiPromise || !workspace) return;
    const currentApi = apiPromise;
    if (!currentApi.isCurrent()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await runCurrent(currentApi, (api) => api.listConversations(workspace.id));
      if (result.status === "stale") return;
      setConversations(result.value.items);
    } catch (cause: unknown) {
      if (currentApi.isCurrent())
        setError(cause instanceof Error ? cause.message : "Unable to load conversations.");
    } finally {
      setLoading((current) => (currentApi.isCurrent() ? false : current));
    }
  }, [apiPromise, workspace]);

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  const createConversation = async () => {
    if (!apiPromise || !workspace) return;
    const currentApi = apiPromise;
    try {
      const result = await runCurrent(currentApi, (api) => api.createConversation(workspace.id));
      if (result.status === "stale") return;
      router.push(`/conversations/${result.value.id}` as never);
    } catch (cause: unknown) {
      if (currentApi.isCurrent())
        setError(cause instanceof Error ? cause.message : "Unable to create a conversation.");
    }
  };

  return (
    <Screen>
      <PageHeader
        eyebrow="Today"
        title={workspace?.name ?? "Your workspace"}
        detail={
          workspace
            ? `${workspace.role} · ${workspace.memberCount ?? "Private"} members`
            : "Choose a workspace"
        }
        action={
          <NativeButton
            label="Switch"
            variant="text"
            onPress={() => setShowWorkspacePicker(true)}
            disabled={workspaces.length < 2}
          />
        }
      />
      {workspaceError ? (
        <ErrorBanner message={workspaceError} onDismiss={() => void refreshWorkspaces()} />
      ) : null}
      <NativeCard style={styles.hero}>
        <NativeColumn spacing={spacing.md}>
          <NativeText variant="display">What should keep moving?</NativeText>
          <NativeText color={colors.mutedInk}>
            Research, write, browse, or make a plan. OpenMuse will show its work and pause for
            approval when needed.
          </NativeText>
          <NativeButton
            label="Start a conversation"
            onPress={() => void createConversation()}
            disabled={!workspace}
          />
        </NativeColumn>
      </NativeCard>
      <SectionHeader
        title="Conversations"
        detail="Private by default"
        action={<NativeButton label="Refresh" variant="text" onPress={() => void refresh()} />}
      />
      {loading || workspaceLoading ? <NativeLoadingState label="Loading your workspace…" /> : null}
      {!loading && !workspaceLoading && error ? (
        <ErrorBanner message={error} onDismiss={() => void refresh()} />
      ) : null}
      {!loading && !error && conversations.length === 0 ? (
        <NativeEmptyState
          title="Nothing here yet"
          detail="Start a conversation when you have an outcome in mind."
          action={<NativeButton label="Start" onPress={() => void createConversation()} />}
        />
      ) : null}
      {conversations.map((conversation) => (
        <ConversationCard
          key={conversation.id}
          conversation={conversation}
          onPress={() => router.push(`/conversations/${conversation.id}` as never)}
        />
      ))}
      <NativeRow spacing={spacing.sm}>
        <LinkButton href="/providers" label="Connections" variant="outlined" />
        <LinkButton href="/memory" label="Memory" variant="outlined" />
      </NativeRow>
      <NativeSheet
        isPresented={showWorkspacePicker}
        onDismiss={() => setShowWorkspacePicker(false)}
      >
        <NativeText variant="heading">Choose a workspace</NativeText>
        {workspaces.map((item) => (
          <NativeButton
            key={item.id}
            label={`${item.name} · ${item.role}`}
            onPress={() => {
              selectWorkspace(item);
              setShowWorkspacePicker(false);
            }}
            variant={item.id === workspace?.id ? "filled" : "outlined"}
          />
        ))}
      </NativeSheet>
    </Screen>
  );
}

function WorkspaceScopedContent() {
  return (
    <WorkspaceScope>
      <WorkspaceContent />
    </WorkspaceScope>
  );
}

export default function WorkspaceRoute() {
  return (
    <RequireSession>
      <WorkspaceScopedContent />
    </RequireSession>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.coralWash, borderColor: colors.coral },
  cardCopy: { flex: 1 },
});
