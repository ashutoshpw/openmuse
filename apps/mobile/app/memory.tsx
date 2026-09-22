import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import {
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
import { FieldLabel } from "../src/components/FieldLabel";
import {
  ErrorBanner,
  PageHeader,
  RequireSession,
  Screen,
  SectionHeader,
} from "../src/components/Screen";
import { useAuthenticatedApi } from "../src/data/useAuthenticatedApi";
import { runCurrent } from "../src/data/current";
import type { Memory } from "../src/data/model";
import { useWorkspace } from "../src/state";

function MemoryCard({ memory, onForget }: { memory: Memory; onForget: () => void }) {
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    setBusy(true);
    try {
      await onForget();
    } finally {
      setBusy(false);
    }
  };
  return (
    <NativeCard>
      <NativeColumn spacing={spacing.sm}>
        <NativeRow alignment="center" spacing={spacing.sm}>
          <NativeText variant="heading" style={styles.copy}>
            {memory.title ?? "Saved memory"}
          </NativeText>
          <NativeText variant="micro" color={colors.quietInk}>
            {memory.sensitivity ?? "private"}
          </NativeText>
        </NativeRow>
        <NativeText>{memory.text}</NativeText>
        <NativeRow alignment="center" spacing={spacing.sm}>
          <NativeText variant="caption" color={colors.mutedInk}>
            {memory.source ? `Source · ${memory.source}` : "Server memory"}
          </NativeText>
          <NativeButton
            label={busy ? "Forgetting…" : "Forget"}
            variant="text"
            onPress={() => void forget()}
            disabled={busy}
          />
        </NativeRow>
      </NativeColumn>
    </NativeCard>
  );
}

function MemoryContent() {
  const apiPromise = useAuthenticatedApi();
  const { workspace } = useWorkspace();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiPromise || !workspace) return;
    const currentApi = apiPromise;
    if (!currentApi.isCurrent()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await runCurrent(currentApi, (api) => api.listMemories(workspace.id));
      if (result.status === "stale") return;
      setMemories(result.value.items.filter((item) => item.enabled));
    } catch (cause: unknown) {
      if (currentApi.isCurrent())
        setError(cause instanceof Error ? cause.message : "Unable to load workspace memory.");
    } finally {
      setLoading((current) => (currentApi.isCurrent() ? false : current));
    }
  }, [apiPromise, workspace]);

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  const create = async () => {
    if (!apiPromise || !workspace || !title.trim() || !text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await (
        await apiPromise
      ).createMemory(workspace.id, { title: title.trim(), text: text.trim(), scope: "workspace" });
      setTitle("");
      setText("");
      setShowCreate(false);
      await refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to save this memory.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <PageHeader
        eyebrow="Context"
        title="Memory"
        detail="Review what OpenMuse may use in this workspace."
        action={<NativeButton label="New" onPress={() => setShowCreate(true)} />}
      />
      {error ? <ErrorBanner message={error} onDismiss={() => void refresh()} /> : null}
      <NativeCard style={styles.explainer}>
        <NativeColumn spacing={spacing.sm}>
          <NativeText variant="heading">You stay in control</NativeText>
          <NativeText color={colors.mutedInk}>
            Memory is loaded from the server for the selected workspace. Forgetting a memory is a
            server-side delete, not a local hide.
          </NativeText>
        </NativeColumn>
      </NativeCard>
      <SectionHeader
        title="Remembered context"
        detail={workspace?.name ?? "Choose a workspace"}
        action={<NativeButton label="Refresh" variant="text" onPress={() => void refresh()} />}
      />
      {loading ? <NativeLoadingState label="Loading workspace memory…" /> : null}
      {!loading && memories.length === 0 ? (
        <NativeEmptyState
          title="No workspace memory"
          detail="Add a durable instruction or preference when it will save you time later."
          action={<NativeButton label="Add memory" onPress={() => setShowCreate(true)} />}
        />
      ) : null}
      {memories.map((memory) => (
        <MemoryCard
          key={memory.id}
          memory={memory}
          onForget={async () => {
            if (apiPromise) {
              await (await apiPromise).forgetMemory(memory.id);
              await refresh();
            }
          }}
        />
      ))}
      <NativeSheet isPresented={showCreate} onDismiss={() => setShowCreate(false)}>
        <NativeText variant="heading">Add workspace memory</NativeText>
        <FieldLabel label="Title" placeholder="e.g. Writing style" onChangeText={setTitle} />
        <FieldLabel
          label="Remember"
          placeholder="What should OpenMuse keep in mind?"
          multiline
          numberOfLines={4}
          onChangeText={setText}
        />
        <NativeButton
          label={saving ? "Saving…" : "Save memory"}
          onPress={() => void create()}
          disabled={saving || !title.trim() || !text.trim()}
        />
      </NativeSheet>
    </Screen>
  );
}

export default function MemoryRoute() {
  return (
    <RequireSession>
      <MemoryContent />
    </RequireSession>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1 },
  explainer: { backgroundColor: colors.skyWash, borderColor: colors.sky },
});
