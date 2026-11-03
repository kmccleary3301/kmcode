import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { serverEnvironment } from "../state/server";
import { useEnvironments } from "../state/environments";

export function HostHealthSubscriptionKeeper() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) =>
        environment.entry.enabled ? (
          <EnvironmentHostHealthSubscription
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ) : null,
      )}
    </>
  );
}

function EnvironmentHostHealthSubscription(props: { readonly environmentId: EnvironmentId }) {
  useAtomValue(serverEnvironment.hostHealth({ environmentId: props.environmentId, input: {} }));
  useAtomValue(serverEnvironment.hostHealthLatest(props.environmentId));
  return null;
}
