import React, { type ReactNode } from "react";
import { useSession, useWorkspace } from "../state";

/**
 * Remount workspace-owned screen state whenever the account or workspace
 * changes. This removes the previous scope's rendered data before the next
 * scope's request has a chance to resolve.
 */
export function WorkspaceScope({
  children,
  suffix = "",
}: {
  children: ReactNode;
  suffix?: string;
}) {
  const { session } = useSession();
  const { workspace } = useWorkspace();
  const key = `${session?.user.id ?? "signed-out"}:${workspace?.id ?? "no-workspace"}:${suffix}`;
  return <React.Fragment key={key}>{children}</React.Fragment>;
}
