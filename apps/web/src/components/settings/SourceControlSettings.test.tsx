import * as Option from "effect/Option";
import type { SourceControlDiscoveryResult } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  discovery: null as SourceControlDiscoveryResult | null,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.discovery,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: { discovery: () => null },
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment", environmentIds: ["env-1"] },
    environment: {
      connection: { phase: "connected" },
      environmentId: "env-1",
      label: "Server",
    },
    connectedEnvironments: [],
  }),
}));
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./SourceControlWritingSettings", () => ({
  SourceControlWritingSettingsSection: () => null,
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsSearchTarget: ({ children }: { children: ReactNode }) => <>{children}</>,
  PolicyTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  SettingResetButton: () => null,
  useSettingsSearchTargetId: () => null,
}));
vi.mock("./settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: id }),
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children, variant }: { children: ReactNode; variant?: string }) => (
    <span data-badge-variant={variant}>{children}</span>
  ),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/switch", () => ({ Switch: "input" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
}));
vi.mock("~/components/ui/refresh-icon", () => ({ RefreshIcon: () => null }));
vi.mock("../Icons", () => {
  const Icon = () => null;
  return {
    AzureDevOpsIcon: Icon,
    BitbucketIcon: Icon,
    ForgejoIcon: Icon,
    GitHubIcon: Icon,
    GitIcon: Icon,
    GitLabIcon: Icon,
    JujutsuIcon: Icon,
  };
});

import { SourceControlSettingsPanel } from "./SourceControlSettings";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.discovery = {
    versionControlSystems: [
      {
        kind: "jj",
        implemented: true,
        label: "Jujutsu",
        status: "missing",
        version: Option.none(),
        installHint: "Install Jujutsu",
        detail: Option.none(),
      },
    ],
    sourceControlProviders: [
      {
        kind: "gitlab",
        label: "GitLab",
        status: "available",
        version: Option.none(),
        installHint: "Install GitLab CLI",
        detail: Option.none(),
        auth: {
          status: "unauthenticated",
          account: Option.none(),
          host: Option.none(),
          detail: Option.none(),
        },
      },
    ],
  };
  act(() => {
    renderer = create(<SourceControlSettingsPanel />);
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("source-control provider status indicators", () => {
  it("uses neutral styling for unauthenticated providers while preserving VCS warnings", () => {
    const statusDotClasses = renderer!.root
      .findAll(
        (node) =>
          typeof node.props.className === "string" &&
          node.props.className.includes("pointer-events-none") &&
          node.props.className.includes("rounded-full"),
      )
      .map((node) => String(node.props.className));

    expect(statusDotClasses).toEqual(
      expect.arrayContaining([
        expect.stringContaining("bg-muted-foreground/35"),
        expect.stringContaining("bg-warning"),
      ]),
    );
    expect(renderer!.root.findByProps({ "data-badge-variant": "secondary" }).children).toContain(
      "Not authenticated",
    );
    expect(renderer!.root.findAllByProps({ "data-badge-variant": "warning" })).toHaveLength(0);
  });
});
