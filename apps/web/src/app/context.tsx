import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createApiClient, type OpenMuseClient } from "@openmuse/client";
import type { Session, Workspace } from "@openmuse/contracts";

type AppContextValue = {
  api: OpenMuseClient;
  baseUrl: string;
  signIn: (input: { email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const baseUrl =
    (import.meta.env.VITE_OPENMUSE_API_URL as string | undefined)?.replace(/\/$/, "") ||
    window.location.origin;
  const signIn = useCallback(
    async ({ email, password }: { email: string; password: string }) => {
      const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email, password }),
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          | { message?: string; error?: { message?: string } }
          | undefined;
        throw new Error(
          payload?.message ?? payload?.error?.message ?? "The sign-in details were not accepted.",
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    },
    [baseUrl, queryClient],
  );
  const signOut = useCallback(async () => {
    const response = await fetch(`${baseUrl}/api/auth/sign-out`, {
      credentials: "include",
      method: "POST",
    });
    if (!response.ok && response.status !== 401)
      throw new Error("The session could not be closed.");
    queryClient.removeQueries({ queryKey: ["session"] });
    queryClient.clear();
  }, [baseUrl, queryClient]);
  const api = useMemo(
    () =>
      createApiClient({
        baseUrl,
        fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
        onUnauthorized: () => {
          void queryClient.invalidateQueries({ queryKey: ["session"] });
        },
      }),
    [baseUrl, queryClient],
  );

  return (
    <AppContext.Provider value={{ api, baseUrl, signIn, signOut }}>{children}</AppContext.Provider>
  );
}

export function useOpenMuse() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useOpenMuse must be used inside AppProvider.");
  return value;
}

export function useSessionQuery() {
  const { api } = useOpenMuse();
  return useQuery({
    queryKey: ["session"],
    queryFn: () => api.getCurrentSession(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

type WorkspaceContextValue = {
  session: Session;
  workspaces: Workspace[];
  workspace: Workspace | null;
  selectWorkspace: (workspaceId: string) => void;
  createWorkspace: (name: string) => Promise<Workspace>;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<unknown>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  const { api } = useOpenMuse();
  const queryClient = useQueryClient();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspaces = query.data?.items ?? [];
  const workspace =
    workspaces.find((item) => item.id === selectedWorkspaceId) ?? workspaces[0] ?? null;

  const selectWorkspace = useCallback(
    (workspaceId: string) => setSelectedWorkspaceId(workspaceId),
    [],
  );
  const createWorkspace = useCallback(
    async (name: string) => {
      const created = await api.createWorkspace({ name });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setSelectedWorkspaceId(created.id);
      return created;
    },
    [api, queryClient],
  );
  const value = useMemo<WorkspaceContextValue>(
    () => ({
      session,
      workspaces,
      workspace,
      selectWorkspace,
      createWorkspace,
      isLoading: query.isPending,
      error:
        query.error instanceof Error
          ? query.error
          : query.error
            ? new Error("Unable to load workspaces.")
            : null,
      refresh: query.refetch,
    }),
    [
      createWorkspace,
      query.error,
      query.isPending,
      query.refetch,
      selectWorkspace,
      session,
      workspace,
      workspaces,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  return value;
}
