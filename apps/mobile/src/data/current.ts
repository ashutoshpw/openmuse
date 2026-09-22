export type CurrentPromise<T> = Promise<T> & {
  activate: () => void;
  invalidate: () => void;
  isCurrent: () => boolean;
};

export type CurrentResult<T> = { status: "current"; value: T } | { status: "stale" };

export function currentPromise<T>(promise: Promise<T>): CurrentPromise<T> {
  let active = true;
  return Object.assign(promise, {
    activate: () => {
      active = true;
    },
    invalidate: () => {
      active = false;
    },
    isCurrent: () => active,
  });
}

export async function runCurrent<TApi, TResult>(
  promise: CurrentPromise<TApi>,
  task: (api: TApi) => Promise<TResult>,
): Promise<CurrentResult<TResult>> {
  if (!promise.isCurrent()) return { status: "stale" };
  try {
    const api = await promise;
    if (!promise.isCurrent()) return { status: "stale" };
    const value = await task(api);
    return promise.isCurrent() ? { status: "current", value } : { status: "stale" };
  } catch (cause: unknown) {
    if (!promise.isCurrent()) return { status: "stale" };
    throw cause;
  }
}
