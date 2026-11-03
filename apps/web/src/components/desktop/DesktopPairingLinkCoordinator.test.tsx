import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  listeners: [] as Array<(pairingUrl: string) => void>,
  connect: vi.fn(async (_input: { readonly pairingUrl: string }) => ({
    _tag: "Success" as const,
    value: "environment-1",
  })),
  confirm: vi.fn(async () => true),
  addToast: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (cause: unknown) => cause,
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.connect }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: state.confirm }));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: state.addToast },
}));

import { DesktopPairingLinkCoordinator } from "./DesktopPairingLinkCoordinator";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<DesktopPairingLinkCoordinator />);
    else renderer = create(<DesktopPairingLinkCoordinator />);
  });
}

async function sendPairingUrl(pairingUrl: string) {
  await act(async () => {
    for (const listener of state.listeners) listener(pairingUrl);
    await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledOnce());
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.listeners = [];
  state.confirm.mockResolvedValue(true);
  state.connect.mockResolvedValue({ _tag: "Success", value: "environment-1" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      desktopBridge: {
        pairingAppLink: {
          onLink: (listener: (pairingUrl: string) => void) => {
            state.listeners.push(listener);
            return () => {
              state.listeners = state.listeners.filter((current) => current !== listener);
            };
          },
        },
      },
    }),
  );
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("desktop pairing links", () => {
  it("confirms the backend origin before saving a pairing URL", async () => {
    await render();
    await sendPairingUrl("https://vps.example.com/pair#token=ABC123");
    await vi.waitFor(() => expect(state.addToast).toHaveBeenCalledOnce());
    expect(state.confirm).toHaveBeenCalledWith("Add the backend at https://vps.example.com?");
    expect(state.connect).toHaveBeenCalledWith({
      pairingUrl: "https://vps.example.com/pair#token=ABC123",
    });
    expect(state.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Backend added" }),
    );
  });

  it("does not spend a pairing URL when the user declines confirmation", async () => {
    state.confirm.mockResolvedValue(false);
    await render();
    await sendPairingUrl("http://192.168.1.4:3773/pair#token=ABC123");
    const confirmation = state.confirm.mock.results[0]?.value;
    if (!confirmation) throw new Error("The pairing confirmation was not requested.");
    await confirmation;

    expect(state.connect).not.toHaveBeenCalled();
    expect(state.addToast).not.toHaveBeenCalled();
  });
});
