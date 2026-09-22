import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  Approval,
  Connection,
  Goal,
  Message,
  ProviderInstance,
  Schedule,
} from "@openmuse/contracts";
import { ApiClientError } from "@openmuse/client";
import { Button, Badge, Card, EmptyState, Icon, IconButton, PageHeader } from "@openmuse/ui-web";
import { useOpenMuse, useSessionQuery, useWorkspace } from "./context";
import {
  formatBytes,
  formatDate,
  formatRelativeTime,
  makeClientMessageId,
  partLabel,
  providerTone,
  scheduleLabel,
} from "./lib";
import { saveProviderSetup } from "./provider-setup";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function ErrorNotice({
  error,
  fallback,
  onRetry,
}: {
  error: unknown;
  fallback: string;
  onRetry?: () => void;
}) {
  return (
    <div className="om-error-notice" role="alert">
      <Icon name="alert" size={17} />
      <span>{errorMessage(error, fallback)}</span>
      {onRetry ? (
        <Button onClick={onRetry} variant="quiet">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function ModalDialog({
  children,
  labelledBy,
  onClose,
}: {
  children: ReactNode;
  labelledBy: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <div className="om-modal-backdrop" role="presentation">
      <dialog
        aria-labelledby={labelledBy}
        aria-modal="true"
        className="om-modal"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
        ref={dialogRef}
      >
        {children}
      </dialog>
    </div>
  );
}

function SectionTitle({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div className="om-section-title">
      <h2>{label}</h2>
      {action}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={providerTone(status)}>{status.replaceAll("_", " ")}</Badge>;
}

export function OverviewPage() {
  const navigate = useNavigate();
  const { api } = useOpenMuse();
  const { workspace } = useWorkspace();
  const conversationsQuery = useQuery({
    queryKey: ["conversations", workspace?.id],
    queryFn: () => api.listConversations(workspace!.id, { limit: 5 }),
    enabled: Boolean(workspace),
  });
  const goalsQuery = useQuery({
    queryKey: ["goals", workspace?.id],
    queryFn: () => api.listGoals(workspace!.id, { limit: 5 }),
    enabled: Boolean(workspace),
  });
  const approvalsQuery = useQuery({
    queryKey: ["approvals", workspace?.id],
    queryFn: () => api.listApprovals({ limit: 5 }),
    enabled: Boolean(workspace),
  });
  const artifactsQuery = useQuery({
    queryKey: ["artifacts", workspace?.id],
    queryFn: () => api.listArtifacts(workspace!.id, { limit: 5 }),
    enabled: Boolean(workspace),
  });

  return (
    <div className="om-page om-page--overview">
      <div className="om-overview-intro">
        <div>
          <span className="om-eyebrow">A little room to think</span>
          <h1>
            Make something
            <br />
            <em>worth keeping.</em>
          </h1>
          <p>Conversations become goals. Goals become useful work. OpenMuse keeps the thread.</p>
        </div>
        <div className="om-overview-intro__orbit">
          <span className="om-orbit__dot om-orbit__dot--one" />
          <span className="om-orbit__dot om-orbit__dot--two" />
          <span className="om-orbit__ring" />
          <Icon name="spark" size={29} />
        </div>
      </div>
      <div className="om-overview-actions">
        <Button onClick={() => void navigate({ to: "/conversations" })}>
          <Icon name="plus" size={16} /> Start a conversation
        </Button>
        <Button onClick={() => void navigate({ to: "/goals" })} variant="outline">
          <Icon name="goal" size={16} /> Set a goal
        </Button>
      </div>

      <div className="om-stats-strip" aria-label="Workspace overview">
        <div>
          <span className="om-stat-number">{conversationsQuery.data?.items.length ?? "—"}</span>
          <span className="om-stat-label">Conversations</span>
        </div>
        <div>
          <span className="om-stat-number">
            {goalsQuery.data?.items.filter((goal) => goal.status === "active").length ?? "—"}
          </span>
          <span className="om-stat-label">Active goals</span>
        </div>
        <div>
          <span className="om-stat-number">
            {approvalsQuery.data?.items.filter((approval) => approval.status === "pending")
              .length ?? "—"}
          </span>
          <span className="om-stat-label">Need review</span>
        </div>
        <div>
          <span className="om-stat-number">{artifactsQuery.data?.items.length ?? "—"}</span>
          <span className="om-stat-label">Artifacts</span>
        </div>
      </div>

      <div className="om-overview-grid">
        <Card className="om-overview-card om-overview-card--wide">
          <SectionTitle
            label="Recent conversations"
            action={
              <Button onClick={() => void navigate({ to: "/conversations" })} variant="quiet">
                See all <Icon name="chevronRight" size={14} />
              </Button>
            }
          />
          {conversationsQuery.error ? (
            <ErrorNotice
              error={conversationsQuery.error}
              fallback="Conversations could not be loaded."
              onRetry={() => void conversationsQuery.refetch()}
            />
          ) : conversationsQuery.data?.items.length ? (
            <div className="om-list om-list--compact">
              {conversationsQuery.data.items.slice(0, 4).map((conversation) => (
                <button
                  className="om-list-row om-list-row--button"
                  key={conversation.id}
                  onClick={() =>
                    void navigate({
                      to: "/conversations/$conversationId",
                      params: { conversationId: conversation.id },
                    })
                  }
                  type="button"
                >
                  <span className="om-list-row__glyph">
                    <Icon name="message" size={17} />
                  </span>
                  <span className="om-list-row__copy">
                    <strong>{conversation.title || "Untitled conversation"}</strong>
                    <small>
                      {conversation.metadata?.preview &&
                      typeof conversation.metadata.preview === "string"
                        ? conversation.metadata.preview
                        : "No message preview yet"}
                    </small>
                  </span>
                  <span className="om-list-row__time">
                    {formatRelativeTime(conversation.updatedAt)}
                  </span>
                  <Icon name="chevronRight" size={15} />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              description="Start with a thought, a question, or a half-formed idea. Nothing is added until you do."
              icon="message"
              title="Your conversation list is quiet"
              action={
                <Button onClick={() => void navigate({ to: "/conversations" })}>
                  Open conversations
                </Button>
              }
            />
          )}
        </Card>
        <Card className="om-overview-card">
          <SectionTitle
            label="In motion"
            action={
              <Button onClick={() => void navigate({ to: "/goals" })} variant="quiet">
                Goals <Icon name="chevronRight" size={14} />
              </Button>
            }
          />
          {goalsQuery.error ? (
            <ErrorNotice error={goalsQuery.error} fallback="Goals could not be loaded." />
          ) : goalsQuery.data?.items.filter((goal) => goal.status === "active").length ? (
            <div className="om-goal-stack">
              {goalsQuery.data.items
                .filter((goal) => goal.status === "active")
                .slice(0, 3)
                .map((goal) => (
                  <button
                    className="om-goal-mini"
                    key={goal.id}
                    onClick={() => void navigate({ to: "/goals" })}
                    type="button"
                  >
                    <span className="om-goal-mini__mark">
                      <Icon name="target" size={17} />
                    </span>
                    <span>
                      <strong>{goal.title}</strong>
                      <small>{scheduleLabel(goal.schedule)}</small>
                    </span>
                    <Icon name="chevronRight" size={14} />
                  </button>
                ))}
            </div>
          ) : (
            <div className="om-card-empty">
              <Icon name="target" size={20} />
              <p>No active goals yet.</p>
              <Button onClick={() => void navigate({ to: "/goals" })} variant="quiet">
                Create one
              </Button>
            </div>
          )}
        </Card>
        <Card className="om-overview-card">
          <SectionTitle
            label="Needs your eye"
            action={
              <Button onClick={() => void navigate({ to: "/approvals" })} variant="quiet">
                Review <Icon name="chevronRight" size={14} />
              </Button>
            }
          />
          {approvalsQuery.error ? (
            <ErrorNotice error={approvalsQuery.error} fallback="Approvals could not be loaded." />
          ) : approvalsQuery.data?.items.filter((approval) => approval.status === "pending")
              .length ? (
            <div className="om-approval-stack">
              {approvalsQuery.data.items
                .filter((approval) => approval.status === "pending")
                .slice(0, 3)
                .map((approval) => (
                  <button
                    className="om-approval-mini"
                    key={approval.id}
                    onClick={() => void navigate({ to: "/approvals" })}
                    type="button"
                  >
                    <span className="om-approval-mini__dot" />
                    <span>
                      <strong>
                        {approval.target?.action && typeof approval.target.action === "string"
                          ? approval.target.action
                          : "Connected action"}
                      </strong>
                      <small>Expires {formatDate(approval.expiresAt)}</small>
                    </span>
                    <Icon name="chevronRight" size={14} />
                  </button>
                ))}
            </div>
          ) : (
            <div className="om-card-empty">
              <Icon name="checkCircle" size={20} />
              <p>Nothing waiting for approval.</p>
              <span>When an action needs your say, it will appear here.</span>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export function ConversationsPage() {
  const navigate = useNavigate();
  const { api } = useOpenMuse();
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["conversations", workspace?.id],
    queryFn: () => api.listConversations(workspace!.id, { limit: 100 }),
    enabled: Boolean(workspace),
  });
  const createMutation = useMutation({
    mutationFn: () =>
      api.createConversation({
        workspaceId: workspace!.id,
        title: "New conversation",
        visibility: "private",
      }),
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: ["conversations", workspace?.id] });
      void navigate({
        to: "/conversations/$conversationId",
        params: { conversationId: conversation.id },
      });
    },
  });
  const conversations =
    query.data?.items.filter((conversation) =>
      conversation.title.toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? [];

  return (
    <div className="om-page">
      <PageHeader
        description="A running thread for questions, drafts, and the ideas you are not ready to lose."
        eyebrow="The thread"
        title="Conversations"
        actions={
          <Button disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
            <Icon name="plus" size={16} />
            {createMutation.isPending ? "Opening…" : "New conversation"}
          </Button>
        }
      />
      {createMutation.error ? (
        <ErrorNotice
          error={createMutation.error}
          fallback="The conversation could not be created."
        />
      ) : null}
      <Card className="om-conversations-card">
        <div className="om-search-row">
          <label className="om-search">
            <Icon name="search" size={17} />
            <input
              aria-label="Search conversations"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search the thread"
              value={search}
            />
          </label>
          <span className="om-search-row__count">
            {query.data
              ? `${conversations.length} ${conversations.length === 1 ? "conversation" : "conversations"}`
              : "Loading…"}
          </span>
        </div>
        {query.error ? (
          <ErrorNotice
            error={query.error}
            fallback="Conversations could not be loaded."
            onRetry={() => void query.refetch()}
          />
        ) : conversations.length ? (
          <div className="om-list">
            {conversations.map((conversation) => (
              <button
                className="om-list-row om-list-row--button om-conversation-row"
                key={conversation.id}
                onClick={() =>
                  void navigate({
                    to: "/conversations/$conversationId",
                    params: { conversationId: conversation.id },
                  })
                }
                type="button"
              >
                <span className="om-list-row__glyph">
                  <Icon name="message" size={18} />
                </span>
                <span className="om-list-row__copy">
                  <strong>{conversation.title || "Untitled conversation"}</strong>
                  <small>
                    {conversation.metadata?.preview &&
                    typeof conversation.metadata.preview === "string"
                      ? conversation.metadata.preview
                      : "No messages yet — open to begin."}
                  </small>
                </span>
                <Badge tone={conversation.status === "archived" ? "neutral" : "sage"}>
                  {conversation.status}
                </Badge>
                <span className="om-list-row__time">
                  {formatRelativeTime(conversation.updatedAt)}
                </span>
                <Icon name="chevronRight" size={16} />
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            description={
              search
                ? "Try a different phrase or clear the search."
                : "Your first conversation can be messy. That is what this space is for."
            }
            icon="message"
            title={search ? "No matching threads" : "Nothing here yet"}
            action={
              search ? (
                <Button onClick={() => setSearch("")} variant="outline">
                  Clear search
                </Button>
              ) : (
                <Button disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
                  Start the first one
                </Button>
              )
            }
          />
        )}
      </Card>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.author.type === "user";
  return (
    <article className={`om-message ${isUser ? "om-message--user" : ""}`}>
      <div className="om-message__avatar">
        {isUser ? <Icon name="user" size={16} /> : <Icon name="spark" size={16} />}
      </div>
      <div className="om-message__body">
        <div className="om-message__meta">
          <strong>
            {isUser ? "You" : message.author.type === "tool" ? message.author.toolName : "OpenMuse"}
          </strong>
          <span>{formatRelativeTime(message.createdAt)}</span>
        </div>
        <div className="om-message__bubble">
          {message.parts.map((part, index) => (
            <div className="om-message__part" key={`${message.id}-${index}`}>
              {partLabel(part) ? (
                <Badge tone={part.type === "approvalRef" ? "coral" : "neutral"}>
                  {partLabel(part)}
                </Badge>
              ) : null}
              {part.type === "text" || part.type === "reasoning" ? (
                <p className={part.type === "reasoning" ? "is-reasoning" : ""}>{part.text}</p>
              ) : part.type === "citation" ? (
                <a href={part.url} rel="noreferrer" target="_blank">
                  {part.title ?? part.url}
                  <Icon name="external" size={13} />
                </a>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function ShareConversationPanel({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const { api } = useOpenMuse();
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [recipientEmail, setRecipientEmail] = useState("");
  const [message, setMessage] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api.createShare({
        resourceType: "conversation",
        resourceId: conversationId,
        subjectType: "user",
        recipientEmail: recipientEmail.trim(),
      }),
    onSuccess: async () => {
      setMessage("Read-only access granted.");
      await queryClient.invalidateQueries({ queryKey: ["shares", workspace?.id] });
    },
  });
  return (
    <ModalDialog labelledBy="share-title" onClose={onClose}>
      <div className="om-modal__heading">
        <div>
          <span className="om-eyebrow">Read-only snapshot</span>
          <h2 id="share-title">Share this conversation</h2>
        </div>
        <IconButton label="Close share dialog" onClick={onClose}>
          <Icon name="close" />
        </IconButton>
      </div>
      <p>
        Share access is explicit and read-only. Enter a workspace member’s email; the server
        resolves the recipient and never trusts a browser-supplied user ID.
      </p>
      <form
        className="om-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (recipientEmail.trim()) mutation.mutate();
        }}
      >
        <label htmlFor="share-subject">Recipient email</label>
        <input
          autoComplete="email"
          id="share-subject"
          onChange={(event) => setRecipientEmail(event.target.value)}
          placeholder="member@example.com"
          type="email"
          value={recipientEmail}
        />
        {message ? (
          <p className="om-form-message om-form-message--success" role="status">
            {message}
          </p>
        ) : null}
        {mutation.error ? (
          <p className="om-form-message" role="alert">
            {errorMessage(mutation.error, "The share could not be created.")}
          </p>
        ) : null}
        <div className="om-modal__actions">
          <Button onClick={onClose} type="button" variant="quiet">
            Cancel
          </Button>
          <Button disabled={mutation.isPending || !recipientEmail.trim()} type="submit">
            {mutation.isPending ? "Sharing…" : "Share read-only"}
            <Icon name="arrowUp" size={15} />
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function ConversationPage() {
  const navigate = useNavigate();
  const { conversationId } = useParams({ from: "/conversations/$conversationId" });
  const { api } = useOpenMuse();
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [composerNotice, setComposerNotice] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [runLabel, setRunLabel] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const conversationQuery = useQuery({
    queryKey: ["conversation", workspace?.id, conversationId],
    queryFn: () => api.getConversation(conversationId),
    enabled: Boolean(workspace),
  });
  const messagesQuery = useQuery({
    queryKey: ["messages", workspace?.id, conversationId],
    queryFn: () => api.listMessages(conversationId, { limit: 100 }),
    enabled: Boolean(workspace),
  });
  const providersQuery = useQuery({
    queryKey: ["providers", "model", workspace?.id],
    queryFn: () => api.listProviders({ module: "model", includeUnavailable: true }),
    enabled: Boolean(workspace),
  });
  const sendMutation = useMutation({
    mutationFn: () =>
      api.sendMessage({
        conversationId,
        parts: [{ type: "text", text: draft.trim() }],
        clientMessageId: makeClientMessageId(),
      }),
    onSuccess: async (result) => {
      setDraft("");
      setAttachment(null);
      setComposerNotice("");
      await queryClient.invalidateQueries({
        queryKey: ["messages", workspace?.id, conversationId],
      });
      if (!result.run) return;
      setRunLabel("Run queued · listening for updates");
      void (async () => {
        try {
          for await (const event of api.pollRunEvents(result.run!.id, { pollMs: 700 })) {
            if (event.type === "run.progress") setRunLabel("Working through it…");
            if (event.type === "run.waiting_approval") setRunLabel("Waiting for your approval");
            if (event.type === "run.completed") setRunLabel("Run complete");
            if (event.type === "run.failed") setRunLabel("Run needs attention");
          }
          await queryClient.invalidateQueries({
            queryKey: ["messages", workspace?.id, conversationId],
          });
        } catch (cause: unknown) {
          setRunLabel(errorMessage(cause, "Run updates are unavailable; refresh to check status."));
        }
      })();
    },
  });
  const messageItems = messagesQuery.data?.items ?? [];
  const messages = messageItems.reduce<typeof messageItems>((ordered, message) => {
    const insertAt = ordered.findIndex((item) => item.sequence > message.sequence);
    if (insertAt === -1) {
      ordered.push(message);
      return ordered;
    }
    ordered.splice(insertAt, 0, message);
    return ordered;
  }, []);
  const title = conversationQuery.data?.title || "New conversation";
  const hasProviders = providersQuery.data?.some((provider) => provider.status === "available");

  function onAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setAttachment(file);
    setComposerNotice(
      file
        ? "This file is selected locally. The current client contract needs an artifact upload before it can be sent."
        : "",
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) {
      setComposerNotice("Write something first — even a rough sentence is enough.");
      return;
    }
    if (attachment) {
      setComposerNotice(
        "This attachment has not been uploaded, so it was not sent. Remove it or finish storage setup first.",
      );
      return;
    }
    setComposerNotice("");
    sendMutation.mutate();
  }

  return (
    <div className="om-page om-page--conversation">
      <div className="om-conversation-heading">
        <div>
          <span className="om-eyebrow">Conversation</span>
          <h1>{title}</h1>
          <p>{workspace?.name} · private thread</p>
        </div>
        <div className="om-conversation-heading__actions">
          <Button onClick={() => setShareOpen(true)} variant="outline">
            <Icon name="lock" size={15} /> Share read-only
          </Button>
          <IconButton label="More conversation actions">
            <Icon name="more" />
          </IconButton>
        </div>
      </div>
      {messagesQuery.error || conversationQuery.error ? (
        <ErrorNotice
          error={messagesQuery.error ?? conversationQuery.error}
          fallback="This conversation could not be loaded."
          onRetry={() => {
            void messagesQuery.refetch();
            void conversationQuery.refetch();
          }}
        />
      ) : null}
      <div className="om-conversation-layout">
        <section className="om-message-column">
          <div className="om-message-scroll" aria-live="polite">
            {messages.length ? (
              messages.map((message) => <MessageBubble key={message.id} message={message} />)
            ) : (
              <EmptyState
                description="Ask a question, sketch a plan, or leave yourself a useful note."
                icon="spark"
                title="Where should we begin?"
              />
            )}
          </div>
          {runLabel ? (
            <div className="om-run-banner">
              <Icon name="spinner" size={16} />
              <span>{runLabel}</span>
              <Button
                onClick={() => {
                  setRunLabel("");
                  void queryClient.invalidateQueries({
                    queryKey: ["messages", workspace?.id, conversationId],
                  });
                }}
                variant="quiet"
              >
                Dismiss
              </Button>
            </div>
          ) : null}
          <form className="om-composer" onSubmit={submit}>
            <textarea
              aria-label="Message OpenMuse"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="What are you thinking about?"
              rows={3}
              value={draft}
            />
            <div className="om-composer__footer">
              <div className="om-composer__tools">
                <input
                  accept="image/*,.pdf,.txt,.md,.doc,.docx"
                  hidden
                  onChange={onAttachment}
                  ref={fileInput}
                  type="file"
                />
                <IconButton
                  label="Attach a file"
                  onClick={() => fileInput.current?.click()}
                  type="button"
                >
                  <Icon name="paperclip" size={18} />
                </IconButton>
                <IconButton
                  label="Start live voice"
                  onClick={() =>
                    setComposerNotice(
                      "Live voice needs a connected realtime provider. Visit Connections to set one up.",
                    )
                  }
                  type="button"
                >
                  <Icon name="mic" size={18} />
                </IconButton>
                <select aria-label="Choose model provider" defaultValue="">
                  <option value="">
                    {hasProviders ? "Server-selected model" : "No model connected"}
                  </option>
                  {providersQuery.data
                    ?.filter((provider) => provider.status === "available")
                    .map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName}
                      </option>
                    ))}
                </select>
                {attachment ? (
                  <span className="om-attachment-chip">
                    <Icon name="file" size={14} />
                    {attachment.name}
                    <IconButton
                      label="Remove selected attachment"
                      onClick={() => {
                        setAttachment(null);
                        setComposerNotice("");
                      }}
                      type="button"
                    >
                      <Icon name="close" size={13} />
                    </IconButton>
                  </span>
                ) : null}
              </div>
              <Button disabled={sendMutation.isPending} type="submit">
                {sendMutation.isPending ? "Sending…" : "Send"}
                <Icon name="send" size={15} />
              </Button>
            </div>
            {composerNotice ? (
              <p className="om-composer__notice" role="status">
                <Icon name="alert" size={14} />
                {composerNotice}
              </p>
            ) : null}
            {sendMutation.error ? (
              <p className="om-form-message" role="alert">
                {errorMessage(sendMutation.error, "Your message could not be sent.")}
              </p>
            ) : null}
          </form>
        </section>
        <aside className="om-conversation-aside">
          <Card>
            <SectionTitle label="Thread notes" />
            <p className="om-aside-copy">
              This conversation is private to your workspace. When a run needs a connected action,
              OpenMuse will pause here for your approval.
            </p>
            <div className="om-aside-rule" />
            <div className="om-aside-stat">
              <span>
                <Icon name="lock" size={14} /> Visibility
              </span>
              <strong>Private</strong>
            </div>
            <div className="om-aside-stat">
              <span>
                <Icon name="wand" size={14} /> Provider
              </span>
              <strong>{hasProviders ? "Available" : "Not connected"}</strong>
            </div>
          </Card>
          <Card>
            <SectionTitle
              label="Artifacts"
              action={
                <Button onClick={() => void navigateToArtifacts()} variant="quiet">
                  View <Icon name="chevronRight" size={14} />
                </Button>
              }
            />
            <p className="om-aside-copy">
              Files and outputs created in this thread will appear here.
            </p>
          </Card>
        </aside>
      </div>
      {shareOpen ? (
        <ShareConversationPanel
          conversationId={conversationId}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
    </div>
  );

  function navigateToArtifacts() {
    void navigate({ to: "/artifacts" });
  }
}

export function GoalsPage() {
  const { api } = useOpenMuse();
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["goals", workspace?.id],
    queryFn: () => api.listGoals(workspace!.id, { limit: 100 }),
    enabled: Boolean(workspace),
  });
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [scheduleKind, setScheduleKind] = useState<"none" | "once" | "interval" | "cron">("none");
  const [scheduleValue, setScheduleValue] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const createMutation = useMutation({
    mutationFn: () =>
      api.createGoal({
        workspaceId: workspace!.id,
        title: title.trim(),
        instructions: instructions.trim(),
        schedule: makeSchedule(scheduleKind, scheduleValue, timezone),
        connectionIds: [],
        memoryIds: [],
      }),
    onSuccess: async () => {
      setTitle("");
      setInstructions("");
      setScheduleKind("none");
      setScheduleValue("");
      await queryClient.invalidateQueries({ queryKey: ["goals", workspace?.id] });
    },
  });
  const statusMutation = useMutation({
    mutationFn: ({ goal, status }: { goal: Goal; status: "active" | "paused" | "completed" }) =>
      api.changeGoalStatus(goal.id, { status, expectedRevision: goal.revision }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["goals", workspace?.id] });
    },
  });
  const scheduleReady = scheduleKind === "none" || scheduleValue.trim().length > 0;

  return (
    <div className="om-page">
      <PageHeader
        description="Small, explicit instructions that can keep moving while you are elsewhere."
        eyebrow="The long view"
        title="Goals"
      />
      <div className="om-goals-layout">
        <Card className="om-goal-form-card">
          <SectionTitle label="Set a goal" />
          <p className="om-form-intro">
            Give OpenMuse a clear outcome. You decide what it can access and when it runs.
          </p>
          <form
            className="om-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (title.trim() && instructions.trim() && scheduleReady) createMutation.mutate();
            }}
          >
            <label htmlFor="goal-title">Title</label>
            <input
              id="goal-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Summarize the week"
              value={title}
            />
            <label htmlFor="goal-instructions">Instructions</label>
            <textarea
              id="goal-instructions"
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="What should OpenMuse do, and what should it leave alone?"
              rows={5}
              value={instructions}
            />
            <label htmlFor="goal-schedule">Schedule</label>
            <select
              id="goal-schedule"
              onChange={(event) => {
                setScheduleKind(event.target.value as typeof scheduleKind);
                setScheduleValue("");
              }}
              value={scheduleKind}
            >
              <option value="none">On demand</option>
              <option value="once">Once</option>
              <option value="interval">Every interval</option>
              <option value="cron">Cron expression</option>
            </select>
            {scheduleKind === "once" ? (
              <input
                aria-label="Run at"
                onChange={(event) => setScheduleValue(event.target.value)}
                type="datetime-local"
                value={scheduleValue}
              />
            ) : null}
            {scheduleKind === "interval" ? (
              <input
                aria-label="Minutes between runs"
                min="1"
                onChange={(event) => setScheduleValue(event.target.value)}
                placeholder="Minutes between runs"
                type="number"
                value={scheduleValue}
              />
            ) : null}
            {scheduleKind === "cron" ? (
              <input
                aria-label="Cron expression"
                onChange={(event) => setScheduleValue(event.target.value)}
                placeholder="0 9 * * 1-5"
                value={scheduleValue}
              />
            ) : null}
            {scheduleKind !== "none" ? (
              <input
                aria-label="Timezone"
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="Timezone"
                value={timezone}
              />
            ) : null}
            {createMutation.error ? (
              <p className="om-form-message" role="alert">
                {errorMessage(createMutation.error, "The goal could not be created.")}
              </p>
            ) : null}
            <Button
              disabled={
                createMutation.isPending || !title.trim() || !instructions.trim() || !scheduleReady
              }
              type="submit"
            >
              {createMutation.isPending ? "Saving…" : "Save goal"}
              <Icon name="arrowUp" size={15} />
            </Button>
          </form>
        </Card>
        <section className="om-goal-list">
          <div className="om-section-title">
            <h2>All goals</h2>
            <span className="om-section-count">{query.data?.items.length ?? "—"}</span>
          </div>
          {query.error ? (
            <ErrorNotice
              error={query.error}
              fallback="Goals could not be loaded."
              onRetry={() => void query.refetch()}
            />
          ) : query.data?.items.length ? (
            <div className="om-goal-cards">
              {query.data.items.map((goal) => (
                <Card className="om-goal-card" key={goal.id}>
                  <div className="om-goal-card__top">
                    <span className="om-goal-card__mark">
                      <Icon name="target" size={18} />
                    </span>
                    <StatusBadge status={goal.status} />
                  </div>
                  <h3>{goal.title}</h3>
                  <p>{goal.instructions}</p>
                  <div className="om-goal-card__meta">
                    <span>
                      <Icon name="calendar" size={14} />
                      {scheduleLabel(goal.schedule)}
                    </span>
                    <span>
                      <Icon name="refresh" size={14} />
                      Revision {goal.revision}
                    </span>
                  </div>
                  <div className="om-goal-card__actions">
                    {goal.status !== "completed" ? (
                      <Button
                        disabled={statusMutation.isPending}
                        onClick={() =>
                          statusMutation.mutate({
                            goal,
                            status: goal.status === "active" ? "paused" : "active",
                          })
                        }
                        variant="quiet"
                      >
                        <Icon name={goal.status === "active" ? "clock" : "arrowUp"} size={15} />
                        {goal.status === "active" ? "Pause" : "Resume"}
                      </Button>
                    ) : null}
                    {goal.status !== "completed" ? (
                      <Button
                        disabled={statusMutation.isPending}
                        onClick={() => statusMutation.mutate({ goal, status: "completed" })}
                        variant="outline"
                      >
                        Complete
                      </Button>
                    ) : null}
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState
                description="A goal gives a good idea somewhere to land. Create one when you are ready."
                icon="goal"
                title="No goals yet"
              />
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

function makeSchedule(
  kind: "none" | "once" | "interval" | "cron",
  value: string,
  timezone: string,
): Schedule | null {
  if (kind === "none") return null;
  if (kind === "once") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : { kind, at: new Date(timestamp).toISOString() };
  }
  if (kind === "interval") {
    const everySeconds = Number(value) * 60;
    return Number.isFinite(everySeconds)
      ? { kind, everySeconds: Math.min(31_536_000, Math.max(60, everySeconds)), timezone }
      : null;
  }
  if (!value.trim()) return null;
  return { kind, expression: value.trim(), timezone };
}

export function ApprovalsPage() {
  const { api } = useOpenMuse();
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["approvals", workspace?.id],
    queryFn: () => api.listApprovals({ limit: 100 }),
    enabled: Boolean(workspace),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    query.data?.items.find((approval) => approval.id === selectedId) ??
    query.data?.items[0] ??
    null;
  const decisionMutation = useMutation({
    mutationFn: ({ approval, decision }: { approval: Approval; decision: "approve" | "deny" }) =>
      api.decideApproval(approval.id, { decision, expectedDigest: approval.digest }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["approvals", workspace?.id] });
    },
  });
  return (
    <div className="om-page">
      <PageHeader
        description="OpenMuse pauses before consequential actions. You decide what happens next."
        eyebrow="Your say"
        title="Approvals"
        actions={
          <Badge tone="coral">
            <Icon name="lock" size={13} /> Explicit actions only
          </Badge>
        }
      />
      {query.error ? (
        <ErrorNotice
          error={query.error}
          fallback="Approvals could not be loaded."
          onRetry={() => void query.refetch()}
        />
      ) : query.data?.items.length ? (
        <div className="om-approval-layout">
          <Card className="om-approval-list">
            <SectionTitle label="Review queue" />
            <div className="om-list">
              {query.data.items.map((approval) => (
                <button
                  className={`om-list-row om-list-row--button ${approval.id === selected?.id ? "is-selected" : ""}`}
                  key={approval.id}
                  onClick={() => setSelectedId(approval.id)}
                  type="button"
                >
                  <span className="om-list-row__glyph om-list-row__glyph--coral">
                    <Icon name="checkCircle" size={17} />
                  </span>
                  <span className="om-list-row__copy">
                    <strong>
                      {approval.target?.action && typeof approval.target.action === "string"
                        ? approval.target.action
                        : "Connected action"}
                    </strong>
                    <small>
                      {approval.status === "pending"
                        ? "Waiting for your decision"
                        : `Decision: ${approval.status}`}
                    </small>
                  </span>
                  <StatusBadge status={approval.status} />
                </button>
              ))}
            </div>
          </Card>
          <Card className="om-approval-detail">
            {selected ? (
              <>
                <div className="om-detail-heading">
                  <div>
                    <span className="om-eyebrow">Approval detail</span>
                    <h2>
                      {selected.target?.action && typeof selected.target.action === "string"
                        ? selected.target.action
                        : "Connected action"}
                    </h2>
                  </div>
                  <StatusBadge status={selected.status} />
                </div>
                <div className="om-detail-callout">
                  <Icon name="lock" size={18} />
                  <p>
                    This request is bound to a digest and can only be used once. Check the target
                    and expiry before deciding.
                  </p>
                </div>
                <dl className="om-detail-list">
                  <div>
                    <dt>Run</dt>
                    <dd>{selected.runId}</dd>
                  </div>
                  <div>
                    <dt>Connection</dt>
                    <dd>{selected.connectionId ?? "Not specified"}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>
                      {formatDate(selected.expiresAt, { dateStyle: "medium", timeStyle: "short" })}
                    </dd>
                  </div>
                  <div>
                    <dt>Policy</dt>
                    <dd>{selected.policyVersion}</dd>
                  </div>
                </dl>
                <div className="om-json-box">
                  <span className="om-eyebrow">Target payload</span>
                  <pre>{JSON.stringify(selected.target, null, 2)}</pre>
                </div>
                {selected.status === "pending" ? (
                  <div className="om-detail-actions">
                    <Button
                      disabled={decisionMutation.isPending}
                      onClick={() =>
                        decisionMutation.mutate({ approval: selected, decision: "deny" })
                      }
                      variant="danger"
                    >
                      Deny
                    </Button>
                    <Button
                      disabled={decisionMutation.isPending}
                      onClick={() =>
                        decisionMutation.mutate({ approval: selected, decision: "approve" })
                      }
                    >
                      {decisionMutation.isPending ? "Saving…" : "Approve action"}
                      <Icon name="check" size={15} />
                    </Button>
                  </div>
                ) : null}
                {decisionMutation.error ? (
                  <p className="om-form-message" role="alert">
                    {errorMessage(decisionMutation.error, "The decision could not be saved.")}
                  </p>
                ) : null}
              </>
            ) : (
              <EmptyState
                description="There are no pending actions to inspect."
                icon="checkCircle"
                title="The queue is clear"
              />
            )}
          </Card>
        </div>
      ) : (
        <Card>
          <EmptyState
            description="When OpenMuse needs your explicit say, the request will appear here with its target, digest, and expiry."
            icon="checkCircle"
            title="Nothing needs your approval"
          />
        </Card>
      )}
    </div>
  );
}

function ConnectionRow({ connection }: { connection: Connection }) {
  return (
    <div className="om-connection-row">
      <span className={`om-connection-row__logo om-connection-row__logo--${connection.app}`}>
        {connection.app === "gmail" ? "G" : "C"}
      </span>
      <span className="om-list-row__copy">
        <strong>{connection.displayName}</strong>
        <small>
          {connection.scopes.length
            ? `${connection.scopes.length} scopes · ${connection.providerId}`
            : connection.providerId}
        </small>
      </span>
      <StatusBadge status={connection.status} />
      <span className="om-list-row__time">
        {connection.lastCheckedAt
          ? `Checked ${formatRelativeTime(connection.lastCheckedAt)}`
          : "Not checked"}
      </span>
    </div>
  );
}

export function ConnectionsPage() {
  const { api } = useOpenMuse();
  const { workspace } = useWorkspace();
  const query = useQuery({
    queryKey: ["connections", workspace?.id],
    queryFn: () => api.listConnections(workspace!.id, { limit: 100 }),
    enabled: Boolean(workspace),
  });
  const [message, setMessage] = useState("");
  const connectMutation = useMutation({
    mutationFn: (app: "gmail" | "calendar") =>
      api.createConnectionIntent({
        workspaceId: workspace!.id,
        app,
        returnPath: window.location.pathname,
      }),
    onSuccess: ({ authorizationUrl }) => {
      window.location.assign(authorizationUrl);
    },
    onError: (cause: unknown) =>
      setMessage(errorMessage(cause, "The connection could not be started.")),
  });
  return (
    <div className="om-page">
      <PageHeader
        description="Give OpenMuse carefully scoped access to the services you already use. Revoke it any time."
        eyebrow="The bridge"
        title="Connections"
      />
      <Card className="om-connect-card">
        <div className="om-connect-card__intro">
          <span className="om-connect-card__symbol">
            <Icon name="link" size={22} />
          </span>
          <div>
            <h2>Connect a service</h2>
            <p>
              OAuth takes place with the service. OpenMuse receives the resulting connection, not
              your password.
            </p>
          </div>
        </div>
        <div className="om-connect-options">
          <button
            disabled={connectMutation.isPending}
            onClick={() => connectMutation.mutate("gmail")}
            type="button"
          >
            <span className="om-connection-row__logo om-connection-row__logo--gmail">G</span>
            <span>
              <strong>Google / Gmail</strong>
              <small>Read and send, only when you ask</small>
            </span>
            <Icon name="external" size={16} />
          </button>
          <button
            disabled={connectMutation.isPending}
            onClick={() => connectMutation.mutate("calendar")}
            type="button"
          >
            <span className="om-connection-row__logo om-connection-row__logo--calendar">C</span>
            <span>
              <strong>Google Calendar</strong>
              <small>Read and create, behind approval</small>
            </span>
            <Icon name="external" size={16} />
          </button>
        </div>
        {message ? (
          <p className="om-form-message" role="alert">
            {message}
          </p>
        ) : null}
      </Card>
      <div className="om-section-title">
        <h2>Connected now</h2>
        <span className="om-section-count">{query.data?.items.length ?? "—"}</span>
      </div>
      {query.error ? (
        <ErrorNotice
          error={query.error}
          fallback="Connections could not be loaded."
          onRetry={() => void query.refetch()}
        />
      ) : query.data?.items.length ? (
        <Card className="om-connection-list">
          {query.data.items.map((connection) => (
            <ConnectionRow connection={connection} key={connection.id} />
          ))}
        </Card>
      ) : (
        <Card>
          <EmptyState
            description="No account is connected to this workspace. Your provider actions will stay unavailable until you choose one."
            icon="link"
            title="Nothing connected"
          />
        </Card>
      )}
    </div>
  );
}

export function ArtifactsPage() {
  const { api } = useOpenMuse();
  const { workspace } = useWorkspace();
  const query = useQuery({
    queryKey: ["artifacts", workspace?.id],
    queryFn: () => api.listArtifacts(workspace!.id, { limit: 100 }),
    enabled: Boolean(workspace),
  });
  return (
    <div className="om-page">
      <PageHeader
        description="Files, images, and snapshots created by a run. OpenMuse never invents a download link."
        eyebrow="The shelf"
        title="Artifacts"
      />
      {query.error ? (
        <ErrorNotice
          error={query.error}
          fallback="Artifacts could not be loaded."
          onRetry={() => void query.refetch()}
        />
      ) : query.data?.items.length ? (
        <Card className="om-artifact-list">
          <div className="om-artifact-list__head">
            <span>Name</span>
            <span>Kind</span>
            <span>Size</span>
            <span>Created</span>
            <span />
          </div>
          {query.data.items.map((artifact) => (
            <div className="om-artifact-row" key={artifact.id}>
              <span className="om-artifact-name">
                <span className="om-artifact-icon">
                  <Icon name="file" size={16} />
                </span>
                <span>
                  <strong>{artifact.name}</strong>
                  <small>{artifact.mimeType}</small>
                </span>
              </span>
              <span>
                <Badge tone="neutral">{artifact.kind}</Badge>
              </span>
              <span>{formatBytes(artifact.sizeBytes)}</span>
              <span>{formatDate(artifact.createdAt)}</span>
              <span>
                {artifact.downloadUrl && !artifact.quarantined ? (
                  <a
                    aria-label={`Download ${artifact.name}`}
                    className="om-icon-button"
                    href={artifact.downloadUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <Icon name="external" size={16} />
                  </a>
                ) : (
                  <Badge tone={artifact.quarantined ? "danger" : "neutral"}>
                    {artifact.quarantined ? "Quarantined" : "Pending"}
                  </Badge>
                )}
              </span>
            </div>
          ))}
        </Card>
      ) : (
        <Card>
          <EmptyState
            description="Artifacts appear after a connected run creates them. You can always see their source and quarantine status here."
            icon="artifact"
            title="The shelf is empty"
          />
        </Card>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  onConfigure,
}: {
  provider: ProviderInstance;
  onConfigure: () => void;
}) {
  const configured = provider.requiredSecrets.filter((secret) => secret.configured).length;
  return (
    <Card className="om-provider-card">
      <div className="om-provider-card__top">
        <div>
          <span className="om-eyebrow">{provider.module}</span>
          <h3>{provider.displayName}</h3>
        </div>
        <StatusBadge status={provider.status} />
      </div>
      <p>
        {provider.providerId} · config {provider.configVersion}
      </p>
      <div className="om-provider-card__capabilities">
        {provider.capabilities.slice(0, 4).map((capability) => (
          <Badge key={capability.key} tone="neutral">
            {capability.key}
          </Badge>
        ))}
      </div>
      <div className="om-provider-card__secret">
        <span>
          <Icon name="lock" size={14} />
          {configured}/{provider.requiredSecrets.length} required keys configured
        </span>
        <Button onClick={onConfigure} variant="quiet">
          Provider setup <Icon name="chevronRight" size={14} />
        </Button>
      </div>
    </Card>
  );
}

function ProviderSetupPanel({
  provider,
  onClose,
}: {
  provider: ProviderInstance;
  onClose: () => void;
}) {
  const { api } = useOpenMuse();
  const sessionQuery = useSessionQuery();
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(provider.displayName);
  const [endpoint, setEndpoint] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const existingInstance = provider.scope !== "system" && provider.workspaceId !== null;
  useEffect(() => {
    setSecrets({});
  }, [sessionQuery.data?.id, workspace?.id]);
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!workspace) throw new Error("Choose a workspace before configuring a provider.");
      const config = {
        ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
        ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
      };
      return saveProviderSetup({
        api,
        provider,
        displayName,
        config,
        secrets,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["providers", "all", workspace?.id] }),
        queryClient.invalidateQueries({ queryKey: ["providers", "model", workspace?.id] }),
      ]);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.status === 409) {
        setSecrets({});
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ["providers", "all", workspace?.id] }),
          queryClient.invalidateQueries({ queryKey: ["providers", "model", workspace?.id] }),
        ]);
      }
    },
    onSettled: () => setSecrets({}),
  });
  const deleteMutation = useMutation({
    mutationFn: () => api.deleteProviderInstance(provider.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["providers", "all", workspace?.id] });
      onClose();
    },
  });

  return (
    <ModalDialog labelledBy="provider-setup-title" onClose={onClose}>
      <div className="om-modal__heading">
        <div>
          <span className="om-eyebrow">Server-side provider instance</span>
          <h2 id="provider-setup-title">Configure {provider.displayName}</h2>
        </div>
        <IconButton label="Close provider setup" onClick={onClose}>
          <Icon name="close" />
        </IconButton>
      </div>
      <p>
        Configuration is sent to your OpenMuse server. Secrets are write-only, encrypted there, and
        cleared from this form after the request settles.
      </p>
      <form
        className="om-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saveMutation.isPending && !deleteMutation.isPending) saveMutation.mutate();
        }}
      >
        <label htmlFor="provider-display-name">Instance name</label>
        <input
          id="provider-display-name"
          onChange={(event) => setDisplayName(event.target.value)}
          value={displayName}
        />
        <label htmlFor="provider-endpoint">Endpoint (optional)</label>
        <input
          id="provider-endpoint"
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="https://api.example.com/v1"
          type="url"
          value={endpoint}
        />
        <label htmlFor="provider-model">Default model (optional)</label>
        <input
          id="provider-model"
          onChange={(event) => setDefaultModel(event.target.value)}
          placeholder="e.g. gpt-4o-mini"
          value={defaultModel}
        />
        {provider.requiredSecrets.map((secret) => (
          <span key={secret.name}>
            <label htmlFor={`provider-secret-${secret.name}`}>{secret.name}</label>
            <input
              autoComplete="new-password"
              id={`provider-secret-${secret.name}`}
              onChange={(event) =>
                setSecrets((current) => ({ ...current, [secret.name]: event.target.value }))
              }
              placeholder={secret.configured ? "Leave blank to keep current key" : "Paste secret"}
              type="password"
              value={secrets[secret.name] ?? ""}
            />
          </span>
        ))}
        {saveMutation.error || deleteMutation.error ? (
          <p className="om-form-message" role="alert">
            {errorMessage(
              saveMutation.error ?? deleteMutation.error,
              "Provider setup could not be saved.",
            )}
          </p>
        ) : null}
        <div className="om-modal__actions">
          {existingInstance ? (
            <Button
              disabled={saveMutation.isPending || deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
              type="button"
              variant="danger"
            >
              {deleteMutation.isPending ? "Removing…" : "Remove instance"}
            </Button>
          ) : null}
          <Button onClick={onClose} type="button" variant="quiet">
            Cancel
          </Button>
          <Button disabled={saveMutation.isPending || deleteMutation.isPending} type="submit">
            {saveMutation.isPending ? "Saving…" : "Save on server"}
            <Icon name="arrowUp" size={15} />
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function SettingsPage() {
  const { api } = useOpenMuse();
  const { workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: ["providers", "all", workspace?.id],
    queryFn: () => api.listProviders({ includeUnavailable: true }),
    enabled: Boolean(workspace),
  });
  const memoriesQuery = useQuery({
    queryKey: ["memory", workspace?.id],
    queryFn: () => api.listMemory(workspace!.id, { limit: 100 }),
    enabled: Boolean(workspace),
  });
  const sharesQuery = useQuery({
    queryKey: ["shares", workspace?.id],
    queryFn: () => api.listShares({ limit: 100 }),
    enabled: Boolean(workspace),
  });
  const conversationsQuery = useQuery({
    queryKey: ["conversations", workspace?.id],
    queryFn: () => api.listConversations(workspace!.id, { limit: 100 }),
    enabled: Boolean(workspace),
  });
  const [providerSetup, setProviderSetup] = useState<ProviderInstance | null>(null);
  useEffect(() => {
    setProviderSetup(null);
  }, [workspace?.id]);
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryScope, setMemoryScope] = useState<"user" | "workspace">("user");
  const [shareConversationId, setShareConversationId] = useState("");
  const [shareRecipientEmail, setShareRecipientEmail] = useState("");
  const memoryMutation = useMutation({
    mutationFn: () =>
      api.createMemory({
        workspaceId: workspace!.id,
        scope: memoryScope,
        title: memoryTitle.trim(),
        content: memoryContent,
        sensitivity: "private",
      }),
    onSuccess: async () => {
      setMemoryTitle("");
      setMemoryContent("");
      await queryClient.invalidateQueries({ queryKey: ["memory", workspace?.id] });
    },
  });
  const deleteMemoryMutation = useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memory", workspace?.id] });
    },
  });
  const shareMutation = useMutation({
    mutationFn: () =>
      api.createShare({
        resourceType: "conversation",
        resourceId: shareConversationId,
        subjectType: "user",
        recipientEmail: shareRecipientEmail.trim(),
      }),
    onSuccess: async () => {
      setShareConversationId("");
      setShareRecipientEmail("");
      await queryClient.invalidateQueries({ queryKey: ["shares", workspace?.id] });
    },
  });
  return (
    <div className="om-page">
      <PageHeader
        description="Keep provider setup, memory, and sharing rules visible. Secrets stay with your server."
        eyebrow="The details"
        title="Settings"
      />
      <section className="om-settings-section">
        <div className="om-section-title">
          <div>
            <h2>Provider catalog</h2>
            <p>
              Capabilities are reported by the server; any key you enter is sent once for encrypted
              server-side storage and never returned to this browser.
            </p>
          </div>
          <Button
            disabled={providersQuery.isFetching}
            onClick={() => void providersQuery.refetch()}
            variant="outline"
          >
            <Icon name="refresh" size={15} /> Refresh
          </Button>
        </div>
        {providersQuery.error ? (
          <ErrorNotice
            error={providersQuery.error}
            fallback="Provider catalog could not be loaded."
            onRetry={() => void providersQuery.refetch()}
          />
        ) : providersQuery.data?.length ? (
          <div className="om-provider-grid">
            {providersQuery.data.map((provider) => (
              <ProviderCard
                key={provider.id}
                onConfigure={() => setProviderSetup(provider)}
                provider={provider}
              />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              description="No providers have been registered for this workspace yet."
              icon="wand"
              title="Nothing configured"
            />
          </Card>
        )}
        {providerSetup ? (
          <ProviderSetupPanel provider={providerSetup} onClose={() => setProviderSetup(null)} />
        ) : null}
      </section>
      <section className="om-settings-section">
        <div className="om-section-title">
          <div>
            <h2>Memory</h2>
            <p>Small notes OpenMuse can use in the scope you choose.</p>
          </div>
          <Badge tone="blue">
            <Icon name="lock" size={13} /> Scoped
          </Badge>
        </div>
        <div className="om-memory-layout">
          <Card className="om-memory-form">
            <form
              className="om-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (memoryTitle.trim() && memoryContent.trim()) memoryMutation.mutate();
              }}
            >
              <label htmlFor="memory-title">Memory title</label>
              <input
                id="memory-title"
                onChange={(event) => setMemoryTitle(event.target.value)}
                placeholder="A preference or useful fact"
                value={memoryTitle}
              />
              <label htmlFor="memory-content">Note</label>
              <textarea
                id="memory-content"
                onChange={(event) => setMemoryContent(event.target.value)}
                placeholder="Write only what you are comfortable retaining."
                rows={5}
                value={memoryContent}
              />
              <label htmlFor="memory-scope">Scope</label>
              <select
                id="memory-scope"
                onChange={(event) => setMemoryScope(event.target.value as typeof memoryScope)}
                value={memoryScope}
              >
                <option value="user">Just me</option>
                <option value="workspace">This workspace</option>
              </select>
              {memoryMutation.error ? (
                <p className="om-form-message" role="alert">
                  {errorMessage(memoryMutation.error, "The memory could not be saved.")}
                </p>
              ) : null}
              <Button
                disabled={memoryMutation.isPending || !memoryTitle.trim() || !memoryContent.trim()}
                type="submit"
              >
                {memoryMutation.isPending ? "Saving…" : "Save memory"}
                <Icon name="arrowUp" size={15} />
              </Button>
            </form>
          </Card>
          <div className="om-memory-list">
            {memoriesQuery.error ? (
              <ErrorNotice error={memoriesQuery.error} fallback="Memory could not be loaded." />
            ) : memoriesQuery.data?.items.length ? (
              memoriesQuery.data.items.map((memory) => (
                <Card className="om-memory-row" key={memory.id}>
                  <div>
                    <span className="om-eyebrow">
                      {memory.scope} · {memory.source}
                    </span>
                    <h3>{memory.title}</h3>
                    <p>{memory.content}</p>
                  </div>
                  <IconButton
                    label={`Delete ${memory.title}`}
                    onClick={() => deleteMemoryMutation.mutate(memory.id)}
                  >
                    <Icon name="x" size={15} />
                  </IconButton>
                </Card>
              ))
            ) : (
              <Card>
                <EmptyState
                  description="Nothing is retained until you add it here."
                  icon="spark"
                  title="Memory is empty"
                />
              </Card>
            )}
          </div>
        </div>
      </section>
      <section className="om-settings-section">
        <div className="om-section-title">
          <div>
            <h2>Read-only sharing</h2>
            <p>Grant another OpenMuse user access to a conversation snapshot.</p>
          </div>
          <Icon name="lock" size={18} />
        </div>
        <Card className="om-share-settings">
          <form
            className="om-form om-form--inline"
            onSubmit={(event) => {
              event.preventDefault();
              if (shareConversationId && shareRecipientEmail.trim()) shareMutation.mutate();
            }}
          >
            <div>
              <label htmlFor="share-resource">Conversation</label>
              <select
                id="share-resource"
                onChange={(event) => setShareConversationId(event.target.value)}
                value={shareConversationId}
              >
                <option value="">Choose a conversation</option>
                {conversationsQuery.data?.items.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title || "Untitled conversation"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="share-user">Recipient email</label>
              <input
                autoComplete="email"
                id="share-user"
                onChange={(event) => setShareRecipientEmail(event.target.value)}
                placeholder="member@example.com"
                type="email"
                value={shareRecipientEmail}
              />
            </div>
            <Button
              disabled={
                shareMutation.isPending || !shareConversationId || !shareRecipientEmail.trim()
              }
              type="submit"
            >
              {shareMutation.isPending ? "Sharing…" : "Create read-only share"}
              <Icon name="arrowUp" size={15} />
            </Button>
          </form>
          {shareMutation.error ? (
            <p className="om-form-message" role="alert">
              {errorMessage(shareMutation.error, "The share could not be created.")}
            </p>
          ) : null}
          <div className="om-share-list">
            {sharesQuery.data?.items.length ? (
              sharesQuery.data.items.map((share) => (
                <div className="om-share-row" key={share.id}>
                  <span>
                    <Icon name="lock" size={15} />
                    <strong>
                      {share.resourceType === "conversation"
                        ? "Conversation snapshot"
                        : "Artifact snapshot"}
                    </strong>
                  </span>
                  <Badge tone={share.status === "active" ? "sage" : "neutral"}>
                    {share.status}
                  </Badge>
                  <small>
                    {share.subjectType === "workspace"
                      ? "Workspace members"
                      : "Workspace recipient"}
                  </small>
                </div>
              ))
            ) : (
              <p className="om-aside-copy">No read-only shares exist for this account.</p>
            )}
          </div>
        </Card>
      </section>
    </div>
  );
}
