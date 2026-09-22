import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiClientError } from "@openmuse/client";
import {
  Button,
  Card,
  EmptyState,
  Icon,
  IconButton,
  LoadingLine,
  Sidebar,
  type SidebarItem,
} from "@openmuse/ui-web";
import { useOpenMuse, useSessionQuery, useWorkspace, WorkspaceProvider } from "./context";
import { navigationItems, initials } from "./lib";

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function LoadingScreen({ label = "Opening your studio…" }: { label?: string }) {
  return (
    <div className="om-fullscreen-state">
      <span className="om-fullscreen-state__mark">
        <Icon name="spark" size={22} />
      </span>
      <span className="om-eyebrow">OpenMuse</span>
      <h1>{label}</h1>
      <LoadingLine width="170px" />
    </div>
  );
}

function LoginScreen({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { baseUrl, signIn } = useOpenMuse();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setMessage("Enter your email and password to continue.");
      return;
    }
    setMessage("");
    setSigningIn(true);
    try {
      await signIn({ email: email.trim(), password });
    } catch (cause: unknown) {
      setMessage(errorMessage(cause, "The sign-in details were not accepted."));
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div className="om-auth-screen">
      <div className="om-auth-screen__texture" />
      <div className="om-auth-screen__brand">
        <span>
          <Icon name="spark" size={18} />
        </span>
        <strong>openmuse</strong>
      </div>
      <main className="om-auth-card">
        <div className="om-auth-card__intro">
          <span className="om-eyebrow">A quieter place for useful work</span>
          <h1>
            Bring the thread
            <br />
            <em>back to you.</em>
          </h1>
          <p>OpenMuse keeps conversations, goals, and connected actions in one calm workspace.</p>
        </div>
        <div className="om-auth-card__rule">
          <span /> <Icon name="spark" size={14} /> <span />
        </div>
        <form className="om-auth-form" onSubmit={submit}>
          <label htmlFor="email">Email address</label>
          <div className="om-input-wrap">
            <Icon name="user" size={17} />
            <input
              autoComplete="email"
              id="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              type="email"
              value={email}
            />
          </div>
          <label htmlFor="password">Password</label>
          <div className="om-input-wrap">
            <Icon name="lock" size={17} />
            <input
              autoComplete="current-password"
              id="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
              type="password"
              value={password}
            />
          </div>
          <p className="om-field-note">
            Your password is posted only to the configured Better Auth server at{" "}
            <strong>{baseUrl}</strong>; the web app uses its HttpOnly session cookie.
          </p>
          {message ? (
            <p className="om-form-message om-form-message--warning" role="status">
              {message}
            </p>
          ) : null}
          {error ? (
            <p className="om-form-message" role="alert">
              {errorMessage(error, "We could not open that session.")}
            </p>
          ) : null}
          <Button disabled={signingIn} type="submit">
            {signingIn ? "Signing in…" : "Open my workspace"} <Icon name="arrowUp" size={15} />
          </Button>
        </form>
        <div className="om-auth-secondary">
          <span>Already signed in on this browser?</span>
          <Button
            onClick={() => {
              setMessage("");
              onRetry();
            }}
            variant="quiet"
            type="button"
          >
            Try browser session
          </Button>
        </div>
      </main>
      <p className="om-auth-screen__foot">
        <Icon name="lock" size={13} /> No account data is seeded here. You connect to your own
        OpenMuse server.
      </p>
    </div>
  );
}

function WorkspaceOnboarding() {
  const { createWorkspace, error, refresh } = useWorkspace();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setMessage("Give your workspace a name to continue.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      await createWorkspace(name.trim());
    } catch (cause: unknown) {
      setMessage(errorMessage(cause, "We could not create that workspace."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="om-onboarding">
      <div className="om-onboarding__halo" />
      <div className="om-onboarding__copy">
        <span className="om-eyebrow">Your first room</span>
        <h1>
          Make space for
          <br />
          <em>the good stuff.</em>
        </h1>
        <p>
          A workspace is where your conversations, goals, approvals, and connected tools stay
          together.
        </p>
      </div>
      <Card className="om-onboarding__card">
        <span className="om-onboarding__icon">
          <Icon name="grid" size={21} />
        </span>
        <h2>Name your workspace</h2>
        <p>This is the place you’ll return to. You can invite people and connect services later.</p>
        <form className="om-form" onSubmit={submit}>
          <label htmlFor="workspace-name">Workspace name</label>
          <input
            autoFocus
            id="workspace-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Studio, Home, Research"
            value={name}
          />
          {message || error ? (
            <p className="om-form-message" role="alert">
              {message || errorMessage(error, "Unable to load your workspaces.")}
            </p>
          ) : null}
          <Button disabled={saving} type="submit">
            {saving ? "Creating…" : "Create workspace"}
            <Icon name="arrowUp" size={15} />
          </Button>
          {error ? (
            <Button disabled={saving} onClick={() => void refresh()} type="button" variant="quiet">
              Try again
            </Button>
          ) : null}
        </form>
      </Card>
    </div>
  );
}

function WorkspaceError() {
  const { error, refresh } = useWorkspace();
  return (
    <div className="om-centered-content">
      <EmptyState
        action={
          <Button onClick={() => void refresh()}>
            <Icon name="refresh" size={16} /> Try again
          </Button>
        }
        description={errorMessage(error, "The workspace list could not be loaded.")}
        icon="alert"
        title="Your workspace is out of reach"
      />
    </div>
  );
}

function WorkspaceMenu({ onClose }: { onClose: () => void }) {
  const { workspaces, workspace, selectWorkspace } = useWorkspace();
  return (
    <div className="om-workspace-menu" role="dialog" aria-label="Choose workspace">
      <div className="om-workspace-menu__heading">
        <span>Switch workspace</span>
        <IconButton label="Close workspace menu" onClick={onClose}>
          <Icon name="close" size={15} />
        </IconButton>
      </div>
      {workspaces.map((item) => (
        <button
          className={item.id === workspace?.id ? "is-active" : ""}
          key={item.id}
          onClick={() => {
            selectWorkspace(item.id);
            onClose();
          }}
          type="button"
        >
          <span>{initials(item.name)}</span>
          <strong>{item.name}</strong>
          <small>{item.role}</small>
          {item.id === workspace?.id ? <Icon name="check" size={15} /> : null}
        </button>
      ))}
    </div>
  );
}

function WorkspaceLayout({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { signOut } = useOpenMuse();
  const { workspace } = useWorkspace();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const activeHref =
    navigationItems.find(
      (item) => location.pathname === item.href || location.pathname.startsWith(`${item.href}/`),
    )?.href ?? "/";
  const sidebarItems = navigationItems as SidebarItem[];
  const userLabel = "Your account";

  return (
    <div className="om-app-shell">
      <Sidebar
        activeHref={activeHref}
        items={sidebarItems}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        onNavigate={(href) => void navigate({ to: href })}
        onNewConversation={() => void navigate({ to: "/conversations" })}
        onUserClick={() => void navigate({ to: "/settings" })}
        onWorkspaceClick={() => setWorkspaceMenuOpen((value) => !value)}
        userLabel={userLabel}
        workspaceName={workspace?.name ?? "Workspace"}
        workspaceRole={workspace?.role ?? "member"}
      />
      {workspaceMenuOpen ? <WorkspaceMenu onClose={() => setWorkspaceMenuOpen(false)} /> : null}
      <button
        className="om-shell-signout"
        onClick={() => {
          setSignOutError("");
          void signOut().catch((cause: unknown) => {
            setSignOutError(errorMessage(cause, "The session could not be closed."));
          });
        }}
        type="button"
      >
        <Icon name="close" size={13} /> Sign out
      </button>
      {signOutError ? (
        <div className="om-shell-signout-error" role="alert">
          {signOutError}
        </div>
      ) : null}
      <main className="om-main">
        <header className="om-mobile-header">
          <IconButton label="Open navigation" onClick={() => setMobileOpen(true)}>
            <Icon name="menu" />
          </IconButton>
          <a
            href="/"
            onClick={(event) => {
              event.preventDefault();
              void navigate({ to: "/" });
            }}
          >
            <span>
              <Icon name="spark" size={15} />
            </span>
            openmuse
          </a>
          <IconButton label="Open settings" onClick={() => void navigate({ to: "/settings" })}>
            <Icon name="settings" />
          </IconButton>
        </header>
        <div className="om-main__inner">{children ?? <Outlet />}</div>
      </main>
    </div>
  );
}

function AuthenticatedApp() {
  const { isLoading, error, workspace } = useWorkspace();
  if (isLoading) return <LoadingScreen label="Finding your workspace…" />;
  if (error) return <WorkspaceError />;
  if (!workspace) return <WorkspaceOnboarding />;
  return (
    <WorkspaceLayout>
      <Outlet />
    </WorkspaceLayout>
  );
}

export function RootLayout() {
  const { isSignedOut, retrySession } = useOpenMuse();
  const sessionQuery = useSessionQuery();
  if (isSignedOut)
    return <LoginScreen error={null} onRetry={retrySession} />;
  if (sessionQuery.isPending) return <LoadingScreen />;
  if (!sessionQuery.data)
    return <LoginScreen error={sessionQuery.error} onRetry={() => void sessionQuery.refetch()} />;
  return (
    <WorkspaceProvider session={sessionQuery.data}>
      <AuthenticatedApp />
    </WorkspaceProvider>
  );
}
