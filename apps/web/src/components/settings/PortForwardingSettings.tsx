import {
  DEFAULT_PORT_AUTO_FORWARD_LIMIT,
  MAX_PORT_AUTO_FORWARD_LIMIT,
  MIN_PORT_AUTO_FORWARD_LIMIT,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "~/hooks/useSettings";
import { isPortForwardingAvailable } from "~/state/portForwarding";
import { Input } from "../ui/input";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Folded section under the environments list for the desktop app's port
 * forwarding. Auto-forwards already close when their server exits; the limit
 * is the backstop for an environment that keeps many servers alive at once.
 */
export function PortForwardingSettings() {
  const limit = useClientSettings((settings) => settings.portAutoForwardLimit);
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();
  // Draft only while editing, so the field can be emptied mid-edit; the
  // setting moves on valid input and the field shows it again on blur.
  const [draft, setDraft] = useState<string | null>(null);

  if (!isPortForwardingAvailable()) return null;

  const { id, title } = searchableSetting("port-auto-forward-limit");
  return (
    <FoldedSettingsSection
      id={id}
      title="Port forwarding"
      summary={`Up to ${limit} auto-forwarded ports per environment`}
    >
      <SettingsRow
        title={title}
        description="Most ports one environment may auto-forward at once. Auto-forwards close when their server exits, so this only matters when many servers stay up together. Ports you forward yourself don't count."
        resetAction={
          limit !== DEFAULT_PORT_AUTO_FORWARD_LIMIT ? (
            <SettingResetButton
              label="auto-forward limit"
              onClick={() =>
                updateSettings({ portAutoForwardLimit: DEFAULT_PORT_AUTO_FORWARD_LIMIT })
              }
            />
          ) : null
        }
        control={
          <Input
            size="sm"
            type="number"
            min={MIN_PORT_AUTO_FORWARD_LIMIT}
            max={MAX_PORT_AUTO_FORWARD_LIMIT}
            className="w-full sm:w-24"
            disabled={!settingsHydrated}
            value={draft ?? String(limit)}
            onChange={(event) => {
              setDraft(event.target.value);
              // Number(), not parseInt: "2.5" must be rejected rather than
              // committed as 2 while the field still shows 2.5.
              const parsed = Number(event.target.value);
              if (
                Number.isInteger(parsed) &&
                parsed >= MIN_PORT_AUTO_FORWARD_LIMIT &&
                parsed <= MAX_PORT_AUTO_FORWARD_LIMIT
              ) {
                updateSettings({ portAutoForwardLimit: parsed });
              }
            }}
            onBlur={() => setDraft(null)}
            aria-label="Auto-forward limit"
          />
        }
      />
    </FoldedSettingsSection>
  );
}
