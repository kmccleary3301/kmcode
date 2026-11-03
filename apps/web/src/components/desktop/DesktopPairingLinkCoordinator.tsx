import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { useEffect, useEffectEvent, useRef } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { connectPairing } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function DesktopPairingLinkCoordinator() {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const pairedUrlsRef = useRef(new Set<string>());
  const inFlightUrlsRef = useRef(new Set<string>());

  const receivePairingLink = useEffectEvent(async (pairingUrl: string) => {
    if (pairedUrlsRef.current.has(pairingUrl)) return;
    if (inFlightUrlsRef.current.has(pairingUrl)) return;

    inFlightUrlsRef.current.add(pairingUrl);
    try {
      let origin: string;
      try {
        origin = new URL(resolveRemotePairingTarget({ pairingUrl }).httpBaseUrl).origin;
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add backend",
            description: error instanceof Error ? error.message : "Pairing URL is invalid.",
          }),
        );
        return;
      }

      const confirmed = (await requestConfirmDialog(`Add the backend at ${origin}?`)) ?? false;
      if (!confirmed) return;

      const result = await connectPairingEnvironment({ pairingUrl });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not add backend",
              description: error instanceof Error ? error.message : "Pairing failed.",
            }),
          );
        }
        return;
      }

      pairedUrlsRef.current.add(pairingUrl);
      toastManager.add({
        type: "success",
        title: "Backend added",
        description: "The environment is saved and will reconnect on app startup.",
      });
    } finally {
      inFlightUrlsRef.current.delete(pairingUrl);
    }
  });

  useEffect(() => {
    const pairingAppLink = window.desktopBridge?.pairingAppLink;
    if (!pairingAppLink) return;
    return pairingAppLink.onLink((pairingUrl) => {
      void receivePairingLink(pairingUrl);
    });
  }, [receivePairingLink]);

  return null;
}
