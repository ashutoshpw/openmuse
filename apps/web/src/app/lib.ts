import type { Message, MessagePart, Run } from "@openmuse/contracts";
import type { SidebarItem } from "@openmuse/ui-web";

export const navigationItems: SidebarItem[] = [
  { label: "Conversations", href: "/conversations", icon: "message" },
  { label: "Goals", href: "/goals", icon: "goal" },
  { label: "Approvals", href: "/approvals", icon: "checkCircle" },
  { label: "Connections", href: "/connections", icon: "link" },
  { label: "Artifacts", href: "/artifacts", icon: "artifact" },
  { label: "Settings", href: "/settings", icon: "settings" },
];

export function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function initials(label: string) {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "O";
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function formatRelativeTime(value: string | undefined, now = Date.now()) {
  if (!value) return "No recent activity";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Recently";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(timestamp);
}

export function formatDate(
  value: string | undefined,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" },
) {
  if (!value) return "Not scheduled";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Not scheduled";
  return new Intl.DateTimeFormat("en", options).format(timestamp);
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function messageText(message: Message) {
  return message.parts
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text;
      if (part.type === "citation") return part.title ?? part.url;
      if (
        part.type === "file" ||
        part.type === "image" ||
        part.type === "audio" ||
        part.type === "artifactRef"
      )
        return "Attached artifact";
      if (part.type === "toolCall") return `Used ${part.name}`;
      if (part.type === "toolResult")
        return part.ok ? "Tool completed" : (part.error ?? "Tool failed");
      return "Approval required";
    })
    .join("\n");
}

export function partLabel(part: MessagePart) {
  if (
    part.type === "file" ||
    part.type === "image" ||
    part.type === "audio" ||
    part.type === "artifactRef"
  )
    return "Artifact";
  if (part.type === "toolCall") return part.name;
  if (part.type === "toolResult") return part.ok ? "Completed" : "Needs attention";
  if (part.type === "approvalRef") return "Approval required";
  return undefined;
}

export function runStatusLabel(status: Run["status"]) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function scheduleLabel(
  schedule:
    | { kind: "once"; at: string }
    | { kind: "interval"; everySeconds: number; timezone: string }
    | { kind: "cron"; expression: string; timezone: string }
    | null
    | undefined,
) {
  if (!schedule) return "On demand";
  if (schedule.kind === "once") return `Once · ${formatDate(schedule.at)}`;
  if (schedule.kind === "interval")
    return `Every ${Math.round(schedule.everySeconds / 60)} min · ${schedule.timezone}`;
  return `${schedule.expression} · ${schedule.timezone}`;
}

export function providerTone(status: string) {
  if (status === "available" || status === "active" || status === "connected")
    return "sage" as const;
  if (status === "reauthorization_required" || status === "waiting_approval")
    return "coral" as const;
  if (status === "failed" || status === "revoked" || status === "unavailable")
    return "danger" as const;
  return "neutral" as const;
}

export function makeClientMessageId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
