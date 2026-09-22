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

const conversation = {
  id: "conversation_1",
  createdAt: now,
  updatedAt: now,
  workspaceId: workspace.id,
  ownerUserId: session.userId,
  title: "A useful thread",
  visibility: "private",
  status: "active",
  archivedAt: null,
  metadata: {},
};

const userMessage = {
  id: "message_1",
  createdAt: now,
  updatedAt: now,
  workspaceId: workspace.id,
  conversationId: conversation.id,
  runId: null,
  sequence: 1,
  author: { type: "user", userId: session.userId },
  parts: [{ type: "text", text: "Sent from the deterministic fixture." }],
  status: "complete",
};

const approval = {
  id: "approval_1",
  createdAt: now,
  updatedAt: now,
  workspaceId: workspace.id,
  userId: session.userId,
  runId: "run_1",
  toolCallId: "tool_call_1",
  digest: "digest_1234",
  nonce: "nonce_1234",
  status: "pending",
  policyVersion: "policy-1",
  connectionId: null,
  target: { action: "Send a calendar invite", description: "A consequential fixture action." },
  expiresAt: "2026-09-22T09:00:00.000Z",
  decidedAt: null,
  consumedAt: null,
};

type MockOptions = {
  authRequired?: boolean;
  emptyWorkspace?: boolean;
  withApproval?: boolean;
};

async function mockApi(page: Page, options: MockOptions = {}) {
  let signedIn = !options.authRequired;
  let sent = false;
  let approvalPending = options.withApproval ?? false;

  await page.route("**/api/auth/**", async (route) => {
    const request = route.request();
    if (request.url().endsWith("/api/auth/sign-in/email") && request.method() === "POST") {
      signedIn = true;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ user: { id: session.userId, email: "member@example.com" } }),
      });
    }
    if (request.url().endsWith("/api/auth/sign-out"))
      return route.fulfill({ status: 204, body: "" });
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "Not mocked" } }),
    });
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith("/sessions/current")) {
      if (!signedIn)
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "unauthenticated", message: "Sign in required." } }),
        });
      return route.fulfill({ contentType: "application/json", body: envelope(session) });
    }
    if (path.endsWith("/workspaces") && request.method() === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: pageEnvelope(options.emptyWorkspace ? [] : [workspace]),
      });
    if (path.endsWith("/workspaces") && request.method() === "POST")
      return route.fulfill({ contentType: "application/json", body: envelope(workspace) });
    if (path.endsWith(`/workspaces/${workspace.id}/conversations`) && request.method() === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: pageEnvelope(options.emptyWorkspace || !sent ? [] : [conversation]),
      });
    if (path === "/api/v1/conversations" && request.method() === "POST")
      return route.fulfill({ contentType: "application/json", body: envelope(conversation) });
    if (path === `/api/v1/conversations/${conversation.id}` && request.method() === "GET")
      return route.fulfill({ contentType: "application/json", body: envelope(conversation) });
    if (path.endsWith(`/conversations/${conversation.id}/messages`) && request.method() === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: pageEnvelope(sent ? [userMessage] : []),
      });
    if (path.endsWith(`/conversations/${conversation.id}/messages`) && request.method() === "POST") {
      sent = true;
      return route.fulfill({ contentType: "application/json", body: envelope({ message: userMessage }) });
    }
    if (path.endsWith("/approvals") && request.method() === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: pageEnvelope(approvalPending ? [approval] : []),
      });
    if (path.includes(`/approvals/${approval.id}/decision`) && request.method() === "POST") {
      approvalPending = false;
      return route.fulfill({
        contentType: "application/json",
        body: envelope({ ...approval, status: "approved", decidedAt: now }),
      });
    }
    if (path.includes("/goals"))
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
  await mockApi(page, { emptyWorkspace: true });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /make space for/i })).toBeVisible();
  await expect(page.getByLabel("Workspace name")).toBeVisible();
  await expect(page.getByText("Editorial Studio")).not.toBeVisible();
});

test("shows the sign-in screen after one bounded session failure and recovers", async ({ page }) => {
  let sessionRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/sessions/current")) sessionRequests += 1;
  });
  await mockApi(page, { authRequired: true });
  await page.goto("/");
  await expect(page.getByLabel("Email address")).toBeVisible();
  await page.getByLabel("Email address").fill("member@example.com");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: /open my workspace/i }).click();
  await expect(page.getByRole("heading", { name: /make something/i })).toBeVisible();
  expect(sessionRequests).toBeLessThan(3);
});

test("creates a conversation and sends a message through the client contract", async ({ page }) => {
  await mockApi(page);
  await page.goto("/conversations");
  await page.getByRole("main").getByRole("button", { name: /new conversation/i }).click();
  await expect(page.getByRole("heading", { name: "A useful thread" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message OpenMuse" }).fill("A test message");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText("Sent from the deterministic fixture.")).toBeVisible();
});

test("approves a pending action with its server digest", async ({ page }) => {
  await mockApi(page, { withApproval: true });
  await page.goto("/approvals");
  await expect(page.getByRole("heading", { name: "Send a calendar invite" })).toBeVisible();
  await page.getByRole("button", { name: /approve action/i }).click();
  await expect(page.getByText("Nothing needs your approval")).toBeVisible();
});

test("captures the desktop workspace fixture", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /make something/i })).toBeVisible();
  await page.screenshot({ path: "/tmp/openmuse-web-desktop.png", fullPage: true });
});

test("captures the mobile workspace fixture", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /make something/i })).toBeVisible();
  await page.screenshot({ path: "/tmp/openmuse-web-mobile.png", fullPage: true });
});
