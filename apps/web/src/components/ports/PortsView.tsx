import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import type {
  ForwardedPort,
  ListeningPort,
  PortForwardHost,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  Check,
  Copy,
  ExternalLink,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import * as Option from "effect/Option";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { previewRuntimeFor, usePreviewAvailable } from "~/browser/previewRuntime";
import { recordVisitForThread } from "~/browserHistoryStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { openPreviewSession } from "../preview/openPreviewSession";
import { useClientSettings } from "../../hooks/useSettings";
import {
  autoForwardErrorsAtom,
  autoForwardingEnabledAtom,
  forwardedPortsAtom,
  isPortForwardingAvailable,
  portKey,
  refreshListeningPorts,
  setAutoForwardingEnabled,
  setPortForwardExclusionHidden,
  startPortForward,
  stopAllPortForwards,
  stopPortForward,
  useListeningPorts,
} from "../../state/portForwarding";
import { listenerIdentityKey } from "../../state/portForwardingPolicy";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

export interface PortsViewProps {
  readonly threadRef: ScopedThreadRef;
}
interface PortRow {
  readonly key: string;
  readonly remotePort: number;
  readonly remoteHost: PortForwardHost;
  readonly forward: ForwardedPort | null;
  readonly process: ListeningPort | null;
  readonly error: string | null;
}

export function parsePortNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function formatLoopbackUrl(host: PortForwardHost, port: number): string {
  return `http://${host === "::1" ? "[::1]" : host}:${port}`;
}

export function PortsView({ threadRef }: PortsViewProps) {
  const environmentId = threadRef.environmentId;
  const desktop = isPortForwardingAvailable();
  const local = environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID;
  const connected = Option.isSome(usePreparedConnection(environmentId));
  const permitted = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const previewAvailable = usePreviewAvailable(environmentId);
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const forwards = useAtomValue(forwardedPortsAtom);
  const discovery = useListeningPorts(environmentId);
  const autoForwardEnabled = useAtomValue(autoForwardingEnabledAtom(environmentId));
  const autoForwardErrors = useAtomValue(autoForwardErrorsAtom(environmentId));
  const portForwardExclusions = useClientSettings((settings) => settings.portForwardExclusions);
  const autoForwardLimit = useClientSettings((settings) => settings.portAutoForwardLimit);
  const autoForwardCount = forwards.filter(
    (forward) => forward.environmentId === environmentId && forward.origin === "auto",
  ).length;
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const removedPortEntries = useMemo(
    () =>
      portForwardExclusions.filter(
        (exclusion) => exclusion.environmentId === environmentId && exclusion.hidden,
      ),
    [environmentId, portForwardExclusions],
  );
  const removedPortNumbers = useMemo(
    () => new Set(removedPortEntries.map((exclusion) => exclusion.remotePort)),
    [removedPortEntries],
  );
  const [showRemoved, setShowRemoved] = useState(false);
  const inputId = useId();
  const [adding, setAdding] = useState(false);
  const [remotePort, setRemotePort] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState<PortForwardHost>("localhost");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [previewingPort, setPreviewingPort] = useState<number | null>(null);

  const previewDisabledReason = !connected
    ? "Environment is disconnected."
    : !canOperatePreview
      ? "Preview operate permission is required."
      : !previewAvailable
        ? "Browser preview is unavailable for this environment."
        : null;
  const canPreview = previewDisabledReason === null;

  useEffect(() => {
    if (desktop || !connected) return;

    let isDisposed = false;
    let inFlight = false;
    let generation = 0;
    let timer: number | undefined;

    const schedule = (delayMs: number) => {
      if (isDisposed) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void poll();
      }, delayMs);
    };

    const poll = async () => {
      if (isDisposed || inFlight) return;
      inFlight = true;
      const currentGen = ++generation;
      try {
        await refreshListeningPorts(environmentId);
      } catch {
        // Discovery error state is captured inside refreshListeningPorts in the atom
      } finally {
        inFlight = false;
        if (!isDisposed && generation === currentGen) {
          schedule(2500);
        }
      }
    };

    schedule(2500);

    return () => {
      isDisposed = true;
      generation++;
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
  }, [connected, desktop, environmentId]);
  const rows = useMemo(() => {
    const ports: Record<string, PortRow> = {};
    for (const forward of forwards) {
      if (forward.environmentId !== environmentId) continue;
      const key = portKey(environmentId, forward.remoteHost, forward.remotePort);
      ports[key] = {
        key,
        remotePort: forward.remotePort,
        remoteHost: forward.remoteHost,
        forward,
        process: null,
        error: forward.status === "error" ? forward.error : null,
      };
    }
    for (const process of discovery.ports) {
      const key = portKey(environmentId, process.host, process.port);
      const identity = listenerIdentityKey(process.host, process.port, process.pid);
      const rowError = ports[key]?.error ?? autoForwardErrors[identity] ?? null;
      ports[key] = {
        key,
        remotePort: process.port,
        remoteHost: process.host,
        forward: ports[key]?.forward ?? null,
        process,
        error: rowError,
      };
    }
    return Object.values(ports)
      .filter((row) => row.forward !== null || !removedPortNumbers.has(row.remotePort))
      .toSorted(
        (left, right) =>
          left.remotePort - right.remotePort || left.remoteHost.localeCompare(right.remoteHost),
      );
  }, [autoForwardErrors, discovery.ports, environmentId, forwards, removedPortNumbers]);

  async function forward(port: number, host: PortForwardHost, requestedLocalPort: number) {
    setError(null);
    setBusy(true);
    try {
      if (!desktop || !permitted || !connected) {
        throw new Error(
          "Connect this environment with terminal operate permission before forwarding.",
        );
      }
      if (local && port === requestedLocalPort) {
        throw new Error(
          "This port is already local. Choose a different local port only if you need an alias.",
        );
      }
      await startPortForward({
        environmentId,
        remotePort: port,
        remoteHost: host,
        localPort: requestedLocalPort,
        origin: "user",
      });
      setAdding(false);
      setRemotePort("");
      setLocalPort("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not forward this port.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = parsePortNumber(remotePort);
    const requested = localPort.trim() === "" ? target : parsePortNumber(localPort);
    if (target === null || requested === null) {
      setError("Ports must be whole numbers from 1 to 65535.");
      return;
    }
    void forward(target, remoteHost, requested);
  }

  function listenersForPort(row: PortRow) {
    const matchingListeners = discovery.ports.filter(
      (listener) => listener.port === row.remotePort,
    );
    return matchingListeners.length > 0
      ? matchingListeners
      : [row.process ?? { host: row.remoteHost, port: row.remotePort, pid: null }];
  }

  async function stop(row: PortRow) {
    setError(null);
    setBusy(true);
    try {
      await stopPortForward(
        { environmentId, remoteHost: row.remoteHost, remotePort: row.remotePort },
        listenersForPort(row),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop forwarding.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: PortRow) {
    setError(null);
    setBusy(true);
    try {
      if (row.forward) {
        await stopPortForward(
          { environmentId, remoteHost: row.remoteHost, remotePort: row.remotePort },
          listenersForPort(row),
        );
      }
      await setPortForwardExclusionHidden(environmentId, row.remotePort, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove this port.");
    } finally {
      setBusy(false);
    }
  }

  async function restoreRemovedPort(port: number) {
    setError(null);
    setBusy(true);
    try {
      await setPortForwardExclusionHidden(environmentId, port, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this port.");
    } finally {
      setBusy(false);
    }
  }

  async function stopAll() {
    setError(null);
    setBusy(true);
    try {
      await stopAllPortForwards();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop all forwarding.");
    } finally {
      setBusy(false);
      setConfirmStopAll(false);
    }
  }

  async function copy(row: PortRow) {
    if (row.forward === null) return;
    try {
      await navigator.clipboard.writeText(row.forward.localAddress);
      setCopied(row.key);
    } catch {
      setError("Could not copy the local address.");
    }
  }

  async function open(row: PortRow) {
    const address = row.forward?.localAddress ?? (local ? `localhost:${row.remotePort}` : null);
    if (address === null) return;
    try {
      await window.desktopBridge?.openExternal(`http://${address}`);
    } catch {
      setError("Could not open the local address in your browser.");
    }
  }
  async function openPreviewForPort(row: PortRow) {
    if (!canPreview) return;
    setError(null);
    setPreviewingPort(row.remotePort);
    try {
      const rawUrl = formatLoopbackUrl(row.remoteHost, row.remotePort);
      const runtime = previewRuntimeFor(environmentId);
      const resolvedUrl =
        runtime === "server" ? rawUrl : resolveDiscoveredServerUrl(environmentId, rawUrl);

      const result = await openPreviewSession({
        openPreview,
        threadRef,
        url: resolvedUrl,
      });

      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          const message =
            failure instanceof Error ? failure.message : "The preview could not be opened.";
          setError(message);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open preview",
              description: message,
            }),
          );
        }
        return;
      }

      recordVisitForThread(threadRef, rawUrl);
      useRightPanelStore.getState().openBrowser(threadRef, result.value.tabId);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "An error occurred while opening preview.";
      setError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open preview",
          description: message,
        }),
      );
    } finally {
      setPreviewingPort(null);
    }
  }

  return (
    <section
      aria-label="Ports"
      data-t3-surface="ports-view"
      className="flex h-full min-h-0 flex-col bg-background text-xs"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="font-medium">
          Ports <span className="text-muted-foreground">{rows.length}</span>
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!local && desktop && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <span>Auto forward</span>
              <Switch
                size="sm"
                checked={autoForwardEnabled}
                disabled={busy}
                onCheckedChange={(checked) => {
                  void setAutoForwardingEnabled(environmentId, Boolean(checked)).catch((cause) => {
                    setError(
                      cause instanceof Error ? cause.message : "Could not change auto-forwarding.",
                    );
                  });
                }}
                aria-label="Automatic port forwarding"
              />
            </label>
          )}
          {removedPortEntries.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              className="pointer-coarse:min-h-11"
              aria-label={
                `${showRemoved ? "Hide" : "Show"} removed ports ` +
                `(${removedPortEntries.length})`
              }
              onClick={() => setShowRemoved((visible) => !visible)}
            >
              <RotateCcw /> Removed ({removedPortEntries.length})
            </Button>
          )}
          {desktop && forwards.length > 0 && (
            <Button
              size="xs"
              variant="outline"
              className="pointer-coarse:min-h-11"
              disabled={busy}
              title="Stop every port forward in every environment"
              onClick={() => setConfirmStopAll(true)}
            >
              <Square /> Stop all ({forwards.length})
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={discovery.loading || !connected}
            onClick={discovery.refresh}
            aria-label="Refresh ports"
          >
            <RefreshCw /> Refresh
          </Button>
          {desktop && (
            <Button
              size="xs"
              variant="outline"
              disabled={!permitted || !connected || busy}
              onClick={() => setAdding(!adding)}
            >
              <Plus /> Add port
            </Button>
          )}
        </div>
      </div>
      {showRemoved && removedPortEntries.length > 0 && (
        <section aria-label="Removed ports" className="border-b px-3 py-2">
          <ul className="flex flex-wrap items-center gap-2">
            {removedPortEntries.map((entry) => (
              <li
                key={`${entry.environmentId}:${entry.remotePort}`}
                className="flex items-center gap-2"
              >
                <span>Port {entry.remotePort} is removed and will not auto-forward.</span>
                <Button
                  size="xs"
                  variant="outline"
                  className="pointer-coarse:min-h-11"
                  disabled={busy}
                  aria-label={`Restore removed port ${entry.remotePort}`}
                  onClick={() => void restoreRemovedPort(entry.remotePort)}
                >
                  <RotateCcw /> Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!desktop && (
        <p className="border-b px-3 py-2 text-muted-foreground">
          Open remote web ports in Preview. Binding a local TCP listener, including OAuth callback
          ports, requires the desktop app.
        </p>
      )}
      {!connected && (
        <p className="border-b px-3 py-2 text-muted-foreground">
          Environment disconnected. Existing listeners wait for the next connection; active streams
          cannot resume.
        </p>
      )}
      {desktop && !local && autoForwardEnabled && autoForwardCount >= autoForwardLimit && (
        <p className="border-b px-3 py-2 text-muted-foreground">
          Auto-forward limit reached ({autoForwardLimit}). New ports are not forwarded until a
          forwarded server exits. The limit is in Settings → Connections.
        </p>
      )}
      {desktop && connected && !permitted && (
        <p className="border-b px-3 py-2 text-muted-foreground">
          Terminal operate permission is required to forward ports.
        </p>
      )}
      {!desktop && connected && !canOperatePreview && (
        <p className="border-b px-3 py-2 text-muted-foreground">
          Preview operate permission is required to open preview.
        </p>
      )}
      {!desktop && connected && canOperatePreview && !previewAvailable && (
        <p className="border-b px-3 py-2 text-muted-foreground">
          Browser preview is unavailable for this environment.
        </p>
      )}
      {desktop && local && (
        <p className="border-b px-3 py-2 text-muted-foreground">
          These processes are already local. Forward only to a different local port if you need an
          alias.
        </p>
      )}
      {(error ?? discovery.error) && (
        <p role="alert" className="border-b px-3 py-2 text-destructive">
          {error ?? discovery.error}
        </p>
      )}
      {adding && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3 border-b p-3">
          <div className="w-28">
            <label htmlFor={`${inputId}-remote`} className="mb-1 block">
              Remote port
            </label>
            <Input
              id={`${inputId}-remote`}
              inputMode="numeric"
              value={remotePort}
              onChange={(event) => setRemotePort(event.target.value)}
              placeholder="1455"
              autoFocus
              required
            />
          </div>
          <div className="w-28">
            <label htmlFor={`${inputId}-local`} className="mb-1 block">
              Local port
            </label>
            <Input
              id={`${inputId}-local`}
              inputMode="numeric"
              value={localPort}
              onChange={(event) => setLocalPort(event.target.value)}
              placeholder="Same as remote"
            />
          </div>
          <div>
            <label htmlFor={`${inputId}-host`} className="mb-1 block">
              Remote loopback
            </label>
            <select
              id={`${inputId}-host`}
              value={remoteHost}
              onChange={(event) => {
                const host = event.target.value;
                if (host === "localhost" || host === "127.0.0.1" || host === "::1")
                  setRemoteHost(host);
              }}
              className="h-8 rounded-md border border-input bg-background px-2"
            >
              <option value="localhost">localhost</option>
              <option value="127.0.0.1">127.0.0.1</option>
              <option value="::1">::1</option>
            </select>
          </div>
          <Button type="submit" size="sm" disabled={busy || !connected || !permitted}>
            {busy ? "Forwarding…" : "Forward"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <p className="p-4 text-muted-foreground">
            {discovery.loading
              ? "Looking for listening ports…"
              : desktop
                ? "No ports detected. Add a port before starting a login or server."
                : "No ports detected."}
          </p>
        ) : (
          <table className="w-full whitespace-nowrap text-left">
            <thead className="sticky top-0 z-20 border-b bg-background text-muted-foreground">
              <tr>
                <th className="sticky left-0 z-20 bg-background px-3 py-2 font-medium">Port</th>
                {desktop && <th className="px-3 py-2 font-medium">Forwarded address</th>}
                <th className="px-3 py-2 font-medium">Running process</th>
                {desktop && <th className="px-3 py-2 font-medium">Origin</th>}
                <th className={cn("px-3 py-2 font-medium", !desktop && "hidden sm:table-cell")}>
                  Status
                </th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="sticky left-0 z-10 bg-background px-3 py-2 font-mono">
                    {row.remotePort}
                    <span
                      className={cn(
                        "ml-0 block text-3xs text-muted-foreground",
                        desktop && "sm:ml-1 sm:inline sm:text-xs",
                      )}
                    >
                      {row.remoteHost}
                    </span>
                  </td>
                  {desktop && (
                    <td className="px-3 py-2 font-mono">
                      {row.forward?.localAddress ?? (local ? `localhost:${row.remotePort}` : "—")}
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <div className="flex flex-col">
                      <div
                        className={cn(
                          "flex items-center gap-1",
                          !desktop && "items-start flex-col",
                        )}
                      >
                        <span className={cn(!desktop && "max-w-28 truncate sm:max-w-none")}>
                          {row.process?.processName ?? "—"}
                        </span>
                        {row.process?.pid != null && (
                          <span
                            className={cn(
                              "ml-1 text-muted-foreground",
                              !desktop && "ml-0 text-3xs",
                            )}
                          >
                            {row.process.pid}
                          </span>
                        )}
                      </div>
                      {!desktop && row.error && (
                        <span className="text-destructive sm:hidden">{row.error}</span>
                      )}
                    </div>
                  </td>
                  {desktop && (
                    <td className="px-3 py-2 text-muted-foreground">
                      {row.forward
                        ? row.forward.origin === "auto"
                          ? "Auto forwarded"
                          : "User forwarded"
                        : "Detected"}
                    </td>
                  )}
                  <td className={cn("px-3 py-2", !desktop && "hidden sm:table-cell")}>
                    {desktop ? (
                      row.forward?.status === "error" ? (
                        <span className="text-destructive">
                          {row.forward.error ?? "Connection failed"}
                        </span>
                      ) : row.error ? (
                        <span className="text-destructive">{row.error}</span>
                      ) : row.forward?.status === "forwarding" ? (
                        `Active (${row.forward.activeConnections})`
                      ) : row.forward ? (
                        "Listening"
                      ) : local ? (
                        "Local"
                      ) : (
                        "Not forwarded"
                      )
                    ) : row.error ? (
                      <span className="text-destructive">{row.error}</span>
                    ) : !connected ? (
                      <span className="text-muted-foreground">Disconnected</span>
                    ) : !canOperatePreview ? (
                      <span className="text-muted-foreground">Permission required</span>
                    ) : !previewAvailable ? (
                      <span className="text-muted-foreground">Preview unavailable</span>
                    ) : (
                      "Available"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {desktop ? (
                      <div className="flex items-center gap-1">
                        {row.forward && (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            className="pointer-coarse:size-11"
                            aria-label={`Copy address for port ${row.remotePort}`}
                            title="Copy address"
                            onClick={() => void copy(row)}
                          >
                            {copied === row.key ? <Check /> : <Copy />}
                          </Button>
                        )}
                        {(row.forward || local) && (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            className="pointer-coarse:size-11"
                            aria-label={`Open port ${row.remotePort}`}
                            title="Open in browser"
                            onClick={() => void open(row)}
                          >
                            <ExternalLink />
                          </Button>
                        )}
                        {row.forward ? (
                          <Button
                            size="icon-xs"
                            variant="ghost-destructive"
                            className="pointer-coarse:size-11"
                            disabled={busy}
                            aria-label={`Stop forwarding port ${row.remotePort}`}
                            title="Stop forwarding"
                            onClick={() => void stop(row)}
                          >
                            <Square />
                          </Button>
                        ) : (
                          !local && (
                            <Button
                              size="xs"
                              variant="outline"
                              className="pointer-coarse:min-h-11"
                              disabled={busy || !connected || !permitted}
                              onClick={() =>
                                void forward(row.remotePort, row.remoteHost, row.remotePort)
                              }
                            >
                              Forward
                            </Button>
                          )
                        )}
                        <Button
                          size="icon-xs"
                          variant="ghost-destructive"
                          className="pointer-coarse:size-11"
                          disabled={busy}
                          aria-label={`Remove port ${row.remotePort}`}
                          title="Remove port"
                          onClick={() => void remove(row)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Button
                          size="xs"
                          variant="outline"
                          className="pointer-coarse:min-h-11"
                          disabled={!canPreview || previewingPort === row.remotePort}
                          title={
                            previewDisabledReason ??
                            `Open ${row.remoteHost}:${row.remotePort} in preview`
                          }
                          aria-label={`Open port ${row.remotePort} in preview`}
                          onClick={() => void openPreviewForPort(row)}
                        >
                          {previewingPort === row.remotePort ? "Opening…" : "Preview"}
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost-destructive"
                          className="pointer-coarse:size-11"
                          disabled={busy}
                          aria-label={`Remove port ${row.remotePort}`}
                          title="Remove port"
                          onClick={() => void remove(row)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <AlertDialog
        open={confirmStopAll}
        onOpenChange={(open) => {
          if (!busy) setConfirmStopAll(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop all {forwards.length} port {forwards.length === 1 ? "forward" : "forwards"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Closes every local port KM Code is forwarding, in every environment. Servers listening
              right now won't be auto-forwarded again; servers started later still will be.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void stopAll()}>
              Stop all
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
