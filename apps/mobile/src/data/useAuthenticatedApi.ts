import { useMemo } from "react";
import { useApi, useSession } from "../state";

export function useAuthenticatedApi() {
  const { api: baseApi } = useApi();
  const { session } = useSession();
  return useMemo(() => {
    if (!baseApi || !session) return null;
    return baseApi.withToken(session.token);
  }, [baseApi, session]);
}
