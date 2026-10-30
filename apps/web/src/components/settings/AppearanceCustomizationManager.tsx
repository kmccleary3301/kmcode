import type {
  AppearanceCommand,
  AppearancePersistedState,
  AppearanceSnapshot,
  AppearanceSnippet,
  AppearanceStoredPackage,
} from "@t3tools/client-runtime/appearance";
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { APP_VERSION } from "../../branding";
import {
  allocateAppearanceGeneration,
  executeAppearanceRecoveryCommand,
  finishAppearanceIntent,
  getAppearanceRecoveryInventory,
  getAppearanceRuntime,
  getQuarantinedAppearanceState,
  restoreQuarantinedAppearanceState,
} from "../../appearanceRuntime";
import {
  getAppearanceFontLoadDiagnostics,
  subscribeAppearanceFontLoadDiagnostics,
} from "../../appearanceFonts";
import {
  parseAppearanceSnippetBundle,
  serializeAppearanceSnippetBundle,
  serializeBrowserAppearancePackage,
} from "../../browserAppearancePackages";
import { Button } from "../ui/button";

export function importedAppearanceSnippets(
  snippets: ReadonlyArray<AppearanceSnippet>,
): ReadonlyArray<AppearanceSnippet> {
  return snippets.map((snippet) => ({ ...snippet, enabled: false }));
}

function download(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.download = name;
  anchor.href = url;
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

const APPEARANCE_PREVIEW_MODES = ["full-app", "theme-alone", "light", "dark"] as const;
export type AppearancePreviewMode = (typeof APPEARANCE_PREVIEW_MODES)[number];

export function previewCommandForPackage(
  value: Pick<AppearanceStoredPackage, "profile">,
  mode: AppearancePreviewMode,
): AppearanceCommand {
  const variantId =
    mode === "light" || mode === "dark"
      ? value.profile.variants.find((variant) => variant.appearance === mode)?.id
      : undefined;
  return {
    type: "preview",
    preview: {
      packageId: value.profile.metadata.id,
      ...(variantId === undefined ? {} : { variantId }),
      ...(mode === "theme-alone" ? { includeSnippets: false } : {}),
    },
  };
}

export interface AppearancePackageMetadataSummary {
  readonly source: string;
  readonly compatibility: string;
  readonly activeVariant: string;
  readonly assets: string;
  readonly diagnostics: string;
}

export function appearancePackageMetadata(
  value: AppearanceStoredPackage,
  snapshot: Pick<AppearanceSnapshot, "diagnostics" | "resolved">,
  currentAppVersion = APP_VERSION,
): AppearancePackageMetadataSummary {
  const diagnostics = [
    ...value.diagnostics,
    ...snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.file?.includes(value.profile.metadata.id) === true,
    ),
  ];
  const activeVariant =
    snapshot.resolved.basePackageId === value.profile.metadata.id
      ? (snapshot.resolved.baseVariant ?? snapshot.resolved.variant)
      : null;
  const compatibilityBounds = [
    value.profile.compatibility.minimumAppVersion === undefined
      ? "minimum: any"
      : `minimum: ${value.profile.compatibility.minimumAppVersion}`,
    value.profile.compatibility.maximumAppVersion === undefined
      ? "maximum: any"
      : `maximum: ${value.profile.compatibility.maximumAppVersion}`,
    `current app: ${currentAppVersion}`,
  ];
  return {
    source: value.profile.metadata.homepage
      ? `local package · ${value.profile.metadata.homepage}`
      : value.profile.trust.class,
    compatibility: [
      value.profile.compatibility.platforms.length === 0
        ? "all platforms"
        : value.profile.compatibility.platforms.join(", "),
      ...compatibilityBounds,
    ].join(" · "),
    activeVariant:
      activeVariant === null
        ? "not active"
        : `${activeVariant.label} (${activeVariant.appearance})`,
    assets: `${value.assets.length} asset${value.assets.length === 1 ? "" : "s"}`,
    diagnostics:
      diagnostics.length === 0
        ? "Last good"
        : `${diagnostics.length} error${diagnostics.length === 1 ? "" : "s"}`,
  };
}

export function compatibilitySummary(
  compatibility: AppearanceSnapshot["packages"][string]["profile"]["compatibility"],
  currentAppVersion = APP_VERSION,
): string {
  const bounds = [
    compatibility.minimumAppVersion === undefined
      ? "minimum: any"
      : `minimum: ${compatibility.minimumAppVersion}`,
    compatibility.maximumAppVersion === undefined
      ? "maximum: any"
      : `maximum: ${compatibility.maximumAppVersion}`,
    `current app: ${currentAppVersion}`,
  ];
  return [
    compatibility.platforms.length === 0 ? "all platforms" : compatibility.platforms.join(", "),
    ...bounds,
  ].join(" · ");
}

export function snippetStatus(
  diagnostics: ReadonlyArray<{ readonly file?: string; readonly message: string }>,
  id: string,
): "Last good" | "Error" {
  return diagnostics.some((diagnostic) => diagnostic.file?.includes(id) === true)
    ? "Error"
    : "Last good";
}

export function AppearanceCustomizationManager() {
  const [snapshot, setSnapshot] = useState<AppearanceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const snippetInputRef = useRef<HTMLInputElement>(null);
  const skipNextRuntimeUpdateRef = useRef(false);
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null);
  const [snippetId, setSnippetId] = useState("");

  const fontDiagnostics = useSyncExternalStore(
    subscribeAppearanceFontLoadDiagnostics,
    getAppearanceFontLoadDiagnostics,
    getAppearanceFontLoadDiagnostics,
  );
  const [snippetCss, setSnippetCss] = useState("");
  const [snippetAdvanced, setSnippetAdvanced] = useState(false);
  const [quarantined, setQuarantined] = useState<AppearancePersistedState | null>(null);
  const [previewMode, setPreviewMode] = useState<AppearancePreviewMode>("full-app");

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let scheduledUpdate: number | undefined;
    void getAppearanceRuntime().then(
      async (runtime) => {
        if (!active) return;
        setSnapshot(runtime.getSnapshot());
        unsubscribe = runtime.subscribe(() => {
          if (scheduledUpdate !== undefined) return;
          if (skipNextRuntimeUpdateRef.current) {
            skipNextRuntimeUpdateRef.current = false;
            return;
          }
          scheduledUpdate = requestAnimationFrame(() => {
            scheduledUpdate = undefined;
            startTransition(() => setSnapshot(runtime.getSnapshot()));
          });
        });
        if (runtime.getSnapshot().safeMode) {
          const [durable, recovery] = await Promise.all([
            getAppearanceRecoveryInventory(),
            getQuarantinedAppearanceState(),
          ]);
          if (!active) return;
          const safeSnapshot = runtime.getSnapshot();
          if (durable !== null) {
            setSnapshot({
              ...durable,
              safeMode: true,
              preview: null,
              resolved: safeSnapshot.resolved,
            });
          }
          setQuarantined(recovery);
        }
      },
      (cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
      unsubscribe?.();
      if (scheduledUpdate !== undefined) cancelAnimationFrame(scheduledUpdate);
    };
  }, []);

  const execute = useCallback(
    async (command: AppearanceCommand): Promise<boolean> => {
      const generation =
        command.generation ??
        allocateAppearanceGeneration(
          command.type === "preference" ? command.preference : undefined,
        );
      setError(null);
      try {
        if (
          snapshot?.safeMode === true &&
          (command.type === "disable" ||
            command.type === "delete" ||
            command.type === "snippet-delete" ||
            (command.type === "snippet-enable" && command.enabled === false))
        ) {
          const recovered = await executeAppearanceRecoveryCommand(
            command.type === "snippet-enable"
              ? { type: "snippet-toggle", id: command.id, enabled: false }
              : command,
          );
          setSnapshot({
            ...recovered,
            safeMode: true,
            preview: null,
            resolved: snapshot.resolved,
          });
          return true;
        }
        const runtime = await getAppearanceRuntime();
        if (command.type === "preview") skipNextRuntimeUpdateRef.current = true;
        const result = await runtime
          .execute({
            ...command,
            generation,
          })
          .finally(() => {
            skipNextRuntimeUpdateRef.current = false;
          });
        if (result.status === "rejected") {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join(" — "));
        } else if (result.status === "cancelled") {
          setError("Appearance change was cancelled.");
        }
        return result.status === "applied";
      } catch (cause) {
        skipNextRuntimeUpdateRef.current = false;
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        finishAppearanceIntent(generation);
      }
    },
    [snapshot],
  );
  const disableAll = useCallback(async () => {
    const generation = allocateAppearanceGeneration();
    setError(null);
    try {
      if (snapshot?.safeMode === true) {
        let latest: AppearancePersistedState = snapshot;
        for (const id of latest.order) {
          if (latest.packages[id]?.enabled !== true) continue;
          latest = await executeAppearanceRecoveryCommand({ type: "disable", id });
        }
        for (const snippet of latest.snippets) {
          if (!snippet.enabled) continue;
          latest = await executeAppearanceRecoveryCommand({
            type: "snippet-toggle",
            id: snippet.id,
            enabled: false,
          });
        }
        setSnapshot({
          ...latest,
          safeMode: true,
          preview: null,
          resolved: snapshot.resolved,
        });
        return;
      }
      const runtime = await getAppearanceRuntime();
      let latest = runtime.getSnapshot();
      for (const id of latest.order) {
        if (latest.packages[id]?.enabled !== true) continue;
        const result = await runtime.execute({ type: "disable", id, generation });
        if (result.status === "cancelled") {
          return;
        }
        if (result.status !== "applied") {
          setError("Could not disable every appearance package.");
          return;
        }
        latest = result.snapshot;
      }
      for (const snippet of latest.snippets) {
        if (!snippet.enabled) continue;
        const result = await runtime.execute({
          type: "snippet-enable",
          id: snippet.id,
          enabled: false,
          generation,
        });
        if (result.status === "cancelled") {
          return;
        }
        if (result.status !== "applied") {
          setError("Could not disable every CSS snippet.");
          return;
        }
        latest = result.snapshot;
      }
      setSnapshot(latest);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [snapshot]);

  if (snapshot === null) return null;
  const packageIds = snapshot.order.filter((id) => snapshot.packages[id] !== undefined);

  return (
    <section
      className="space-y-4 border-t pt-5"
      aria-label="Appearance customizations"
      data-t3-surface="recovery"
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="mr-auto">
          <h3 className="text-sm font-semibold">Theme packages</h3>
          <p className="text-xs text-muted-foreground">
            Imported packages remain disabled until you activate them. Re-import the same package to
            reload or replace its files without changing its enabled state.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => execute({ type: "refresh" })}>
          Reload appearance
        </Button>
        <Button size="sm" variant="outline" onClick={() => void disableAll()}>
          Disable all
        </Button>
        {window.desktopBridge === undefined ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void window.desktopBridge?.revealAppearanceFolder()}
          >
            Open appearance folder
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <label className="text-xs font-medium" htmlFor="appearance-preview-mode">
          Preview mode
        </label>
        <select
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
          id="appearance-preview-mode"
          value={previewMode}
          onChange={(event) => setPreviewMode(event.currentTarget.value as AppearancePreviewMode)}
        >
          <option value="full-app">Full app</option>
          <option value="theme-alone">Theme alone</option>

          <option value="light">Light variant</option>
          <option value="dark">Dark variant</option>
        </select>
        <span className="text-xs text-muted-foreground">
          Preview never installs or activates a package. Full-app and light/dark previews retain
          enabled snippets; theme-alone preview isolates the package.
        </span>
      </div>
      {packageIds.length === 0 ? (
        <p className="text-sm text-muted-foreground">No appearance packages installed.</p>
      ) : (
        <ul className="space-y-2">
          {packageIds.map((id, index) => {
            const value = snapshot.packages[id];
            if (value === undefined) return null;
            const metadata = appearancePackageMetadata(value, snapshot);
            const packageDiagnostics = [
              ...value.diagnostics,
              ...snapshot.diagnostics.filter(
                (diagnostic) => diagnostic.file?.includes(id) === true,
              ),
            ];
            return (
              <li
                className="flex flex-wrap items-center gap-2 rounded-lg border p-3 [contain-intrinsic-block-size:96px] [content-visibility:auto]"
                key={id}
              >
                <div className="min-w-48 flex-1">
                  <div className="text-sm font-medium">{value.profile.metadata.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Package version: {value.profile.metadata.version} ·{" "}
                    {value.profile.capabilities.join(", ") || "portable tokens"}
                  </div>
                </div>
                <details className="order-last basis-full text-xs">
                  <summary className="cursor-pointer font-medium">
                    Package details and source
                  </summary>
                  <dl className="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
                    <div>
                      <dt className="inline font-medium text-foreground">Author: </dt>
                      <dd className="inline">{value.profile.metadata.author ?? "Not declared"}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Source: </dt>
                      <dd className="inline">{metadata.source}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Compatibility: </dt>
                      <dd className="inline">{metadata.compatibility}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Capabilities: </dt>
                      <dd className="inline">
                        {value.profile.capabilities.join(", ") || "portable tokens"}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Trust: </dt>
                      <dd className="inline">{value.profile.trust.class}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Active variant: </dt>
                      <dd className="inline">{metadata.activeVariant}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Assets: </dt>
                      <dd className="inline">{metadata.assets}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Diagnostics: </dt>
                      <dd className="inline">{metadata.diagnostics}</dd>
                    </div>
                  </dl>
                  {value.sharedCss === undefined ? null : (
                    <div className="mt-2">
                      <p className="font-medium">Shared CSS source</p>
                      <pre className="max-h-40 overflow-auto rounded bg-muted p-2">
                        {value.sharedCss}
                      </pre>
                    </div>
                  )}
                  {value.desktopCss === undefined ? null : (
                    <div className="mt-2">
                      <p className="font-medium">Desktop CSS source</p>
                      <pre className="max-h-40 overflow-auto rounded bg-muted p-2">
                        {value.desktopCss}
                      </pre>
                    </div>
                  )}
                  {packageDiagnostics.map((diagnostic) => (
                    <p
                      className="mt-2 text-destructive"
                      key={`${diagnostic.code}:${diagnostic.file ?? ""}:${diagnostic.line ?? ""}:${diagnostic.column ?? ""}:${diagnostic.message}`}
                    >
                      {diagnostic.file ?? "package"}
                      {diagnostic.line === undefined ? "" : `:${diagnostic.line}`}
                      {diagnostic.column === undefined ? "" : `:${diagnostic.column}`} —{" "}
                      {diagnostic.message} {diagnostic.recovery}
                    </p>
                  ))}
                  {packageDiagnostics.length === 0 ? (
                    <p className="mt-2 text-muted-foreground">Last good package state.</p>
                  ) : null}
                </details>
                {value.sharedCss === undefined && value.desktopCss === undefined ? null : (
                  <p className="order-last basis-full text-xs text-warning-foreground">
                    Activation warning: package CSS can restyle ordinary app controls and motion.
                  </p>
                )}
                <Button
                  size="sm"
                  disabled={snapshot.safeMode}
                  variant="outline"
                  onClick={() => execute(previewCommandForPackage(value, previewMode))}
                >
                  Preview
                </Button>
                <Button
                  size="sm"
                  disabled={snapshot.safeMode}
                  variant="outline"
                  onClick={() => execute({ type: "preview", preview: null })}
                >
                  End preview
                </Button>
                <Button
                  size="sm"
                  disabled={snapshot.safeMode && !value.enabled}
                  variant="outline"
                  onClick={() => execute({ type: value.enabled ? "disable" : "enable", id })}
                >
                  {value.enabled ? "Disable" : "Activate"}
                </Button>
                <Button
                  aria-label={`Move ${value.profile.metadata.name} up`}
                  disabled={snapshot.safeMode || index === 0}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const order = [...packageIds];
                    [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
                    void execute({ type: "reorder", order });
                  }}
                >
                  Up
                </Button>
                <Button
                  aria-label={`Move ${value.profile.metadata.name} down`}
                  disabled={snapshot.safeMode || index === packageIds.length - 1}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const order = [...packageIds];
                    [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
                    void execute({ type: "reorder", order });
                  }}
                >
                  Down
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (window.desktopBridge !== undefined) {
                      void window.desktopBridge.exportAppearancePackage({ id });
                    } else {
                      download(`${id}.t3appearance.json`, serializeBrowserAppearancePackage(value));
                    }
                  }}
                >
                  Export
                </Button>
                <Button size="sm" variant="outline" onClick={() => execute({ type: "delete", id })}>
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold">CSS snippets</h3>
        <input
          accept=".json,.t3snippets.json"
          className="hidden"
          ref={snippetInputRef}
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file === undefined) return;
            if (file.size > 4 * 1024 * 1024) {
              setError("Snippet bundle exceeds the 4 MiB import limit.");
              return;
            }
            void file
              .text()
              .then(parseAppearanceSnippetBundle)
              .then((snippets) =>
                execute({ type: "snippets", snippets: importedAppearanceSnippets(snippets) }),
              )
              .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
          }}
        />
        <Button size="sm" variant="outline" onClick={() => snippetInputRef.current?.click()}>
          Import snippets
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            download(
              "appearance-snippets.t3snippets.json",
              serializeAppearanceSnippetBundle(snapshot.snippets),
            )
          }
        >
          Export snippets
        </Button>
      </div>
      <div className="grid gap-2 rounded-lg border p-3">
        <label className="grid gap-1 text-xs font-medium" htmlFor="appearance-snippet-id">
          Stable snippet ID
          <input
            className="rounded-md border bg-background px-2 py-1.5 font-mono"
            disabled={editingSnippetId !== null}
            id="appearance-snippet-id"
            maxLength={128}
            value={snippetId}
            onChange={(event) => setSnippetId(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs font-medium" htmlFor="appearance-snippet-css">
          CSS
          <textarea
            className="min-h-28 rounded-md border bg-background p-2 font-mono"
            id="appearance-snippet-css"
            value={snippetCss}
            onChange={(event) => setSnippetCss(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            checked={snippetAdvanced}
            type="checkbox"
            onChange={(event) => setSnippetAdvanced(event.target.checked)}
          />
          Advanced snippet. May override ordinary controls and motion until safe mode bypasses it.
        </label>
        <div className="flex justify-end gap-2">
          {editingSnippetId === null ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingSnippetId(null);
                setSnippetId("");
                setSnippetCss("");
                setSnippetAdvanced(false);
              }}
            >
              Cancel edit
            </Button>
          )}
          <Button
            disabled={snippetId.trim().length === 0 || snippetCss.trim().length === 0}
            size="sm"
            onClick={() => {
              const id = snippetId.trim();
              if (id.length === 0) return;
              void execute({
                type: "snippet-upsert",
                snippet: {
                  id,
                  css: snippetCss,
                  enabled: snapshot.snippets.find((snippet) => snippet.id === id)?.enabled ?? false,
                  advanced: snippetAdvanced,
                },
              }).then((applied) => {
                if (!applied) return;
                setEditingSnippetId(null);
                setSnippetId("");
                setSnippetCss("");
                setSnippetAdvanced(false);
              });
            }}
          >
            {editingSnippetId === null ? "Add disabled snippet" : "Save snippet"}
          </Button>
        </div>
      </div>
      {snapshot.snippets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No CSS snippets installed.</p>
      ) : (
        <ul className="space-y-2">
          {snapshot.snippets.map((snippet, index) => (
            <li
              className="flex flex-wrap items-center gap-2 rounded-lg border p-3 [contain-intrinsic-block-size:96px] [content-visibility:auto]"
              key={snippet.id}
            >
              <code className="min-w-40 flex-1 text-xs">{snippet.id}</code>
              {snapshot.diagnostics
                .filter((diagnostic) => diagnostic.file?.includes(snippet.id) === true)
                .map((diagnostic) => (
                  <span
                    className="order-last basis-full text-xs text-destructive"
                    key={`${diagnostic.code}:${diagnostic.file ?? ""}:${diagnostic.line ?? ""}:${diagnostic.column ?? ""}:${diagnostic.message}`}
                  >
                    {diagnostic.file}
                    {diagnostic.line === undefined ? "" : `:${diagnostic.line}`}
                    {diagnostic.column === undefined ? "" : `:${diagnostic.column}`} —{" "}
                    {diagnostic.message} {diagnostic.recovery}
                  </span>
                ))}
              <Button
                size="sm"
                disabled={snapshot.safeMode}
                variant="outline"
                onClick={() => {
                  setEditingSnippetId(snippet.id);
                  setSnippetId(snippet.id);
                  setSnippetCss(snippet.css);
                  setSnippetAdvanced(snippet.advanced);
                }}
              >
                Edit
              </Button>
              <Button
                size="sm"
                disabled={snapshot.safeMode && !snippet.enabled}
                variant="outline"
                onClick={() =>
                  execute({ type: "snippet-enable", id: snippet.id, enabled: !snippet.enabled })
                }
              >
                {snippet.enabled ? "Disable" : "Enable"}
              </Button>
              <Button
                aria-label={`Move ${snippet.id} up`}
                disabled={snapshot.safeMode || index === 0}
                size="sm"
                variant="outline"
                onClick={() => {
                  const order = snapshot.snippets.map((value) => value.id);
                  [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
                  void execute({ type: "snippet-reorder", order });
                }}
              >
                Up
              </Button>
              <Button
                aria-label={`Move ${snippet.id} down`}
                disabled={snapshot.safeMode || index === snapshot.snippets.length - 1}
                size="sm"
                variant="outline"
                onClick={() => {
                  const order = snapshot.snippets.map((value) => value.id);
                  [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
                  void execute({ type: "snippet-reorder", order });
                }}
              >
                Down
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => execute({ type: "snippet-delete", id: snippet.id })}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      {quarantined === null ? null : (
        <div className="rounded-lg border p-3 text-sm">
          <p>
            Recovery copy: {Object.keys(quarantined.packages).length} packages and{" "}
            {quarantined.snippets.length} snippets.
          </p>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                download("appearance-recovery.json", `${JSON.stringify(quarantined)}\n`)
              }
            >
              Export recovery copy
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!window.confirm("Restore the quarantined appearance state?")) return;
                void restoreQuarantinedAppearanceState().then(
                  () => {
                    const url = new URL(window.location.href);
                    url.searchParams.delete("t3-appearance");
                    window.location.replace(url);
                  },
                  (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
                );
              }}
            >
              Restore recovery copy
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (
              window.confirm(
                "Reset all appearance packages, snippets, and preferences? A recovery copy will be kept.",
              )
            ) {
              void execute({ type: "reset" });
            }
          }}
        >
          Reset all appearance customizations
        </Button>
      </div>
      {fontDiagnostics.length === 0 ? null : (
        <div className="rounded-lg border border-warning/50 p-3 text-sm" role="status">
          <p className="font-medium">Package font fallback active</p>
          {fontDiagnostics.map((diagnostic) => (
            <p
              className="mt-1 text-muted-foreground"
              key={`${diagnostic.code}-${diagnostic.family}`}
            >
              {diagnostic.family}: {diagnostic.message} {diagnostic.recovery}
            </p>
          ))}
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() => execute({ type: "refresh" })}
          >
            Retry package fonts
          </Button>
        </div>
      )}
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
