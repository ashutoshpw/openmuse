import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { OpenMuseApi } from "./data/api";
import { currentPromise, runCurrent } from "./data/current";
import { OpenMuseApiError } from "./data/model";
import type { Session, Workspace } from "./data/model";
import { clearStoredSession, loadStoredSession, saveStoredSession } from "./data/session";
import { appConfig } from "./config";

type ApiState = {
  api: OpenMuseApi | null;
  loading: boolean;
  error: string | null;
  configured: boolean;
  reload: () => void;
};

const ApiContext = createContext<ApiState | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const [api, setApi] = useState<OpenMuseApi | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      if (!appConfig.apiUrl) {
        setApi(null);
        setLoading(false);
        setError("Set EXPO_PUBLIC_OPENMUSE_API_URL to connect this app to an OpenMuse server.");
        return;
      }
      void import("./data/api")
        .then(({ OpenMuseApi }) => OpenMuseApi.create({ baseUrl: appConfig.apiUrl }))
        .then((nextApi) => {
          if (!cancelled) setApi(nextApi);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setApi(null);
          setError(
            cause instanceof Error ? cause.message : "Unable to initialize the OpenMuse client.",
          );
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const value = useMemo<ApiState>(
    () => ({
      api,
      loading,
      error,
      configured: Boolean(appConfig.apiUrl),
      reload: () => setReloadToken((current) => current + 1),
    }),
    [api, error, loading],
  );

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi() {
  const value = useContext(ApiContext);
  if (!value) throw new Error("useApi must be used inside ApiProvider.");
  return value;
}

type SessionState = {
  session: Session | null;
  loading: boolean;
  signingIn: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const baseApi = useApi();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionApi, setSessionApi] = useState<OpenMuseApi | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activate = useCallback(
    async (nextSession: Session) => {
      if (!baseApi.api)
        throw new OpenMuseApiError("The OpenMuse API is not configured.", "setup_required");
      const authenticatedApi = await baseApi.api.withToken(nextSession.token);
      setSession(nextSession);
      setSessionApi(authenticatedApi);
      await saveStoredSession(nextSession);
    },
    [baseApi.api],
  );

  const refresh = useCallback(async () => {
    if (!sessionApi) return;
    const current = await sessionApi.getSession();
    const next = { ...current, token: session?.token ?? "", user: session?.user ?? current.user };
    setSession(next);
    await saveStoredSession(next);
  }, [session, sessionApi]);

  useEffect(() => {
    let cancelled = false;
    if (baseApi.loading)
      return () => {
        cancelled = true;
      };
    if (!baseApi.api) {
      void Promise.resolve().then(() => {
        if (!cancelled) setLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }
    void loadStoredSession()
      .then(async (stored) => {
        if (!stored || cancelled) return;
        const authenticatedApi = await baseApi.api?.withToken(stored.token);
        if (!authenticatedApi || cancelled) return;
        try {
          const current = await authenticatedApi.getSession();
          if (!cancelled) {
            setSession({ ...current, token: stored.token, user: stored.user });
            setSessionApi(authenticatedApi);
          }
        } catch {
          await clearStoredSession();
          if (!cancelled) {
            setSession(null);
            setSessionApi(null);
          }
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Unable to restore your session.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseApi.api, baseApi.loading]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!baseApi.api)
        throw new OpenMuseApiError(
          baseApi.error ?? "The OpenMuse API is not configured.",
          "setup_required",
        );
      setSigningIn(true);
      setError(null);
      try {
        const nextSession = await baseApi.api.signIn({ email, password });
        await activate(nextSession);
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : "Unable to sign in.";
        setError(message);
        throw cause;
      } finally {
        setSigningIn(false);
      }
    },
    [activate, baseApi.api, baseApi.error],
  );

  const signOut = useCallback(async () => {
    try {
      await sessionApi?.signOut();
    } finally {
      await clearStoredSession();
      setSession(null);
      setSessionApi(null);
    }
  }, [sessionApi]);

  const value = useMemo<SessionState>(
    () => ({
      session,
      loading,
      signingIn,
      error,
      signIn,
      signOut,
      refresh,
    }),
    [error, loading, refresh, session, signIn, signOut, signingIn],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider.");
  return value;
}

type WorkspaceState = {
  workspaces: Workspace[];
  workspace: Workspace | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  selectWorkspace: (workspace: Workspace) => void;
  createWorkspace: (name: string) => Promise<Workspace>;
};

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const baseApi = useApi();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionToken = session?.token ?? null;
  const authenticatedApi = useMemo(() => {
    if (!baseApi.api || !sessionToken) return null;
    return currentPromise(baseApi.api.withToken(sessionToken));
  }, [baseApi.api, sessionToken]);

  useLayoutEffect(() => {
    authenticatedApi?.activate();
    return () => {
      authenticatedApi?.invalidate();
    };
  }, [authenticatedApi]);
  const sessionWorkspaceId = session?.workspaceId;

  const refresh = useCallback(async () => {
    if (!authenticatedApi) return;
    const currentApi = authenticatedApi;
    if (!currentApi.isCurrent()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await runCurrent(currentApi, (api) => api.listWorkspaces());
      if (result.status === "stale") return;
      setWorkspaces(result.value.items);
      setWorkspace((current) => {
        if (current && result.value.items.some((item) => item.id === current.id)) return current;
        const preferred = sessionWorkspaceId
          ? result.value.items.find((item) => item.id === sessionWorkspaceId)
          : undefined;
        return preferred ?? result.value.items[0] ?? null;
      });
    } catch (cause: unknown) {
      if (currentApi.isCurrent())
        setError(cause instanceof Error ? cause.message : "Unable to load workspaces.");
    } finally {
      setLoading((current) => (currentApi.isCurrent() ? false : current));
    }
  }, [authenticatedApi, sessionWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      if (!session) {
        setWorkspaces([]);
        setWorkspace(null);
        return;
      }
      void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh, session]);

  const selectWorkspace = useCallback((next: Workspace) => setWorkspace(next), []);

  const createWorkspace = useCallback(
    async (name: string) => {
      if (!authenticatedApi)
        throw new OpenMuseApiError("Sign in before creating a workspace.", "unauthorized");
      const currentApi = authenticatedApi;
      const result = await runCurrent(currentApi, (api) => api.createWorkspace(name));
      if (result.status === "stale")
        throw new Error("Workspace creation was cancelled because the account changed.");
      const created = result.value;
      setWorkspaces((current) => [...current, created]);
      setWorkspace(created);
      return created;
    },
    [authenticatedApi],
  );

  const value = useMemo<WorkspaceState>(
    () => ({
      workspaces,
      workspace,
      loading,
      error,
      refresh,
      selectWorkspace,
      createWorkspace,
    }),
    [createWorkspace, error, loading, refresh, selectWorkspace, workspace, workspaces],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  return value;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ApiProvider>
      <SessionProvider>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </SessionProvider>
    </ApiProvider>
  );
}
