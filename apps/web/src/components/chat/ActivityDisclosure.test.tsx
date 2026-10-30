// @vitest-environment jsdom

import { act, useId, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ActivityDisclosurePanel, useActivityDisclosure } from "./ActivityDisclosure";

type CardProps = Parameters<typeof useActivityDisclosure>[0];
interface MountedCard {
  readonly container: HTMLDivElement;
  readonly root: Root;
}
const mountedCards = new Set<MountedCard>();

function Card(props: CardProps) {
  const disclosure = useActivityDisclosure(props);
  const panelId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={disclosure.open}
        aria-controls={panelId}
        onClick={disclosure.toggle}
      >
        Activity details
      </button>
      <ActivityDisclosurePanel
        id={panelId}
        role="region"
        aria-label="Activity result"
        open={disclosure.open}
        instant={disclosure.instant}
      >
        <a href="#result">Read result</a>
      </ActivityDisclosurePanel>
    </>
  );
}

function mount(element: ReactElement): MountedCard {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  const card = { container, root };
  mountedCards.add(card);
  return card;
}

function unmount(card: MountedCard) {
  act(() => card.root.unmount());
  card.container.remove();
  mountedCards.delete(card);
}

function toggle(card: MountedCard, detail = 1) {
  const button = card.container.querySelector("button");
  expect(button).not.toBeNull();
  act(() => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
  });
}

function expectOpen(card: MountedCard) {
  expect(card.container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  const panel = card.container.querySelector('[role="region"]');
  expect(panel).not.toBeNull();
  expect(panel!.getAttribute("aria-hidden")).not.toBe("true");
  expect(panel!.hasAttribute("inert")).toBe(false);
  expect(panel!.querySelector("a")?.textContent).toBe("Read result");
}

function expectClosed(card: MountedCard) {
  expect(card.container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  const panel = card.container.querySelector('[role="region"]');
  if (panel !== null) {
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.hasAttribute("inert")).toBe(true);
  }
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  }));
});

afterEach(() => {
  for (const card of mountedCards) unmount(card);
  vi.unstubAllGlobals();
});

describe("activity disclosure interactions", () => {
  it("keeps an explicitly closed activity closed across native progress and completion", () => {
    const cache = new Set<string>();
    const card = mount(<Card cache={cache} disclosureKey="tool:first" defaultOpen />);
    expectOpen(card);
    toggle(card);
    expectClosed(card);
    for (const defaultOpen of [true, false, true]) {
      act(() => card.root.render(<Card cache={cache} disclosureKey="tool:first" defaultOpen={defaultOpen} />));
      expectClosed(card);
    }
  });

  it("keeps a manually reopened predecessor open after a successor and a virtualized remount", () => {
    const cache = new Set<string>();
    const card = mount(<Card cache={cache} disclosureKey="tool:first" defaultOpen={false} />);
    toggle(card);
    expectOpen(card);
    act(() => card.root.render(<Card cache={cache} disclosureKey="tool:first" defaultOpen={false} />));
    expectOpen(card);
    unmount(card);
    const restored = mount(<Card cache={cache} disclosureKey="tool:first" defaultOpen={false} />);
    expectOpen(restored);
  });

  it("restores a keyboard-closed activity instead of reopening it when recycled", () => {
    const cache = new Set<string>();
    const card = mount(<Card cache={cache} disclosureKey="tool:first" defaultOpen />);
    toggle(card, 0);
    expectClosed(card);
    unmount(card);
    const restored = mount(<Card cache={cache} disclosureKey="tool:first" defaultOpen />);
    expectClosed(restored);
  });

  it("keeps separate choices when the same component is recycled between activity identities", () => {
    const cache = new Set<string>();
    const card = mount(<Card cache={cache} disclosureKey="tool:first" defaultOpen />);
    toggle(card);
    expectClosed(card);
    act(() => card.root.render(<Card cache={cache} disclosureKey="tool:second" defaultOpen />));
    expectOpen(card);
    act(() => card.root.render(<Card cache={cache} disclosureKey="tool:first" defaultOpen />));
    expectClosed(card);
  });

  it("removes closed result actions from accessibility immediately and restores them on activation", () => {
    const card = mount(<Card disclosureKey="tool:first" defaultOpen />);
    expectOpen(card);
    toggle(card);
    expectClosed(card);
    toggle(card, 0);
    expectOpen(card);
  });
});
