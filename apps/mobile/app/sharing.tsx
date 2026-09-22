import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
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
} from "@openmuse/ui-native";
import {
  ErrorBanner,
  PageHeader,
  RequireSession,
  Screen,
  SectionHeader,
} from "../src/components/Screen";
import { useAuthenticatedApi } from "../src/data/useAuthenticatedApi";
import { runCurrent } from "../src/data/current";
import type { Artifact, Conversation, ShareSnapshot } from "../src/data/model";
import { useWorkspace } from "../src/state";
import { WorkspaceScope } from "../src/components/WorkspaceScope";

function ShareCard({ share, onRevoke }: { share: ShareSnapshot; onRevoke: () => void }) {
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    setBusy(true);
    try {
      await onRevoke();
    } finally {
      setBusy(false);
    }
  };
  return (
    <NativeCard>
      <NativeRow alignment="center" spacing={spacing.sm}>
        <NativeColumn spacing={spacing.xs} style={styles.copy}>
          <NativeText variant="heading">{share.title}</NativeText>
          <NativeText variant="caption" color={colors.mutedInk}>
            {share.resourceType ?? "resource"} · {share.resourceId ?? share.id}
          </NativeText>
        </NativeColumn>
        <NativeBadge tone={share.visibility === "revoked" ? "danger" : "success"}>
          {share.visibility.toUpperCase()}
        </NativeBadge>
        {share.visibility !== "revoked" ? (
          <NativeButton
            label={busy ? "…" : "Revoke"}
            variant="text"
            onPress={() => void revoke()}
            disabled={busy}
          />
        ) : null}
      </NativeRow>
      {share.url ? (
        <NativeText variant="caption" color={colors.sky}>
          {share.url}
        </NativeText>
      ) : (
        <NativeText variant="micro" color={colors.quietInk}>
          Read-only snapshot id · {share.id}
        </NativeText>
      )}
    </NativeCard>
  );
}

function SharingContent() {
  const params = useLocalSearchParams<{ conversationId?: string | string[] }>();
  const initialConversationId = Array.isArray(params.conversationId)
    ? params.conversationId[0]
    : params.conversationId;
  const apiPromise = useAuthenticatedApi();
  const { workspace } = useWorkspace();
  const [shares, setShares] = useState<ShareSnapshot[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [resource, setResource] = useState<{
    type: "conversation" | "artifact";
    id: string;
  } | null>(initialConversationId ? { type: "conversation", id: initialConversationId } : null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(Boolean(initialConversationId));

  const refresh = useCallback(async () => {
    if (!apiPromise || !workspace) return;
    const currentApi = apiPromise;
    if (!currentApi.isCurrent()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await runCurrent(currentApi, async (api) => {
        const [nextShares, nextConversations, nextArtifacts] = await Promise.all([
          api.listShares(workspace.id),
          api.listConversations(workspace.id),
          api.listArtifacts(workspace.id, workspace.id),
        ]);
        return { nextShares, nextConversations, nextArtifacts };
      });
      if (result.status === "stale") return;
      setShares(
        result.value.nextShares.items.filter(
          (item) => !item.workspaceId || item.workspaceId === workspace.id,
        ),
      );
      setConversations(result.value.nextConversations.items);
      setArtifacts(result.value.nextArtifacts.items);
    } catch (cause: unknown) {
      if (currentApi.isCurrent())
        setError(cause instanceof Error ? cause.message : "Unable to load read-only shares.");
    } finally {
      setLoading((current) => (currentApi.isCurrent() ? false : current));
    }
  }, [apiPromise, workspace]);

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  const create = async () => {
    if (!apiPromise || !workspace || !resource) return;
    const currentApi = apiPromise;
    try {
      const result = await runCurrent(currentApi, (api) =>
        api.createShare(
          workspace.id,
          resource.type === "conversation"
            ? { conversationId: resource.id }
            : { artifactId: resource.id },
        ),
      );
      if (result.status === "stale") return;
      setShowCreate(false);
      await refresh();
    } catch (cause: unknown) {
      if (currentApi.isCurrent())
        setError(cause instanceof Error ? cause.message : "Unable to create a read-only share.");
    }
  };

  return (
    <Screen>
      <PageHeader
        eyebrow="Bounded access"
        title="Sharing"
        detail="Create immutable, read-only snapshots for a workspace or conversation."
        action={<NativeButton label="New share" onPress={() => setShowCreate(true)} />}
      />
      {error ? <ErrorBanner message={error} onDismiss={() => void refresh()} /> : null}
      <NativeCard style={styles.explainer}>
        <NativeColumn spacing={spacing.sm}>
          <NativeText variant="heading">Read-only by design</NativeText>
          <NativeText color={colors.mutedInk}>
            Shares never grant write access. Revoking a share changes the server status and
            invalidates the snapshot.
          </NativeText>
        </NativeColumn>
      </NativeCard>
      <SectionHeader
        title="Active shares"
        action={<NativeButton label="Refresh" variant="text" onPress={() => void refresh()} />}
      />
      {loading ? <NativeLoadingState label="Loading share state…" /> : null}
      {!loading && shares.length === 0 ? (
        <NativeEmptyState
          title="Nothing shared"
          detail="Choose a conversation or artifact when you want someone else to read a bounded snapshot."
          action={<NativeButton label="Create share" onPress={() => setShowCreate(true)} />}
        />
      ) : null}
      {shares.map((share) => (
        <ShareCard
          key={share.id}
          share={share}
          onRevoke={async () => {
            if (!apiPromise) return;
            const currentApi = apiPromise;
            const result = await runCurrent(currentApi, (api) => api.revokeShare(share.id));
            if (result.status === "stale") return;
            await refresh();
          }}
        />
      ))}
      <NativeSheet isPresented={showCreate} onDismiss={() => setShowCreate(false)}>
        <NativeText variant="heading">Choose a resource</NativeText>
        <NativeText variant="caption" color={colors.mutedInk}>
          The selected resource is shared with this workspace as read-only.
        </NativeText>
        {conversations.map((item) => (
          <NativeButton
            key={item.id}
            label={`Conversation · ${item.title}`}
            variant={
              resource?.type === "conversation" && resource.id === item.id ? "filled" : "outlined"
            }
            onPress={() => setResource({ type: "conversation", id: item.id })}
          />
        ))}
        {artifacts.map((item) => (
          <NativeButton
            key={item.id}
            label={`Artifact · ${item.title}`}
            variant={
              resource?.type === "artifact" && resource.id === item.id ? "filled" : "outlined"
            }
            onPress={() => setResource({ type: "artifact", id: item.id })}
          />
        ))}
        <NativeButton
          label="Create read-only share"
          onPress={() => void create()}
          disabled={!resource}
        />
      </NativeSheet>
    </Screen>
  );
}

function SharingScopedContent() {
  const params = useLocalSearchParams<{ conversationId?: string | string[] }>();
  const initialConversationId = Array.isArray(params.conversationId)
    ? params.conversationId[0]
    : params.conversationId;
  return (
    <WorkspaceScope suffix={initialConversationId ?? ""}>
      <SharingContent />
    </WorkspaceScope>
  );
}

export default function SharingRoute() {
  return (
    <RequireSession>
      <SharingScopedContent />
    </RequireSession>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1 },
  explainer: { backgroundColor: colors.coralWash, borderColor: colors.coral },
});
