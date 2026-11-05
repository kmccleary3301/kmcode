import {
  AuthSettingsWriteScope,
  type ApertureSettings as ApertureSettingsValues,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";

type ApertureDraft = Pick<
  ApertureSettingsValues,
  "enabled" | "apiUrl" | "webUrl" | "defaultEntity" | "defaultProject"
>;

type Feedback =
  | { readonly kind: "success"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

function apertureConnectionFailureMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ApertureConnectionError" &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return `Aperture connection failed (${error.code}): ${error.message}`;
  }
  return error instanceof Error ? error.message : "Aperture connection failed.";
}

export function ApertureSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.aperture);
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Aperture settings",
    reportFailure: false,
  });
  const testConnection = useAtomCommand(serverEnvironment.testApertureConnection, {
    label: "test Aperture connection",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<Partial<ApertureDraft>>({});
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [busy, setBusy] = useState<"saving" | "testing" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const nextSettings: ApertureSettingsValues = {
    enabled: draft.enabled ?? saved.enabled,
    apiUrl: (draft.apiUrl ?? saved.apiUrl).trim(),
    webUrl: (draft.webUrl ?? saved.webUrl).trim(),
    defaultEntity: (draft.defaultEntity ?? saved.defaultEntity).trim(),
    defaultProject: (draft.defaultProject ?? saved.defaultProject).trim(),
    apiKey: apiKeyDraft.trim() || saved.apiKey,
  };
  const hasChanges =
    nextSettings.enabled !== saved.enabled ||
    nextSettings.apiUrl !== saved.apiUrl ||
    nextSettings.webUrl !== saved.webUrl ||
    nextSettings.defaultEntity !== saved.defaultEntity ||
    nextSettings.defaultProject !== saved.defaultProject ||
    apiKeyDraft.trim() !== "";
  const isSavedApiKey = saved.apiKey.length > 0;

  const persist = async (settings: ApertureSettingsValues): Promise<boolean> => {
    const result = await updateSettings({
      environmentId,
      input: { patch: { aperture: settings } },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not save Aperture settings.",
      });
      return false;
    }
    setDraft({});
    setApiKeyDraft("");
    return true;
  };

  const save = async (settings: ApertureSettingsValues) => {
    setBusy("saving");
    setFeedback(null);
    try {
      await persist(settings);
    } finally {
      setBusy(null);
    }
  };

  const checkConnection = async () => {
    setBusy("testing");
    setFeedback(null);
    try {
      if (!(await persist(nextSettings))) return;
      const result = await testConnection({ environmentId, input: {} });
      if (result._tag === "Failure") {
        setFeedback({
          kind: "error",
          message: apertureConnectionFailureMessage(squashAtomCommandFailure(result)),
        });
        return;
      }
      const { viewer, projects } = result.value;
      const identity = viewer.name ?? viewer.email ?? viewer.id;
      const email = viewer.email && viewer.name ? ` (${viewer.email})` : "";
      const projectSummary =
        projects.length === 1 ? "1 project available." : `${projects.length} projects available.`;
      setFeedback({
        kind: "success",
        message: `Connected to Aperture as ${identity}${email}. ${projectSummary}`,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      className="grid gap-4 px-3 py-3 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges && canConfigure && busy === null) void save(nextSettings);
      }}
    >
      <fieldset disabled={!canConfigure || busy !== null} className="contents">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`aperture-enabled-${environmentId}`}>Enable Aperture</Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Connect this server environment to your Aperture instance.
            </p>
          </div>
          <Switch
            id={`aperture-enabled-${environmentId}`}
            checked={nextSettings.enabled}
            onCheckedChange={(enabled) => {
              setDraft((current) => ({ ...current, enabled: Boolean(enabled) }));
              setFeedback(null);
            }}
            aria-label="Enable Aperture"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`aperture-api-url-${environmentId}`}>API URL</Label>
            <Input
              id={`aperture-api-url-${environmentId}`}
              type="url"
              autoComplete="url"
              size="sm"
              placeholder="https://api.aperture.example"
              value={draft.apiUrl ?? saved.apiUrl}
              onChange={(event) => {
                setDraft((current) => ({ ...current, apiUrl: event.target.value }));
                setFeedback(null);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`aperture-web-url-${environmentId}`}>Web URL</Label>
            <Input
              id={`aperture-web-url-${environmentId}`}
              type="url"
              autoComplete="url"
              size="sm"
              placeholder="https://aperture.example"
              value={draft.webUrl ?? saved.webUrl}
              onChange={(event) => {
                setDraft((current) => ({ ...current, webUrl: event.target.value }));
                setFeedback(null);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`aperture-default-entity-${environmentId}`}>Default entity</Label>
            <Input
              id={`aperture-default-entity-${environmentId}`}
              autoComplete="off"
              size="sm"
              placeholder="Entity name or ID"
              value={draft.defaultEntity ?? saved.defaultEntity}
              onChange={(event) => {
                setDraft((current) => ({ ...current, defaultEntity: event.target.value }));
                setFeedback(null);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`aperture-default-project-${environmentId}`}>Default project</Label>
            <Input
              id={`aperture-default-project-${environmentId}`}
              autoComplete="off"
              size="sm"
              placeholder="Project name or ID"
              value={draft.defaultProject ?? saved.defaultProject}
              onChange={(event) => {
                setDraft((current) => ({ ...current, defaultProject: event.target.value }));
                setFeedback(null);
              }}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`aperture-api-key-${environmentId}`}>API key</Label>
          <Input
            id={`aperture-api-key-${environmentId}`}
            type="password"
            autoComplete="off"
            size="sm"
            placeholder={isSavedApiKey ? "Stored secret, enter a new value to replace" : "Not set"}
            value={apiKeyDraft}
            onChange={(event) => {
              setApiKeyDraft(event.target.value);
              setFeedback(null);
            }}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            The saved key is write-only and is never shown here.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {feedback ? (
            <p
              className={
                feedback.kind === "error"
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
              role={feedback.kind === "error" ? "alert" : "status"}
            >
              {feedback.message}
            </p>
          ) : busy === "testing" ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <Spinner size="xs" /> Connecting to Aperture…
            </p>
          ) : (
            <span />
          )}
          <div className="flex shrink-0 gap-2">
            {isSavedApiKey ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void save({ ...nextSettings, apiKey: "" })}
              >
                Remove key
              </Button>
            ) : null}
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canConfigure || busy !== null || nextSettings.apiUrl === ""}
              onClick={() => void checkConnection()}
            >
              {busy === "testing" ? <Spinner size="xs" /> : null} Test connection
            </Button>
            <Button
              type="submit"
              size="xs"
              disabled={!canConfigure || !hasChanges || busy !== null}
            >
              {busy === "saving" ? <Spinner size="xs" /> : null} Save
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
