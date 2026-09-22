import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";
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
import { FieldLabel } from "../../src/components/FieldLabel";
import {
  ErrorBanner,
  PageHeader,
  RequireSession,
  Screen,
  SectionHeader,
} from "../../src/components/Screen";
import { useAuthenticatedApi } from "../../src/data/useAuthenticatedApi";
import type { Goal } from "../../src/data/model";
import { useWorkspace } from "../../src/state";

function GoalCard({ goal, onRefresh }: { goal: Goal; onRefresh: () => void }) {
  return (
    <NativeCard>
      <NativeRow alignment="center" spacing={spacing.md}>
        <NativeColumn spacing={spacing.xs} style={styles.copy}>
          <NativeText variant="heading">{goal.title}</NativeText>
          {goal.detail ? <NativeText variant="caption">{goal.detail}</NativeText> : null}
          {goal.nextRunAt ? (
            <NativeText variant="micro" color={colors.mutedInk}>
              Next check · {goal.nextRunAt}
            </NativeText>
          ) : null}
        </NativeColumn>
        <NativeBadge tone={goal.status === "active" ? "success" : "neutral"}>
          {goal.status.toUpperCase()}
        </NativeBadge>
      </NativeRow>
      {goal.schedule ? (
        <NativeText variant="caption" color={colors.mutedInk}>
          Schedule · {goal.schedule}
        </NativeText>
      ) : null}
      <NativeButton label="Refresh status" variant="text" onPress={onRefresh} />
    </NativeCard>
  );
}

function GoalsContent() {
  const apiPromise = useAuthenticatedApi();
  const { workspace } = useWorkspace();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const detailRef = useRef("");
  const scheduleRef = useRef("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiPromise || !workspace) return;
    try {
      const api = await apiPromise;
      setLoading(true);
      setError(null);
      const result = await api.listGoals(workspace.id);
      setGoals(result.items);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to load goals.");
    } finally {
      setLoading(false);
    }
  }, [apiPromise, workspace]);

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  const create = async () => {
    if (!apiPromise || !workspace || !title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await (
        await apiPromise
      ).createGoal(workspace.id, {
        title: title.trim(),
        detail: detailRef.current.trim() || undefined,
        schedule: scheduleRef.current.trim() || undefined,
      });
      setTitle("");
      detailRef.current = "";
      scheduleRef.current = "";
      setShowCreate(false);
      await refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to create the goal.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <PageHeader
        eyebrow="Background work"
        title="Goals"
        detail="Keep a plan moving on a schedule, with a visible history."
        action={<NativeButton label="New" onPress={() => setShowCreate(true)} />}
      />
      {error ? <ErrorBanner message={error} onDismiss={() => void refresh()} /> : null}
      <NativeCard style={styles.explainer}>
        <NativeColumn spacing={spacing.sm}>
          <NativeText variant="heading">Goals are deliberate</NativeText>
          <NativeText color={colors.mutedInk}>
            OpenMuse checks the schedule on the server and asks before a connected service changes
            anything.
          </NativeText>
        </NativeColumn>
      </NativeCard>
      <SectionHeader
        title="Your goals"
        detail={workspace?.name ?? "Choose a workspace"}
        action={<NativeButton label="Refresh" variant="text" onPress={() => void refresh()} />}
      />
      {loading ? <NativeLoadingState label="Loading scheduled work…" /> : null}
      {!loading && goals.length === 0 ? (
        <NativeEmptyState
          title="No goals yet"
          detail="Create a goal to turn a long-running intention into a reviewable plan."
          action={<NativeButton label="Create goal" onPress={() => setShowCreate(true)} />}
        />
      ) : null}
      {goals.map((goal) => (
        <GoalCard key={goal.id} goal={goal} onRefresh={() => void refresh()} />
      ))}
      <NativeSheet isPresented={showCreate} onDismiss={() => setShowCreate(false)}>
        <NativeText variant="heading">Create a goal</NativeText>
        <FieldLabel
          label="Title"
          placeholder="e.g. Watch a page for changes"
          onChangeText={setTitle}
        />
        <FieldLabel
          label="Context"
          placeholder="What should OpenMuse know?"
          multiline
          numberOfLines={3}
          onChangeText={(value) => {
            detailRef.current = value;
          }}
        />
        <FieldLabel
          label="Schedule"
          detail="Use the server’s schedule syntax."
          placeholder="e.g. weekly"
          onChangeText={(value) => {
            scheduleRef.current = value;
          }}
          autoCapitalize="none"
        />
        <NativeButton
          label={saving ? "Creating…" : "Create goal"}
          onPress={() => void create()}
          disabled={saving || !title.trim()}
        />
      </NativeSheet>
    </Screen>
  );
}

export default function GoalsRoute() {
  return (
    <RequireSession>
      <GoalsContent />
    </RequireSession>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1 },
  explainer: { backgroundColor: colors.skyWash, borderColor: colors.sky },
});
