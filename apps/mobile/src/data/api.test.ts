import { createApiClient } from "@openmuse/client";
import { OpenMuseApi } from "./api";

jest.mock("@openmuse/client", () => ({
  createApiClient: jest.fn(),
}));

const createClientMock = jest.mocked(createApiClient);

function contractMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    runId: null,
    sequence: 1,
    author: { type: "assistant" },
    parts: [{ type: "text", text: "Hello from the server." }],
    status: "complete",
    ...overrides,
  };
}

describe("OpenMuseApi", () => {
  afterEach(() => {
    createClientMock.mockReset();
  });

  it("constructs the canonical client with a bearer-token provider", async () => {
    const client = { getCurrentSession: jest.fn() };
    createClientMock.mockReturnValue(client as never);
    await OpenMuseApi.create({ baseUrl: "https://muse.example", token: "session-token" });

    const options = createClientMock.mock.calls[0]?.[0];
    expect(options?.baseUrl).toBe("https://muse.example");
    expect(options?.getAccessToken?.()).toBe("session-token");
  });

  it("maps canonical message pages into transcript parts", async () => {
    const client = {
      listMessages: jest.fn().mockResolvedValue({
        items: [contractMessage()],
        page: { nextCursor: null, hasMore: false },
      }),
    };
    createClientMock.mockReturnValue(client as never);
    const api = await OpenMuseApi.create({ baseUrl: "https://muse.example", token: "token" });

    await expect(api.listChatParts("conversation-1")).resolves.toEqual({
      items: [
        {
          id: "message-1",
          conversationId: "conversation-1",
          role: "assistant",
          text: "Hello from the server.",
          createdAt: "2026-09-22T00:00:00.000Z",
          streaming: false,
          kind: "text",
        },
      ],
      nextCursor: undefined,
    });
  });

  it("replays run events for a canonical send result", async () => {
    const client = {
      sendMessage: jest.fn().mockResolvedValue({
        message: contractMessage({ status: "streaming" }),
        run: { id: "run-1" },
      }),
      pollRunEvents: jest.fn(async function* () {
        yield {
          id: "event-1",
          runId: "run-1",
          workspaceId: "workspace-1",
          sequence: 1,
          type: "message.delta",
          occurredAt: "2026-09-22T00:00:01.000Z",
          payload: { messageId: "message-1", text: " more" },
        };
        yield {
          id: "event-2",
          runId: "run-1",
          workspaceId: "workspace-1",
          sequence: 2,
          type: "run.completed",
          occurredAt: "2026-09-22T00:00:02.000Z",
          payload: {},
        };
      }),
    };
    createClientMock.mockReturnValue(client as never);
    const api = await OpenMuseApi.create({ baseUrl: "https://muse.example", token: "token" });
    const stream = await api.streamMessage("conversation-1", "Hi", []);
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({ type: "part" }),
      { type: "delta", conversationId: "conversation-1", partId: "message-1", text: " more" },
      { type: "done" },
    ]);
  });

  it("does not duplicate the canonical user message during a run", async () => {
    const client = {
      sendMessage: jest.fn().mockResolvedValue({
        message: contractMessage({ author: { type: "user", userId: "user-1" } }),
      }),
      pollRunEvents: jest.fn(),
    };
    createClientMock.mockReturnValue(client as never);
    const api = await OpenMuseApi.create({ baseUrl: "https://muse.example", token: "token" });
    const stream = await api.streamMessage("conversation-1", "Hi", []);
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([{ type: "done" }]);
    expect(client.pollRunEvents).not.toHaveBeenCalled();
  });

  it("cancels a server run when the mobile stream is aborted", async () => {
    const controller = new AbortController();
    const cancelRun = jest.fn().mockResolvedValue(undefined);
    const client = {
      sendMessage: jest.fn().mockResolvedValue({
        message: contractMessage({ status: "streaming" }),
        run: { id: "run-1" },
      }),
      cancelRun,
      pollRunEvents: jest.fn(async function* () {
        controller.abort();
        yield {
          id: "event-1",
          runId: "run-1",
          workspaceId: "workspace-1",
          sequence: 1,
          type: "run.progress",
          occurredAt: "2026-09-22T00:00:01.000Z",
          payload: {},
        };
      }),
    };
    createClientMock.mockReturnValue(client as never);
    const api = await OpenMuseApi.create({ baseUrl: "https://muse.example", token: "token" });
    const stream = await api.streamMessage("conversation-1", "Hi", [], controller.signal);

    await expect(
      (async () => {
        for await (const event of stream) {
          // Consume until the abort is observed.
          if (event.type === "done") break;
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelRun).toHaveBeenCalledWith("run-1", {
      reason: "Stopped by the mobile client.",
    });
  });
});
