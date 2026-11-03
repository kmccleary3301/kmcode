import {
  isValidElement,
  type ComponentType,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";

const testState = vi.hoisted(() => ({
  faviconUrl: "https://environment.test/api/assets/token-a/v1-20-favicon.svg",
  lastTarget: null as unknown,
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("lucide-react/dynamic", () => ({
  DynamicIcon: "dynamic-icon",
  iconNames: ["alarm-clock", "folder-code"],
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.faviconUrl,
}));
vi.mock("../state/assets", () => ({
  projectFaviconUrlAtom: (input: unknown) => {
    testState.lastTarget = input;
  },
}));

import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";

function makeProject(
  overrides: Partial<ProjectFaviconProject> &
    Pick<ProjectFaviconProject, "workspaceRoot" | "title">,
): ProjectFaviconProject {
  return { environmentId: "environment-test" as EnvironmentId, ...overrides };
}

type ProjectFaviconImageProps = {
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
  readonly fallbackProjectName?: string | undefined;
};

type ImageElement = ReactElement<{
  readonly src: string;
  readonly onLoad?: () => void;
  readonly onError?: () => void;
}>;

type ProjectFaviconImageElement = ReactElement<{
  readonly children: [ReactElement | null, ImageElement | null, ImageElement | null];
}>;

type ProjectFaviconFallbackProps = {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
  readonly emoji?: string | undefined;
  readonly projectName?: string | undefined;
};

type ProjectMonogramProps = {
  readonly text: string;
  readonly color: string;
  readonly className?: string | undefined;
};

function isFunctionComponent<Props>(
  type: ReactElement<Props>["type"],
): type is (props: Props) => ReactNode {
  return typeof type === "function";
}

function renderFunctionComponent<Props>(element: ReactElement<Props>): ReactNode {
  if (!isFunctionComponent(element.type)) {
    throw new Error("Expected a function component element");
  }
  return element.type(element.props);
}

function isProjectFaviconFallbackElement(
  element: ReactNode,
): element is ReactElement<ProjectFaviconFallbackProps> {
  return (
    isValidElement(element) &&
    typeof element.props === "object" &&
    element.props !== null &&
    "projectName" in element.props &&
    typeof element.props.projectName === "string" &&
    "icon" in element.props
  );
}

function isProjectFaviconImageElement(
  element: ReactNode,
): element is ReactElement<ProjectFaviconImageProps> {
  return (
    isValidElement(element) &&
    typeof element.props === "object" &&
    element.props !== null &&
    "src" in element.props &&
    typeof element.props.src === "string" &&
    "fallbackIcon" in element.props
  );
}

function renderProjectFavicon(project: ProjectFaviconProject): ReactNode {
  hooks.reset();
  hooks.beginRender();
  const element = ProjectFavicon({ project });
  hooks.reset();
  hooks.beginRender();
  const rendered = renderFunctionComponent(element);
  hooks.reset();
  return rendered;
}

function resolveProjectMonogram(
  project: ProjectFaviconProject,
): ReactElement<ProjectMonogramProps> {
  const fallback = renderProjectFavicon(project);
  if (!isProjectFaviconFallbackElement(fallback)) {
    throw new Error("Expected an automatic project favicon fallback");
  }
  hooks.beginRender();
  const monogram = renderFunctionComponent(fallback);
  hooks.reset();
  if (!isValidElement<ProjectMonogramProps>(monogram)) {
    throw new Error("Expected the project monogram element");
  }
  return monogram;
}

function resolveImageElement(): ReactElement<ProjectFaviconImageProps> {
  const element = renderProjectFavicon(
    makeProject({ workspaceRoot: "/workspace-test", title: "workspace-test" }),
  );
  if (!isProjectFaviconImageElement(element)) {
    throw new Error("Expected the displayed favicon image component");
  }
  return element;
}

function renderImage(
  element: ReactElement<ProjectFaviconImageProps>,
  props: ProjectFaviconImageProps = element.props,
): ProjectFaviconImageElement {
  hooks.beginRender();
  const rendered = renderFunctionComponent({ ...element, props });
  if (!isValidElement<ProjectFaviconImageElement["props"]>(rendered)) {
    throw new Error("Expected the favicon image fragment");
  }
  return rendered;
}

describe("ProjectFavicon", () => {
  beforeEach(() => {
    hooks.reset();
    testState.faviconUrl = "https://environment.test/api/assets/token-a/v1-20-favicon.svg";
    testState.lastTarget = null;
  });

  it("shows the project monogram when no favicon exists", () => {
    testState.faviconUrl = `https://environment.test/api/assets/token/${PROJECT_FAVICON_FALLBACK_MARKER}`;

    const monogram = resolveProjectMonogram(
      makeProject({ workspaceRoot: "/workspace/analytics-db", title: "analytics-db" }),
    );

    expect(monogram.props.text).toBe("AD");
  });

  it("uses the same monogram fallback for every project category", () => {
    testState.faviconUrl = `https://environment.test/api/assets/token/${PROJECT_FAVICON_FALLBACK_MARKER}`;

    const monogram = resolveProjectMonogram(
      makeProject({ workspaceRoot: "/workspace/agent-runtime", title: "agent-runtime" }),
    );

    expect(monogram.props.text).toBe("AR");
  });

  it("renders a saved Lucide icon and color ahead of an uploaded favicon", () => {
    const element = ProjectFavicon({
      project: makeProject({
        workspaceRoot: "/workspace/test",
        title: "test",
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
      }),
    }) as ReactElement<{
      readonly children: ReactElement<{
        readonly children: ReactElement<{ readonly name: string; readonly className: string }>;
      }>;
      readonly className: string;
    }>;

    expect(element.props.children.props.children.props.name).toBe("alarm-clock");
    expect(element.props.className).toContain("text-violet-600");
    expect(element.props.children.props.children.props.className).toContain("text-violet-600");
  });

  it("renders a saved emoji ahead of an uploaded favicon", () => {
    const element = ProjectFavicon({
      project: makeProject({
        workspaceRoot: "/workspace/test",
        title: "test",
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "emoji", emoji: "🦄" },
      }),
    }) as ReactElement<{ readonly emoji: string }>;

    expect(element.props.emoji).toBe("🦄");
  });

  it("falls back when the displayed favicon fails without discarding a valid older image early", () => {
    const image = resolveImageElement();
    const initialLoadingImage = renderImage(image).props.children[2];
    initialLoadingImage?.props.onLoad?.();

    const refreshedProps = {
      ...image.props,
      src: "https://environment.test/api/assets/token-b/v1-20-favicon.svg",
    };
    const refreshing = renderImage(image, refreshedProps).props.children;
    expect(refreshing[1]?.props.src).toBe(image.props.src);
    refreshing[2]?.props.onError?.();

    const afterRefreshError = renderImage(image, refreshedProps).props.children;
    expect(afterRefreshError[1]?.props.src).toBe(image.props.src);
    afterRefreshError[1]?.props.onError?.();

    const afterDisplayedError = renderImage(image, refreshedProps).props.children;
    expect(afterDisplayedError[0]).not.toBeNull();
    expect(afterDisplayedError[1]).toBeNull();
  });

  it("requests a saved favicon path when one is set", () => {
    renderProjectFavicon(
      makeProject({
        workspaceRoot: "/workspace-test",
        title: "workspace-test",
        faviconPath: "brand/icon.svg",
      }),
    );

    expect(testState.lastTarget).toMatchObject({
      environmentId: "environment-test",
      cwd: "/workspace-test",
      faviconPath: "brand/icon.svg",
    });
  });
});
