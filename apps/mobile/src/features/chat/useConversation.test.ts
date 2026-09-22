import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { OpenMuseApi } from "../../data/api";
import { currentPromise, type CurrentPromise } from "../../data/current";
import { useAuthenticatedApi } from "../../data/useAuthenticatedApi";
import { useConversation } from "./useConversation";

jest.mock("../../data/useAuthenticatedApi", () => ({
  useAuthenticatedApi: jest.fn(),
}));

jest.mock("react-native", () => ({
  Platform: {
    OS: "ios",
    select: (values: Record<string, unknown>) => values.ios ?? values.default,
  },
  StyleSheet: { flatten: (style: unknown) => style },
}));

const useAuthenticatedApiMock = jest.mocked(useAuthenticatedApi);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function conversation(id: string, workspaceId: string) {
  return {
    id,
    workspaceId,
    title: id,
    status: "idle",
  };
}

function apiFor(
  workspaceId: string,
  stream: AsyncIterable<unknown>,
  onSignal: (signal: AbortSignal | undefined) => void,
) {
  return {
    getConversation: jest
      .fn()
      .mockResolvedValue(conversation(`conversation-${workspaceId}`, workspaceId)),
    listChatParts: jest
      .fn()
      .mockResolvedValue({ items: [], page: { nextCursor: null, hasMore: false } }),
    streamMessage: jest
      .fn()
      .mockImplementation(
        (
          _conversationId: string,
          _text: string,
          _attachmentIds: string[],
          signal?: AbortSignal,
        ) => {
          onSignal(signal);
          return Promise.resolve(stream);
        },
      ),
  } as unknown as OpenMuseApi;
}

describe("useConversation", () => {
  afterEach(() => {
    useAuthenticatedApiMock.mockReset();
  });

  it("aborts a stale stream and ignores late events after the workspace changes", async () => {
    const event = deferred<unknown>();
    let signal: AbortSignal | undefined;
    const apiA = apiFor("workspace-a", streamAfter(event.promise), (next) => {
      signal = next;
    });
    const apiB = apiFor("workspace-b", emptyStream(), () => undefined);
    const requestA = currentPromise(Promise.resolve(apiA));
    const requestB = currentPromise(Promise.resolve(apiB));
    useAuthenticatedApiMock.mockReturnValue(requestA as CurrentPromise<OpenMuseApi>);

    const hook = await renderHook(() => useConversation("conversation-a"));
    const { result, rerender } = hook;
    await waitFor(() => expect(apiA.getConversation).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBeDefined());

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.send("hello");
      await waitFor(() => expect(apiA.streamMessage).toHaveBeenCalled());
    });
    expect(result.current.parts.some((part) => part.text === "hello")).toBe(true);

    requestA.invalidate();
    useAuthenticatedApiMock.mockReturnValue(requestB as CurrentPromise<OpenMuseApi>);
    await rerender(undefined);
    expect(signal?.aborted).toBe(true);

    event.resolve({ type: "delta", partId: "late", text: "workspace-a" });
    await act(async () => {
      await sendPromise;
    });

    expect(result.current.parts.some((part) => part.text.includes("workspace-a"))).toBe(false);
  });
});

async function* streamAfter<T>(promise: Promise<T>) {
  yield await promise;
}

async function* emptyStream() {
  // Deliberately empty: the replacement scope must remain idle.
}
