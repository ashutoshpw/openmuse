import { useLayoutEffect, useMemo } from "react";
import type { OpenMuseApi } from "./api";
import { currentPromise, type CurrentPromise } from "./current";
import { useApi, useSession, useWorkspace } from "../state";

export type AuthenticatedApiPromise = CurrentPromise<OpenMuseApi>;

export function useAuthenticatedApi(): AuthenticatedApiPromise | null {
  const { api: baseApi } = useApi();
  const { session } = useSession();
  const { workspace } = useWorkspace();
  const token = session?.token ?? null;
  const workspaceId = workspace?.id ?? null;
  const apiPromise = useMemo(() => {
    if (!baseApi || !token) return null;
    return currentPromise(
      baseApi
        .withToken(token)
        .then((authenticatedApi) => authenticatedApi.withWorkspace(workspaceId)),
    );
  }, [baseApi, token, workspaceId]);

  useLayoutEffect(() => {
    apiPromise?.activate();
    return () => {
      apiPromise?.invalidate();
    };
  }, [apiPromise]);

  return apiPromise;
}
