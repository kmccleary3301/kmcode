import type { ClientSettingsPatch } from "@t3tools/contracts/settings";
import { EnvironmentId, UsageLimitSourceId } from "@t3tools/contracts";
import type { ServerSettingsPatch, UnifiedSettings } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  updateSettings: vi.fn<(patch: ServerSettingsPatch & ClientSettingsPatch) => void>(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: hooks.useState };
});
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateEnvironmentSettings: () => state.updateSettings,
}));

import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";

const environmentId = EnvironmentId.make("laptop");
const existingId = UsageLimitSourceId.make("existing");
const existingSource = {
  kind: "cliproxy" as const,
  url: "http://proxy.test:8318/original",
  managementKey: "old-key",
  enabled: true,
};

let sources: UnifiedSettings["usageLimitSources"];

function renderDialog(onOpenChange: (open: boolean) => void) {
  hooks.beginRender();
  return AddUsageLimitSourceDialog({
    open: true,
    onOpenChange,
    environmentId,
    environmentLabel: "Laptop",
    sources,
  });
}

function input(view: unknown, id: string) {
  const found = visitElements(view, (element) => element.props.id === id);
  if (!found || typeof found.props.onChange !== "function") {
    throw new Error(`Missing input: ${id}`);
  }
  return found.props.onChange;
}

function setInput(view: unknown, id: string, value: string) {
  Reflect.apply(input(view, id), undefined, [{ target: { value } }]);
}

function button(view: unknown, label: string): () => void {
  const found = visitElements(
    view,
    (element) =>
      (element.props.children === label ||
        (Array.isArray(element.props.children) && element.props.children.includes(label))) &&
      typeof element.props.onClick === "function",
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  const onClick = found.props.onClick;
  if (typeof onClick !== "function") throw new Error(`Missing button action: ${label}`);
  return () => Reflect.apply(onClick, undefined, []);
}

function addHub(onOpenChange: (open: boolean) => void, url: string, key: string, label: string) {
  let view = renderDialog(onOpenChange);
  setInput(view, "usage-source-url", url);
  view = renderDialog(onOpenChange);
  setInput(view, "usage-source-key", key);
  view = renderDialog(onOpenChange);
  setInput(view, "usage-source-label", label);
  view = renderDialog(onOpenChange);
  button(view, "Add hub")();
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  sources = { [existingId]: existingSource };
  state.updateSettings.mockImplementation((patch) => {
    for (const [id, source] of Object.entries(patch.usageLimitSources ?? {})) {
      if (source === null) continue;
      sources = { ...sources, [UsageLimitSourceId.make(id)]: source };
    }
  });
});

it("keeps same-host hubs and existing settings when adding them", () => {
  const onOpenChange = vi.fn<(open: boolean) => void>();

  addHub(onOpenChange, "http://proxy.test:8318/hub-a", "first-key", "First hub");
  addHub(onOpenChange, "http://proxy.test:8318/hub-b", "second-key", "Second hub");
  addHub(onOpenChange, "http://proxy.test:8318/hub-b/extra", "third-key", "Third hub");
  addHub(onOpenChange, "http://proxy.test:8318/hub-a", "updated-key", "Updated first hub");

  expect(sources).toEqual({
    [existingId]: existingSource,
    [UsageLimitSourceId.make("cliproxy-proxy.test-8318")]: {
      kind: "cliproxy",
      label: "Updated first hub",
      url: "http://proxy.test:8318/hub-a",
      managementKey: "updated-key",
      enabled: true,
    },
    [UsageLimitSourceId.make("cliproxy-proxy.test-8318-2")]: {
      kind: "cliproxy",
      label: "Second hub",
      url: "http://proxy.test:8318/hub-b",
      managementKey: "second-key",
      enabled: true,
    },
    [UsageLimitSourceId.make("cliproxy-proxy.test-8318-3")]: {
      kind: "cliproxy",
      label: "Third hub",
      url: "http://proxy.test:8318/hub-b/extra",
      managementKey: "third-key",
      enabled: true,
    },
  });
  expect(onOpenChange).toHaveBeenCalledTimes(4);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
});
