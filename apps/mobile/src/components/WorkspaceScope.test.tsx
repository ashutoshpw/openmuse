import React, { useEffect, useState } from "react";
import { act, render } from "@testing-library/react-native";
import { useSession, useWorkspace } from "../state";
import { WorkspaceScope } from "./WorkspaceScope";

jest.mock("../state", () => ({
  useSession: jest.fn(),
  useWorkspace: jest.fn(),
}));

jest.mock("react-native", () => ({
  Platform: {
    OS: "ios",
    select: (values: Record<string, unknown>) => values.ios ?? values.default,
  },
  StyleSheet: { flatten: (style: unknown) => style },
}));

const useSessionMock = jest.mocked(useSession);
const useWorkspaceMock = jest.mocked(useWorkspace);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function ScopedProbe({ initial, mutation }: { initial: string; mutation: Promise<string> }) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    void mutation.then(setValue);
  }, [mutation]);
  return React.createElement("Text", null, value);
}

describe("WorkspaceScope", () => {
  let workspaceId = "workspace-a";

  beforeEach(() => {
    useSessionMock.mockReturnValue({
      session: { token: "token", user: { id: "user-1" } },
    } as ReturnType<typeof useSession>);
    useWorkspaceMock.mockImplementation(
      () => ({ workspace: { id: workspaceId } }) as ReturnType<typeof useWorkspace>,
    );
  });

  afterEach(() => {
    useSessionMock.mockReset();
    useWorkspaceMock.mockReset();
  });

  it("removes old rendered data before a new scope fetch resolves", async () => {
    const mutationA = deferred<string>();
    const mutationB = deferred<string>();
    const view = await render(
      <WorkspaceScope>
        <ScopedProbe initial="workspace-a" mutation={mutationA.promise} />
      </WorkspaceScope>,
    );
    expect(view.getByText("workspace-a")).toBeTruthy();

    workspaceId = "workspace-b";
    await view.rerender(
      <WorkspaceScope>
        <ScopedProbe initial="workspace-b" mutation={mutationB.promise} />
      </WorkspaceScope>,
    );
    expect(view.queryByText("workspace-a")).toBeNull();
    expect(view.getByText("workspace-b")).toBeTruthy();

    mutationA.resolve("late-workspace-a");
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.queryByText("late-workspace-a")).toBeNull();
    expect(view.getByText("workspace-b")).toBeTruthy();
  });
});
