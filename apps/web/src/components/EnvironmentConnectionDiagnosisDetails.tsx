import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  diagnoseEnvironmentConnection,
  type DesktopSshTunnelState,
} from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { environmentCatalog } from "../connection/catalog";
import { serverEnvironment } from "../state/server";

const LOCAL_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function EnvironmentConnectionDiagnosisDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const entry = useAtomValue(environmentCatalog.catalogValueAtom).entries.get(props.environmentId);
  const stateResult = useAtomValue(environmentCatalog.stateAtom(props.environmentId));
  const state = Option.getOrElse(AsyncResult.value(stateResult), () => AVAILABLE_CONNECTION_STATE);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const hostHealth = useAtomValue(serverEnvironment.hostHealthLatest(props.environmentId));
  const sshTarget =
    entry !== undefined &&
    Option.isSome(entry.profile) &&
    entry.profile.value._tag === "SshConnectionProfile"
      ? entry.profile.value.target
      : null;
  const [desktopTunnelState, setDesktopTunnelState] = useState<DesktopSshTunnelState | null>(null);
  const [now, setNow] = useState(() => performance.timeOrigin + performance.now());

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(performance.timeOrigin + performance.now()),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const getTunnelStatus = window.desktopBridge?.getSshTunnelStatus;
    if (sshTarget === null || getTunnelStatus === undefined) {
      setDesktopTunnelState(null);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      void getTunnelStatus(sshTarget).then(
        (status) => {
          if (!cancelled) setDesktopTunnelState(status);
        },
        () => {
          if (!cancelled) setDesktopTunnelState("unknown");
        },
      );
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sshTarget]);

  const diagnosis = diagnoseEnvironmentConnection({
    hostLabel: props.label,
    state,
    hostHealth,
    ...(networkStatus === "offline" || (typeof navigator !== "undefined" && !navigator.onLine)
      ? { browserOnline: false }
      : {}),
    desktopTunnelState,
    now,
  });

  return (
    <div className="max-w-sm space-y-1.5 text-xs">
      <p className="font-medium text-foreground">{diagnosis.headline}</p>
      <ul className="space-y-0.5 text-muted-foreground">
        {diagnosis.evidence.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {diagnosis.timestamp === null ? null : (
        <span className="block text-muted-foreground">
          {LOCAL_TIMESTAMP_FORMATTER.format(diagnosis.timestamp)}
        </span>
      )}
    </div>
  );
}
