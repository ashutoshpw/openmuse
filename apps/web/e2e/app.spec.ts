import { expect, test, type Page } from "@playwright/test";

const now = "2026-09-22T08:00:00.000Z";

function envelope(data: unknown) {
  return JSON.stringify({ data });
}

function pageEnvelope(items: unknown[]) {
  return envelope({ items, page: { nextCursor: null, hasMore: false } });
}

const session = {
  id: "session_1",
  createdAt: now,
  updatedAt: now,
  userId: "user_1",
  expiresAt: "2026-12-22T08:00:00.000Z",
  lastSeenAt: now,
  revokedAt: null,
  scopes: [],
};

const workspace = {
  id: "workspace_1",
  createdAt: now,
  updatedAt: now,
  name: "Editorial Studio",
  slug: "editorial-studio",
  role: "owner",
  archivedAt: null,
};

async function mockApi(pageObject: Page, emptyWorkspace = false) {
  await pageObject.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/sessions/current"))
      return route.fulfill({ contentType: "application/json", body: envelope(session) });
    if (path.endsWith("/workspaces") && route.request().method() === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: pageEnvelope(emptyWorkspace ? [] : [workspace]),
      });
    if (path.includes("/conversations"))
      return route.fulfill({ contentType: "application/json", body: pageEnvelope([]) });
    if (path.includes("/goals"))
      return route.fulfill({ contentType: "application/json", body: pageEnvelope([]) });
    if (path.includes("/approvals"))
      return route.fulfill({ contentType: "application/json", body: pageEnvelope([]) });
    if (path.includes("/artifacts"))
      return route.fulfill({ contentType: "application/json", body: pageEnvelope([]) });
    if (path.includes("/connections"))
      return route.fulfill({ contentType: "application/json", body: pageEnvelope([]) });
    if (path.includes("/providers"))
      return route.fulfill({ contentType: "application/json", body: envelope({ items: [] }) });
    if (path.includes("/memory"))
      return route.fulfill({ contentType: "application/json", body: pageEnvelope([]) });
    if (path.includes("/shares"))
      return route.fulfill({ contentType: "application/json", body: pageEnvelope([]) });
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "not_found", message: "Not mocked" } }),
    });
  });
}

test("renders a calm workspace overview from deterministic API responses", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /make something/i })).toBeVisible();
  await expect(page.getByText("Editorial Studio").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /conversations/i })).toBeVisible();
  await expect(page.getByText("Your conversation list is quiet")).toBeVisible();
});

test("shows workspace onboarding without inventing a workspace", async ({ page }) => {
  await mockApi(page, true);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /make space for/i })).toBeVisible();
  await expect(page.getByLabel("Workspace name")).toBeVisible();
  await expect(page.getByText("Editorial Studio")).not.toBeVisible();
});
