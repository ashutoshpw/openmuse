import { currentPromise, runCurrent } from "./current";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("runCurrent", () => {
  it("ignores a delayed response after the workspace scope changes", async () => {
    const delayed = deferred<string>();
    const request = currentPromise(Promise.resolve("api-A"));
    const resultPromise = runCurrent(request, async () => delayed.promise);
    await Promise.resolve();
    await Promise.resolve();

    request.invalidate();
    delayed.resolve("workspace-A");

    await expect(resultPromise).resolves.toEqual({ status: "stale" });
  });

  it("ignores a delayed error after the workspace scope changes", async () => {
    const delayed = deferred<string>();
    const request = currentPromise(Promise.resolve("api-A"));
    const resultPromise = runCurrent(request, async () => delayed.promise);
    await Promise.resolve();
    await Promise.resolve();

    request.invalidate();
    delayed.reject(new Error("workspace-A failed"));

    await expect(resultPromise).resolves.toEqual({ status: "stale" });
  });

  it("does not dispatch a picked attachment after the account scope changes", async () => {
    const picked = deferred<void>();
    const upload = jest.fn().mockResolvedValue({ id: "attachment-a" });
    const request = currentPromise(Promise.resolve({ uploadAttachment: upload }));
    const resultPromise = picked.promise.then(() =>
      runCurrent(request, (api) => api.uploadAttachment("conversation-a", new FormData())),
    );

    request.invalidate();
    picked.resolve();

    await expect(resultPromise).resolves.toEqual({ status: "stale" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not apply a delayed workspace creation to a replacement account", async () => {
    const created = deferred<{ id: string }>();
    const request = currentPromise(Promise.resolve({ createWorkspace: () => created.promise }));
    const setWorkspace = jest.fn();
    const resultPromise = runCurrent(request, (api) => api.createWorkspace());

    request.invalidate();
    created.resolve({ id: "workspace-a" });
    const result = await resultPromise;
    if (result.status === "current") setWorkspace(result.value);

    expect(result).toEqual({ status: "stale" });
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it("does not dispatch an AppConnect completion after the account changes", async () => {
    const callback = jest.fn().mockResolvedValue(undefined);
    const request = currentPromise(Promise.resolve({ handleAppConnectCallback: callback }));
    const resultPromise = runCurrent(request, (api) => api.handleAppConnectCallback());

    request.invalidate();

    await expect(resultPromise).resolves.toEqual({ status: "stale" });
    expect(callback).not.toHaveBeenCalled();
  });
});
