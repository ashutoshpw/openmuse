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
});
