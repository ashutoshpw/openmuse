import React, { useCallback, useEffect, useState } from "react";
import { Linking, StyleSheet } from "react-native";
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
import { FieldLabel } from "../src/components/FieldLabel";
import {
  ErrorBanner,
  PageHeader,
  RequireSession,
  Screen,
  SectionHeader,
} from "../src/components/Screen";
import { useAuthenticatedApi } from "../src/data/useAuthenticatedApi";
import type { ProviderConnection } from "../src/data/model";
import { useWorkspace } from "../src/state";

function ProviderCard({
  provider,
  onConnect,
  onDisconnect,
}: {
  provider: ProviderConnection;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connected = provider.status === "connected" || provider.status === "active";
  return (
    <NativeCard>
      <NativeRow alignment="center" spacing={spacing.md}>
        <NativeColumn spacing={spacing.xs} style={styles.copy}>
          <NativeText variant="heading">{provider.label}</NativeText>
          <NativeText variant="caption" color={colors.mutedInk}>
            {provider.accountLabel ?? provider.provider}
          </NativeText>
        </NativeColumn>
        <NativeBadge
          tone={connected ? "success" : provider.status === "error" ? "danger" : "neutral"}
        >
          {provider.status.toUpperCase()}
        </NativeBadge>
        <NativeButton
          label={connected ? "Disconnect" : "Connect"}
          variant={connected ? "outlined" : "text"}
          onPress={connected ? onDisconnect : onConnect}
        />
      </NativeRow>
      {provider.scopes?.length ? (
        <NativeText variant="micro" color={colors.quietInk}>
          Scopes · {provider.scopes.join(", ")}
        </NativeText>
      ) : null}
    </NativeCard>
  );
}

function ProvidersContent() {
  const apiPromise = useAuthenticatedApi();
  const { workspace } = useWorkspace();
  const [catalog, setCatalog] = useState<ProviderConnection[]>([]);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showByok, setShowByok] = useState(false);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiPromise || !workspace) return;
    try {
      const api = await apiPromise;
      setLoading(true);
      setError(null);
      const [available, connected] = await Promise.all([
        api.listProviders(workspace.id),
        api.listConnections(workspace.id),
      ]);
      setCatalog(available.items);
      setConnections(connected.items);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to load provider connections.");
    } finally {
      setLoading(false);
    }
  }, [apiPromise, workspace]);

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  const connectApp = async (app: "gmail" | "calendar") => {
    if (!apiPromise || !workspace) return;
    try {
      const intent = await (
        await apiPromise
      ).createProviderConnectionIntent(workspace.id, app, "/connect/link");
      if (!intent.authorizationUrl)
        throw new Error("The server did not return an authorization URL.");
      await Linking.openURL(intent.authorizationUrl);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to start provider authorization.");
    }
  };

  const saveByok = async () => {
    if (!apiPromise || !workspace || !provider.trim() || !apiKey) return;
    setSaving(true);
    try {
      await (await apiPromise).connectProvider(workspace.id, provider.trim(), { apiKey });
      setProvider("");
      setApiKey("");
      setShowByok(false);
      await refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to save this provider connection.");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async (item: ProviderConnection) => {
    if (!apiPromise) return;
    try {
      await (await apiPromise).disconnectProvider(item.id);
      await refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to disconnect this provider.");
    }
  };

  return (
    <Screen>
      <PageHeader
        eyebrow="Workspace"
        title="Connections"
        detail="Connect only the services this workspace needs."
      />
      {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}
      <NativeCard style={styles.explainer}>
        <NativeColumn spacing={spacing.sm}>
          <NativeText variant="heading">Permission follows the action</NativeText>
          <NativeText color={colors.mutedInk}>
            OAuth connections return through AppConnect. OpenMuse still asks for approval before
            consequential provider actions.
          </NativeText>
        </NativeColumn>
      </NativeCard>
      <SectionHeader
        title="Connected accounts"
        action={<NativeButton label="Refresh" variant="text" onPress={() => void refresh()} />}
      />
      {loading ? <NativeLoadingState label="Checking the server…" /> : null}
      {!loading && connections.length === 0 ? (
        <NativeEmptyState
          title="No connections yet"
          detail="Start with a read-only connection, or add a provider key for a development workspace."
        />
      ) : null}
      {connections.map((item) => (
        <ProviderCard
          key={item.id}
          provider={item}
          onConnect={() => void connectApp(item.provider === "calendar" ? "calendar" : "gmail")}
          onDisconnect={() => void disconnect(item)}
        />
      ))}
      <SectionHeader
        title="Available providers"
        detail={catalog.length ? `${catalog.length} server capabilities` : undefined}
      />
      {catalog.map((item) => (
        <ProviderCard
          key={item.id}
          provider={item}
          onConnect={() => {
            setProvider(item.provider);
            setShowByok(true);
          }}
          onDisconnect={() => undefined}
        />
      ))}
      <NativeRow spacing={spacing.sm}>
        <NativeButton label="Connect Gmail" onPress={() => void connectApp("gmail")} />
        <NativeButton
          label="Connect Calendar"
          variant="outlined"
          onPress={() => void connectApp("calendar")}
        />
      </NativeRow>
      <NativeButton
        label="Add a provider key (BYOK)"
        variant="text"
        onPress={() => setShowByok(true)}
      />
      <NativeSheet isPresented={showByok} onDismiss={() => setShowByok(false)}>
        <NativeText variant="heading">Bring your own key</NativeText>
        <NativeText variant="caption" color={colors.mutedInk}>
          The key is sent to the server over your configured API connection. It is never rendered
          back into the app.
        </NativeText>
        <FieldLabel
          label="Provider id"
          placeholder="e.g. openai"
          autoCapitalize="none"
          defaultValue={provider}
          onChangeText={setProvider}
        />
        <FieldLabel
          label="API key"
          placeholder="Paste a key"
          secureTextEntry
          onChangeText={setApiKey}
          autoCapitalize="none"
        />
        <NativeButton
          label={saving ? "Saving…" : "Save on server"}
          onPress={() => void saveByok()}
          disabled={saving || !provider.trim() || !apiKey}
        />
      </NativeSheet>
    </Screen>
  );
}

export default function ProvidersRoute() {
  return (
    <RequireSession>
      <ProvidersContent />
    </RequireSession>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1 },
  explainer: { backgroundColor: colors.sageWash, borderColor: colors.sage },
});
