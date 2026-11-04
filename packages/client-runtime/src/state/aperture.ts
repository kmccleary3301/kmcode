import {
  WS_METHODS,
  type ApertureFetchInput,
  type ApertureFetchStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStreamGuarded } from "../rpc/client.ts";
import { createEnvironmentCommand } from "./runtime.ts";

export function createApertureEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** One bridged request; input carries the event sink and the abort signal. */
    fetch: createEnvironmentCommand(runtime, {
      label: "aperture.fetch",
      // The command already runs in the target environment, which the RPC stream needs.
      execute: (input: {
        readonly request: ApertureFetchInput;
        readonly onEvent: (event: ApertureFetchStreamEvent) => void;
        readonly signal: AbortSignal;
      }) => {
        if (input.signal.aborted) return Effect.interrupt;
        const consume = Stream.runForEach(
          runStreamGuarded(WS_METHODS.apertureFetch, input.request),
          (event) => Effect.sync(() => input.onEvent(event)),
        );
        const abort = Effect.callback<void>((resume) => {
          const interrupt = () => resume(Effect.interrupt);
          if (input.signal.aborted) {
            interrupt();
            return;
          }
          input.signal.addEventListener("abort", interrupt, { once: true });
          return Effect.sync(() => input.signal.removeEventListener("abort", interrupt));
        });
        return consume.pipe(Effect.raceFirst(abort));
      },
    }),
  };
}
