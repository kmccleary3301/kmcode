// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    readonly environmentId: string;
    readonly entry: { readonly enabled: boolean };
  }>,
  mounted: [] as Array<string>,
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));

// This module-mock factory is hoisted, so load Atom inside it to build probe atoms.
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const subscriptionAtoms = Atom.family((key: string) =>
    Atom.make(() => {
      state.mounted.push(key);
      return null;
    }),
  );
  const observationAtoms = Atom.family((key: string) =>
    Atom.make(() => {
      state.mounted.push(key);
      return null;
    }),
  );
  return {
    serverEnvironment: {
      hostHealth: ({ environmentId }: { readonly environmentId: string }) =>
        subscriptionAtoms(`${environmentId}:stream`),
      hostHealthLatest: (environmentId: string) =>
        observationAtoms(`${environmentId}:latest`),
    },
  };
});

import { HostHealthSubscriptionKeeper } from "./HostHealthSubscriptionKeeper";

afterEach(() => {
  vi.unstubAllGlobals();
  state.environments = [];
  state.mounted = [];
});

it("mounts enabled environment health streams without rendering a tooltip", async () => {
  const connected = EnvironmentId.make("connected-environment");
  const disabled = EnvironmentId.make("disabled-environment");
  state.environments = [
    { environmentId: connected, entry: { enabled: true } },
    { environmentId: disabled, entry: { enabled: false } },
  ];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <AppAtomRegistryProvider>
          <HostHealthSubscriptionKeeper />
        </AppAtomRegistryProvider>,
      );
    });

    expect(new Set(state.mounted)).toEqual(
      new Set([`${connected}:stream`, `${connected}:latest`]),
    );
    expect(renderer?.toJSON()).toBeNull();
  } finally {
    await act(async () => renderer?.unmount());
  }
});
