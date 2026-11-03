"use client";

import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderNativeSessionSummary } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { waitForThreadShell } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteView,
} from "./CommandPalette.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface NativeSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly entry: ProviderInstanceEntry;
}

interface LoadedNativeSession {
  readonly target: NativeSessionTarget;
  readonly session: ProviderNativeSessionSummary;
}

export interface NativeSessionTargetLoadResult {
  readonly target: NativeSessionTarget;
  readonly sessions?: ReadonlyArray<ProviderNativeSessionSummary>;
  readonly error?: string;
}

export interface NativeSessionLoadOutcome {
  readonly status: "success" | "partial" | "failure";
  readonly sessions: ReadonlyArray<LoadedNativeSession>;
  readonly errors: ReadonlyArray<string>;
}

export function resolveNativeSessionLoadOutcome(
  results: ReadonlyArray<NativeSessionTargetLoadResult>,
): NativeSessionLoadOutcome {
  const sessions: LoadedNativeSession[] = [];
  const errors: string[] = [];
  let successfulTargets = 0;

  for (const result of results) {
    if (result.sessions === undefined) {
      if (result.error !== undefined) errors.push(result.error);
      continue;
    }
    successfulTargets += 1;
    for (const session of result.sessions) sessions.push({ target: result.target, session });
  }

  sessions.sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
  return {
    status:
      successfulTargets === 0
        ? "failure"
        : successfulTargets === results.length
          ? "success"
          : "partial",
    sessions,
    errors,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "Unknown error";
}

function failureDescription(errors: ReadonlyArray<string>): string | undefined {
  if (errors.length === 0) return undefined;
  return errors.length === 1 ? errors[0] : `${errors[0]} (+${errors.length - 1} more)`;
}

export function useNativeSessionPaletteAction(input: {
  readonly pushView: (view: CommandPaletteView) => void;
  readonly closePalette: () => void;
}): CommandPaletteActionItem | null {
  const navigate = useNavigate();
  const loadNativeSessions = useAtomQueryRunner(serverEnvironment.nativeSessions, {
    reportFailure: false,
  });
  const openNativeSession = useAtomCommand(serverEnvironment.openNativeSession, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const targets = useMemo(() => {
    const next: NativeSessionTarget[] = [];
    for (const environment of environments) {
      if (environment.connection.phase !== "connected") continue;
      const providers =
        environment.serverConfig?.providers ??
        (environment.environmentId === primaryEnvironmentId ? primaryProviders : []);
      for (const entry of deriveProviderInstanceEntries(providers)) {
        if (
          (entry.driverKind !== "pi" && entry.driverKind !== "omp") ||
          !entry.enabled ||
          !entry.installed
        ) {
          continue;
        }
        next.push({
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
          entry,
        });
      }
    }
    return next;
  }, [environments, primaryEnvironmentId, primaryProviders]);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    requestVersionRef.current += 1;
    loadingRef.current = false;
    setLoading(false);
  }, [targets]);

  useEffect(
    () => () => {
      requestVersionRef.current += 1;
    },
    [],
  );

  const openPicker = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const requestVersion = ++requestVersionRef.current;

    try {
      const results = await Promise.all(
        targets.map(async (target): Promise<NativeSessionTargetLoadResult> => {
          const result = await loadNativeSessions({
            environmentId: target.environmentId,
            input: { providerInstanceId: target.entry.instanceId },
          });
          if (result._tag === "Success") return { target, sessions: result.value.sessions };
          return {
            target,
            ...(!isAtomCommandInterrupted(result)
              ? { error: errorMessage(squashAtomCommandFailure(result)) }
              : {}),
          };
        }),
      );
      if (requestVersion !== requestVersionRef.current) return;

      const outcome = resolveNativeSessionLoadOutcome(results);
      if (outcome.status !== "success" && outcome.errors.length > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              outcome.status === "failure"
                ? "Could not load native sessions"
                : "Some native sessions could not be loaded",
            description: failureDescription(outcome.errors),
          }),
        );
      }

      const items: CommandPaletteActionItem[] =
        outcome.sessions.length === 0
          ? [
              {
                kind: "action",
                value: `native-session:${outcome.status}`,
                searchTerms: [],
                title:
                  outcome.status === "failure"
                    ? "Could not load Pi or OMP sessions"
                    : "No Pi or OMP sessions found",
                icon: <HistoryIcon className={ITEM_ICON_CLASS} />,
                disabled: true,
                run: async () => {},
              },
            ]
          : outcome.sessions.map(({ target, session }) => {
              const workspaceTitle = inferProjectTitleFromPath(session.cwd);
              return {
                kind: "action",
                value: `native-session:${target.environmentId}:${target.entry.instanceId}:${session.sessionId}`,
                searchTerms: [
                  session.title,
                  session.cwd,
                  workspaceTitle,
                  target.environmentLabel,
                  session.model ?? "",
                  session.status,
                  target.entry.displayName,
                ],
                title: session.title,
                description: [
                  workspaceTitle,
                  target.environmentLabel,
                  target.entry.displayName,
                  session.model,
                  formatRelativeTimeLabel(session.updatedAt),
                ]
                  .filter((part): part is string => part !== undefined)
                  .join(" · "),
                icon: <HistoryIcon className={ITEM_ICON_CLASS} />,
                keepOpen: true,
                run: async () => {
                  const result = await openNativeSession({
                    environmentId: target.environmentId,
                    input: {
                      providerInstanceId: target.entry.instanceId,
                      sessionId: session.sessionId,
                    },
                  });
                  if (result._tag === "Failure") {
                    if (!isAtomCommandInterrupted(result)) {
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: "Could not open native session",
                          description: errorMessage(squashAtomCommandFailure(result)),
                        }),
                      );
                    }
                    return;
                  }
                  const threadRef = scopeThreadRef(target.environmentId, result.value.threadId);
                  // The thread route redirects home while the shell lacks the thread, so
                  // wait for the server's shell event before navigating.
                  if (!(await waitForThreadShell(threadRef, 15_000))) {
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: "Could not open native session",
                        description:
                          "The session was imported, but its thread did not reach this client. Open it from the sidebar.",
                      }),
                    );
                    return;
                  }
                  input.closePalette();
                  await navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(threadRef),
                  });
                },
              };
            });

      input.pushView({
        addonIcon: <HistoryIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: "native-sessions", label: "Native sessions", items }],
      });
    } finally {
      if (requestVersion === requestVersionRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [input, loadNativeSessions, navigate, openNativeSession, targets]);

  if (targets.length === 0) return null;
  return {
    kind: "action",
    value: "action:open-native-session",
    searchTerms: ["open", "resume", "pi", "omp", "oh my pi", "native", "session", "history"],
    title: loading ? "Loading native sessions…" : "Open native session",
    icon: <HistoryIcon className={ITEM_ICON_CLASS} />,
    disabled: loading,
    keepOpen: true,
    run: openPicker,
  };
}
