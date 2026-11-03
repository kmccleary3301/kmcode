import { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type EnvironmentFixture = {
  environmentId: string;
  connection: { phase: string };
  serverConfig: { scratchWorkspaceRoot: string | null };
};

const testState = vi.hoisted(
  (): {
    environments: EnvironmentFixture[];
    primaryEnvironmentId: string;
  } => ({
    environments: [
      {
        environmentId: "local",
        connection: { phase: "connected" },
        serverConfig: { scratchWorkspaceRoot: "/local/scratch" },
      },
      {
        environmentId: "remote",
        connection: { phase: "connected" },
        serverConfig: { scratchWorkspaceRoot: null },
      },
      {
        environmentId: "other",
        connection: { phase: "connected" },
        serverConfig: { scratchWorkspaceRoot: "/other/scratch" },
      },
    ],
    primaryEnvironmentId: "local",
  }),
);

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
  usePrimaryEnvironmentId: () => testState.primaryEnvironmentId || null,
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { openScratch: "open-scratch" } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => null }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => undefined }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: () => null,
  toastManager: { add: () => undefined },
}));

import { useScratchProject } from "./useScratchProject";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const other = EnvironmentId.make("other");

function configureEnvironments(
  primaryEnvironmentId: EnvironmentId | null,
  localRoot: string | null,
  remoteRoot: string | null,
  otherRoot: string | null,
) {
  testState.primaryEnvironmentId = primaryEnvironmentId ?? "";
  testState.environments = [
    {
      environmentId: local,
      connection: { phase: "connected" },
      serverConfig: { scratchWorkspaceRoot: localRoot },
    },
    {
      environmentId: remote,
      connection: { phase: "connected" },
      serverConfig: { scratchWorkspaceRoot: remoteRoot },
    },
    {
      environmentId: other,
      connection: { phase: "connected" },
      serverConfig: { scratchWorkspaceRoot: otherRoot },
    },
  ] satisfies EnvironmentFixture[];
}

let renderer: ReactTestRenderer | null = null;
let selectedEnvironmentId: EnvironmentId | null = null;

function Probe({ fallback }: { readonly fallback: EnvironmentId | null }) {
  const { scratchEnvironmentId } = useScratchProject();
  const selected = scratchEnvironmentId(fallback);
  useLayoutEffect(() => {
    selectedEnvironmentId = selected;
  }, [fallback, selected]);
  return null;
}

function renderSelection(fallback: EnvironmentId | null): EnvironmentId | null {
  const probe = <Probe fallback={fallback} />;
  act(() => {
    if (renderer === null) {
      renderer = create(probe);
    } else {
      renderer.update(probe);
    }
  });
  return selectedEnvironmentId;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  configureEnvironments(local, "/local/scratch", "/remote/scratch", "/other/scratch");
  selectedEnvironmentId = null;
});

afterEach(() => {
  if (renderer !== null) {
    const current = renderer;
    act(() => current.unmount());
    renderer = null;
  }
  vi.unstubAllGlobals();
});

describe("scratchEnvironmentId", () => {
  it("prefers the primary environment over the current environment", () => {
    expect(renderSelection(remote)).toBe(local);
    expect(renderSelection(null)).toBe(local);
  });

  it("uses a scratch-capable current environment when the primary cannot offer one", () => {
    configureEnvironments(local, null, "/remote/scratch", "/other/scratch");
    expect(renderSelection(remote)).toBe(remote);

    configureEnvironments(null, null, "/remote/scratch", "/other/scratch");
    expect(renderSelection(remote)).toBe(remote);
  });

  it("uses the only environment with scratch when there is no primary or current environment", () => {
    configureEnvironments(null, null, null, "/other/scratch");
    expect(renderSelection(null)).toBe(other);
  });

  it("does not choose between multiple scratch environments without a match", () => {
    configureEnvironments(null, null, "/remote/scratch", "/other/scratch");
    expect(renderSelection(null)).toBeNull();
  });

  it("returns null when no environment offers scratch", () => {
    configureEnvironments(local, null, null, null);
    expect(renderSelection(null)).toBeNull();
  });
});
