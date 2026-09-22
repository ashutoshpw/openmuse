import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export type IconName =
  | "alert"
  | "arrowUp"
  | "artifact"
  | "calendar"
  | "check"
  | "checkCircle"
  | "chevronDown"
  | "chevronRight"
  | "clock"
  | "close"
  | "copy"
  | "external"
  | "file"
  | "goal"
  | "grid"
  | "link"
  | "lock"
  | "menu"
  | "message"
  | "mic"
  | "moon"
  | "more"
  | "paperclip"
  | "plus"
  | "refresh"
  | "search"
  | "send"
  | "settings"
  | "spark"
  | "spinner"
  | "target"
  | "user"
  | "wand"
  | "x";

const paths: Record<IconName, ReactNode> = {
  alert: (
    <>
      <path d="M12 3 2.8 19h18.4L12 3Z" />
      <path d="M12 9v4M12 16h.01" />
    </>
  ),
  arrowUp: (
    <>
      <path d="m5 12 7-7 7 7M12 19V5" />
    </>
  ),
  artifact: (
    <>
      <path d="M6 3.5h9l3 3V20H6z" />
      <path d="M15 3.5V7h3M9 11h6M9 15h6" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M7 3v4M17 3v4M3.5 9h17" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16 9" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12M18 6 6 18" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h4M9 13h6M9 17h4" />
    </>
  ),
  goal: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.5 8.5 15a3 3 0 1 1-4-4l3-3a3 3 0 0 1 4 0" />
      <path d="m14 10.5 1.5-1.5a3 3 0 1 1 4 4l-3 3a3 3 0 0 1-4 0" />
      <path d="m8 16 8-8" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
  message: (
    <>
      <path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.4 8.4 0 0 1-3-.6L4 20l1.5-4A7.5 7.5 0 1 1 20 11.5Z" />
      <path d="M8 12h.01M12 12h.01M16 12h.01" />
    </>
  ),
  mic: (
    <>
      <rect x="8" y="3" width="8" height="12" rx="4" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </>
  ),
  moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  paperclip: <path d="m9 17 7.5-7.5a3.2 3.2 0 0 0-4.5-4.5l-7 7a4.2 4.2 0 0 0 6 6l7-7" />,
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14.7-3L3 11" />
      <path d="M3 5v6h6M4 13a8 8 0 0 0 14.7 3L21 13" />
      <path d="M21 19v-6h-6" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.8" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  send: (
    <>
      <path d="m21 3-8 18-3.5-7L3 10.5 21 3Z" />
      <path d="m9.5 14 4-4" />
    </>
  ),
  settings: (
    <>
      <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
      <path d="m19 13 .1-2-1.8-.7a7.6 7.6 0 0 0-.8-1.8l.8-1.7-1.5-1.4-1.7.9a7.4 7.4 0 0 0-2-.8L11.5 4h-2l-.6 1.8a7.4 7.4 0 0 0-2 .8l-1.7-.9-1.5 1.4.8 1.7a7.6 7.6 0 0 0-.8 1.8l-1.8.7.1 2 1.8.6c.2.7.5 1.3.8 1.9l-.8 1.7 1.5 1.4 1.7-.9c.6.4 1.3.7 2 .8l.6 1.8h2l.6-1.8a7.4 7.4 0 0 0 2-.8l1.7.9 1.5-1.4-.8-1.7c.4-.6.7-1.2.8-1.9L19 13Z" />
    </>
  ),
  spark: (
    <>
      <path d="m12 2 1.4 6.6L20 10l-6.6 1.4L12 18l-1.4-6.6L4 10l6.6-1.4L12 2Z" />
      <path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z" />
    </>
  ),
  spinner: <path d="M12 3a9 9 0 1 0 9 9" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3M12 3v2M21 12h-2M12 21v-2M3 12h2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  wand: (
    <>
      <path d="m15 4 5 5M13 6l5 5M4 20l9-9" />
      <path d="m4 4 .7 2.3L7 7l-2.3.7L4 10l-.7-2.3L1 7l2.3-.7L4 4ZM18 16l.6 1.8 1.9.7-1.9.6L18 21l-.6-1.9-1.9-.6 1.9-.7L18 16Z" />
    </>
  ),
  x: (
    <>
      <path d="m6 6 12 12M18 6 6 18" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.8,
  label,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  label?: string;
}) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className="om-icon"
      fill="none"
      focusable="false"
      height={size}
      role={label ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
    >
      {paths[name]}
    </svg>
  );
}

export type ButtonVariant = "coral" | "ink" | "outline" | "quiet" | "danger";

export function Button({
  className = "",
  variant = "coral",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button className={`om-button om-button--${variant} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button aria-label={label} className={`om-icon-button ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "coral" | "sage" | "blue" | "danger";
}) {
  return <span className={`om-badge om-badge--${tone}`}>{children}</span>;
}

export function Card({ className = "", children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={`om-card ${className}`.trim()} {...props}>
      {children}
    </section>
  );
}

export function EmptyState({
  icon = "spark",
  eyebrow,
  title,
  description,
  action,
}: {
  icon?: IconName;
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="om-empty-state">
      <div className="om-empty-state__mark">
        <Icon name={icon} size={22} />
      </div>
      {eyebrow ? <span className="om-eyebrow">{eyebrow}</span> : null}
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="om-empty-state__action">{action}</div> : null}
    </div>
  );
}

export type SidebarItem = { label: string; href: string; icon: IconName; count?: number };

export function Sidebar({
  items,
  activeHref,
  workspaceName,
  workspaceRole,
  userLabel,
  onNavigate,
  onNewConversation,
  onWorkspaceClick,
  onUserClick,
  mobileOpen = false,
  onClose,
}: {
  items: SidebarItem[];
  activeHref: string;
  workspaceName: string;
  workspaceRole?: string;
  userLabel: string;
  onNavigate: (href: string) => void;
  onNewConversation: () => void;
  onWorkspaceClick?: () => void;
  onUserClick?: () => void;
  mobileOpen?: boolean;
  onClose?: () => void;
}) {
  return (
    <aside className={`om-sidebar ${mobileOpen ? "is-open" : ""}`}>
      <div className="om-sidebar__topline">
        <a
          className="om-wordmark"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            onNavigate("/");
          }}
        >
          <span className="om-wordmark__glyph">
            <Icon name="spark" size={17} strokeWidth={2.1} />
          </span>
          <span>openmuse</span>
        </a>
        {onClose ? (
          <IconButton className="om-sidebar__close" label="Close navigation" onClick={onClose}>
            <Icon name="close" />
          </IconButton>
        ) : null}
      </div>

      <button className="om-workspace-switcher" type="button" onClick={onWorkspaceClick}>
        <span className="om-workspace-switcher__avatar">
          {workspaceName.slice(0, 1).toUpperCase()}
        </span>
        <span className="om-workspace-switcher__copy">
          <strong>{workspaceName}</strong>
          <small>{workspaceRole ?? "Workspace"}</small>
        </span>
        <Icon name="chevronDown" size={15} />
      </button>

      <Button className="om-sidebar__new" onClick={onNewConversation}>
        <Icon name="plus" size={17} />
        New conversation
      </Button>

      <nav aria-label="Primary navigation" className="om-sidebar__nav">
        <span className="om-sidebar__label">Workspace</span>
        {items.map((item) => {
          const active =
            activeHref === item.href || (item.href !== "/" && activeHref.startsWith(item.href));
          return (
            <a
              aria-current={active ? "page" : undefined}
              className={`om-sidebar__link ${active ? "is-active" : ""}`}
              href={item.href}
              key={item.href}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(item.href);
                onClose?.();
              }}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.count ? <span className="om-sidebar__count">{item.count}</span> : null}
            </a>
          );
        })}
      </nav>

      <div className="om-sidebar__bottom">
        <div className="om-sidebar__hint">
          <Icon name="spark" size={15} />
          <span>
            Give your ideas
            <br />
            <strong>somewhere to go.</strong>
          </span>
        </div>
        <div className="om-sidebar__user">
          <span className="om-sidebar__user-avatar">{userLabel.slice(0, 1).toUpperCase()}</span>
          <span>{userLabel}</span>
          <IconButton label="Open profile menu" onClick={onUserClick}>
            <Icon name="more" size={17} />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="om-page-header">
      <div>
        {eyebrow ? <span className="om-eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="om-page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function LoadingLine({ width = "100%" }: { width?: string }) {
  return <span aria-hidden="true" className="om-loading-line" style={{ width }} />;
}
