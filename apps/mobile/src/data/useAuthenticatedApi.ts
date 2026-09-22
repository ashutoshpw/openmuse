import { useMemo } from "react";
import { useApi, useSession, useWorkspace } from "../state";

export function useAuthenticatedApi() {
  const { api: baseApi } = useApi();
  const { session } = useSession();
  const { workspace } = useWorkspace();
  return useMemo(() => {
    if (!baseApi || !session) return null;
    return baseApi
      .withToken(session.token)
      .then((authenticatedApi) => authenticatedApi.withWorkspace(workspace?.id ?? null));
  }, [baseApi, session, workspace?.id]);
}
