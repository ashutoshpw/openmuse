import React, { useCallback, useEffect, useState } from "react";
import { Linking, StyleSheet } from "react-native";
import { ApiClientError } from "@openmuse/client";
import type { ProviderInstance } from "@openmuse/contracts";
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
import { runCurrent } from "../src/data/current";
import type { ProviderConnection } from "../src/data/model";
import { useWorkspace } from "../src/state";
import { WorkspaceScope } from "../src/components/WorkspaceScope";

function connectionFromProvider(value: ProviderInstance): ProviderConnection {
  return {
    id: value.id,
    provider: value.providerId,
    label: value.displayName,
    status: value.status === "available" ? "disconnected" : value.status,
    scopes: value.capabilities.map((capability) => capability.key),
    supportsByok: value.requiredSecrets.some((secret) => secret.required || secret.configured),
  };
}

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
  return (
    <WorkspaceScope>
      <ProvidersWorkspaceContent />
    </WorkspaceScope>
  );
}

function ProvidersWorkspaceContent() {
  const apiPromise = useAuthenticatedApi();
  const { workspace } = useWorkspace();
  const [catalog, setCatalog] = useState<ProviderInstance[]>([]);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showByok, setShowByok] = useState(false);
  const [provider, setProvider] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<ProviderInstance | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [fieldVersion, setFieldVersion] = useState(0);
  const [saving, setSaving] = useState(false);

  const clearSecret = useCallback(() => {
    setApiKey("");
    setFieldVersion((current) => current + 1);
  }, []);

  const refresh = useCallback(async () => {
    if (!apiPromise || !workspace) return;
    const currentApi = apiPromise;
    if (!currentApi.isCurrent()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await runCurrent(currentApi, async (api) => {
        const [available, connected] = await Promise.all([
          api.listProviderCatalog(workspace.id),
          api.listConnections(workspace.id),
        ]);
        return { available, connected };
      });
      if (result.status === "stale") return;
      setCatalog(result.value.available);
      setConnections(result.value.connected.items);
    } catch (cause: unknown) {
      if (currentApi.isCurrent())
        setError(cause instanceof Error ? cause.message : "Unable to load provider connections.");
    } finally {
      setLoading((current) => (currentApi.isCurrent() ? false : current));
    }
  }, [apiPromise, workspace]);

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  const connectApp = async (app: "gmail" | "calendar") => {
    if (!apiPromise || !workspace) return;
    const currentApi = apiPromise;
    try {
      const result = await runCurrent(currentApi, (api) =>
        api.createProviderConnectionIntent(workspace.id, app, "/connect/link"),
      );
      if (result.status === "stale") return;
      const intent = result.value;
      if (!intent.authorizationUrl)
        throw new Error("The server did not return an authorization URL.");
      await Linking.openURL(intent.authorizationUrl);
    } catch (cause: unknown) {
      if (currentApi.isCurrent())
        setError(
          cause instanceof Error ? cause.message : "Unable to start provider authorization.",
        );
    }
  };

  const saveByok = async () => {
    if (!apiPromise || !workspace || !provider.trim() || !apiKey) return;
    const selected =
      selectedProvider ?? catalog.find((item) => item.providerId === provider.trim()) ?? null;
    if (!selected) {
      setError("Select a provider from the server catalog before saving a key.");
      clearSecret();
      return;
    }
    const secretName = selected.requiredSecrets[0]?.name;
    if (!secretName) {
      setError("This provider does not accept a BYOK secret.");
      clearSecret();
      return;
    }
    setSaving(true);
    const currentApi = apiPromise;
    try {
      const result = await runCurrent(currentApi, (api) =>
        api.saveProviderSetup(workspace.id, selected, {
          secrets: { [secretName]: apiKey },
        }),
      );
      if (result.status === "stale") return;
      setProvider("");
      clearSecret();
      setSelectedProvider(null);
      setShowByok(false);
      await refresh();
    } catch (cause: unknown) {
      if (!currentApi.isCurrent()) return;
      if (cause instanceof ApiClientError && cause.status === 409) {
        setError(
          "Provider setup changed on the server. Review the refreshed provider and submit again if needed.",
        );
        setSelectedProvider(null);
        await refresh();
      } else {
        setError(
          cause instanceof Error ? cause.message : "Unable to save this provider connection.",
        );
      }
    } finally {
      if (currentApi.isCurrent()) {
        setSaving(false);
        clearSecret();
      }
    }
  };

  const disconnect = async (item: ProviderConnection) => {
    if (!apiPromise) return;
    const currentApi = apiPromise;
    try {
      const result = await runCurrent(currentApi, (api) => api.disconnectProvider(item.id));
      if (result.status === "stale") return;
      await refresh();
    } catch (cause: unknown) {
      if (currentApi.isCurrent())
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
          provider={connectionFromProvider(item)}
          onConnect={() => {
            setProvider(item.providerId);
            setSelectedProvider(item);
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
        onPress={() => {
          setProvider("");
          setSelectedProvider(null);
          clearSecret();
          setShowByok(true);
        }}
      />
      <NativeSheet
        isPresented={showByok}
        onDismiss={() => {
          setShowByok(false);
          clearSecret();
          setSelectedProvider(null);
        }}
      >
        <NativeText variant="heading">Bring your own key</NativeText>
        <NativeText variant="caption" color={colors.mutedInk}>
          The key is sent to the server over your configured API connection. It is never rendered
          back into the app.
        </NativeText>
        <FieldLabel
          key={`${selectedProvider?.id ?? "byok-provider"}-${fieldVersion}`}
          label="Provider id"
          placeholder="e.g. openai"
          autoCapitalize="none"
          defaultValue={selectedProvider?.providerId ?? provider}
          onChangeText={(value) => {
            setProvider(value);
            if (selectedProvider && value !== selectedProvider.providerId)
              setSelectedProvider(null);
          }}
        />
        <FieldLabel
          key={`byok-secret-${fieldVersion}`}
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
