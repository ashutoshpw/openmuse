import { describe, expect, it } from "vitest";
import { formatBytes, formatRelativeTime, initials, navigationItems, scheduleLabel } from "./lib";

describe("web workspace helpers", () => {
  it("keeps primary navigation explicit and ordered", () => {
    expect(navigationItems.map((item) => item.label)).toEqual([
      "Conversations",
      "Goals",
      "Approvals",
      "Connections",
      "Artifacts",
      "Settings",
    ]);
  });

  it("formats data without inventing missing activity", () => {
    expect(formatRelativeTime(undefined)).toBe("No recent activity");
    expect(
      formatRelativeTime("2026-09-22T08:00:00.000Z", Date.parse("2026-09-22T08:03:00.000Z")),
    ).toBe("3m ago");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });

  it("uses readable labels for workspace data", () => {
    expect(initials("Editorial Studio")).toBe("ES");
    expect(scheduleLabel({ kind: "interval", everySeconds: 3600, timezone: "UTC" })).toBe(
      "Every 60 min · UTC",
    );
    expect(scheduleLabel(null)).toBe("On demand");
  });
});
