import React, { useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  NativeButton,
  NativeCard,
  NativeColumn,
  NativeText,
  colors,
  spacing,
} from "@openmuse/ui-native";
import { ErrorBanner, PageHeader, RequireSession, Screen } from "../../src/components/Screen";
import { LoadingState } from "../../src/components/ResourceStates";
import { useAuthenticatedApi } from "../../src/data/useAuthenticatedApi";

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function CallbackContent() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    code?: string | string[];
    state?: string | string[];
    error?: string | string[];
  }>();
  const apiPromise = useAuthenticatedApi();
  const callbackCode = firstParam(params.code);
  const callbackState = firstParam(params.state);
  const callbackError = firstParam(params.error);
  const hasCallback = Boolean(callbackCode || callbackState);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (callbackError) {
      void Promise.resolve().then(() => {
        if (!active) return;
        setError(callbackError);
        setLoading(false);
      });
      return () => {
        active = false;
      };
    }
    if (!apiPromise || !hasCallback) {
      void Promise.resolve().then(() => {
        if (!active) return;
        setLoading(false);
        setMessage("Open this route after the provider redirects back to OpenMuse.");
      });
      return () => {
        active = false;
      };
    }
    void apiPromise
      .then((api) =>
        api.handleAppConnectCallback({
          code: callbackCode,
          state: callbackState,
        }),
      )
      .then(() => {
        if (active)
          setMessage(
            "The provider connection was returned to the server. You can close this screen or review Connections.",
          );
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "The provider callback could not be completed.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiPromise, callbackCode, callbackError, callbackState, hasCallback]);

  return (
    <Screen>
      <PageHeader
        eyebrow="AppConnect"
        title="Finish connection"
        detail="The callback is completed by the OpenMuse server."
        onBack={() => router.back()}
      />
      {loading ? <LoadingState label="Completing the provider callback…" /> : null}
      {error ? <ErrorBanner message={error} /> : null}
      {message ? (
        <NativeCard>
          <NativeColumn spacing={spacing.sm}>
            <NativeText variant="heading">
              {error ? "Connection needs attention" : "Callback received"}
            </NativeText>
            <NativeText color={colors.mutedInk}>{message}</NativeText>
          </NativeColumn>
        </NativeCard>
      ) : null}
      <NativeButton label="Review connections" onPress={() => router.replace("/providers")} />
    </Screen>
  );
}

export default function AppConnectLinkRoute() {
  return (
    <RequireSession>
      <CallbackContent />
    </RequireSession>
  );
}
