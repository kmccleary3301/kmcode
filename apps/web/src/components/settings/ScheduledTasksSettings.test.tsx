import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  environments: [] as Array<{ environmentId: string; label: string }>,
  defaultEnvironment: null as { environmentId: string; label: string } | null,
  permissions: [] as boolean[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: () => undefined,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", async () => ({ c: hooks.useMemoCache }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.permissions }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment" },
    environments: state.environments,
    connectedEnvironments: state.environments,
    environment: state.defaultEnvironment,
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    upsertScheduledTask: { permissionAtom: (environmentId: string) => environmentId },
  },
  EMPTY_SERVER_PROVIDERS: {},
}));

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

const laptopId = EnvironmentId.make("laptop");
const secondaryId = EnvironmentId.make("secondary");
const laptop = { environmentId: laptopId, label: "Laptop" };
const secondary = { environmentId: secondaryId, label: "Secondary" };

function renderSettings() {
  hooks.beginRender();
  return ScheduledTasksSettings({});
}

function createButton(view: unknown) {
  const element = visitElements(
    view,
    (candidate) =>
      (candidate.props.children === "New task" ||
        (Array.isArray(candidate.props.children) &&
          candidate.props.children.includes("New task"))) &&
      typeof candidate.props.onClick === "function",
  );
  if (!element) throw new Error("Missing New task button.");
  return element;
}

function openEditor(view: unknown) {
  const button = createButton(view);
  if (typeof button.props.onClick !== "function")
    throw new Error("New task button is not clickable.");
  Reflect.apply(button.props.onClick, undefined, []);
}

function editorEnvironment(view: unknown) {
  return visitElements(view, (element) => element.props.initialEnvironmentId !== undefined)?.props
    .initialEnvironmentId;
}

beforeEach(() => {
  hooks.reset();
  state.environments = [laptop, secondary];
  state.defaultEnvironment = laptop;
  state.permissions = [true, true];
});

it("uses a permitted secondary environment when the default cannot create tasks", () => {
  state.permissions = [false, true];
  const view = renderSettings();
  const button = createButton(view);

  expect(button.props.disabled).not.toBe(true);
  openEditor(view);
  expect(editorEnvironment(renderSettings())).toBe(secondaryId);
});

it("prefers the default environment when it is permitted", () => {
  const view = renderSettings();

  openEditor(view);
  expect(editorEnvironment(renderSettings())).toBe(laptopId);
});

it("disables creation and follows permission changes", () => {
  state.permissions = [false, false];
  expect(createButton(renderSettings()).props.disabled).toBe(true);

  state.permissions = [false, true];
  expect(createButton(renderSettings()).props.disabled).not.toBe(true);
});
