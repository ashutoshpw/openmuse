import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import {
  NativeBadge,
  NativeButton,
  NativeCard,
  NativeColumn,
  NativeEmptyState,
  NativeLoadingState,
  NativeRow,
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
} from "../../src/components/Screen";
import { useAuthenticatedApi } from "../../src/data/useAuthenticatedApi";
import type { Approval } from "../../src/data/model";
import { useWorkspace } from "../../src/state";

function ApprovalCard({ approval, onDone }: { approval: Approval; onDone: () => void }) {
  const apiPromise = useAuthenticatedApi();
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approve" | "deny") => {
    if (!apiPromise) return;
    setBusy(true);
    try {
      await (await apiPromise).decideApproval(approval.id, decision);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <NativeCard>
      <NativeRow alignment="center" spacing={spacing.sm}>
        <NativeColumn spacing={spacing.xs} style={styles.copy}>
          <NativeText variant="heading">{approval.title}</NativeText>
          {approval.detail ? (
            <NativeText color={colors.mutedInk}>{approval.detail}</NativeText>
          ) : null}
        </NativeColumn>
        <NativeBadge tone="accent">REVIEW</NativeBadge>
      </NativeRow>
      {approval.action ? (
        <NativeText variant="caption" color={colors.mutedInk}>
          Action · {approval.action}
        </NativeText>
      ) : null}
      <NativeRow spacing={spacing.sm}>
        <NativeButton
          label={busy ? "Working…" : "Approve"}
          onPress={() => void decide("approve")}
          disabled={busy}
        />
        <NativeButton
          label="Deny"
          variant="outlined"
          onPress={() => void decide("deny")}
          disabled={busy}
        />
      </NativeRow>
    </NativeCard>
  );
}

function ApprovalsContent() {
  const apiPromise = useAuthenticatedApi();
  const { workspace } = useWorkspace();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!apiPromise || !workspace) return;
    try {
      const api = await apiPromise;
      setLoading(true);
      setError(null);
      const result = await api.listApprovals(workspace.id);
      setApprovals(result.items.filter((item) => item.status === "pending"));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to load approvals.");
    } finally {
      setLoading(false);
    }
  }, [apiPromise, workspace]);

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  return (
    <Screen>
      <PageHeader
        eyebrow="Your control"
        title="Review actions"
        detail="OpenMuse pauses before external or consequential actions."
      />
      {error ? <ErrorBanner message={error} onDismiss={() => void refresh()} /> : null}
      <NativeCard style={styles.explainer}>
        <NativeColumn spacing={spacing.sm}>
          <NativeText variant="heading">Nothing leaves quietly</NativeText>
          <NativeText color={colors.mutedInk}>
            Approvals are server-backed. A denial stops the next step; an already-running provider
            request may still finish.
          </NativeText>
        </NativeColumn>
      </NativeCard>
      <SectionHeader
        title="Waiting for you"
        action={<NativeButton label="Refresh" variant="text" onPress={() => void refresh()} />}
      />
      {loading ? <NativeLoadingState label="Checking for approvals…" /> : null}
      {!loading && approvals.length === 0 ? (
        <NativeEmptyState
          title="All clear"
          detail="There are no pending actions in this workspace."
        />
      ) : null}
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} onDone={() => void refresh()} />
      ))}
    </Screen>
  );
}

export default function ApprovalsRoute() {
  return (
    <RequireSession>
      <ApprovalsContent />
    </RequireSession>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1 },
  explainer: { backgroundColor: colors.coralWash, borderColor: colors.coral },
});
