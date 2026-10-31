import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/http/Headers";
import * as Tracer from "effect/Tracer";

const REDACTED_QUERY_PARAMETER =
  /(^|[?&])(wsTicket|dpop|token|pairingUrl|code|state|challenge)=[^&#]*/g;

const redactUrlValue = (value: string) => value.replace(REDACTED_QUERY_PARAMETER, "$1$2=REDACTED");

const redactingTracer = (tracer: Tracer.Tracer) =>
  Tracer.make({
    span(options) {
      const span = tracer.span(options);
      return new Proxy(span, {
        get(target, property) {
          if (property === "attribute") {
            return (key: string, value: unknown) =>
              target.attribute(
                key,
                (key === "url.full" || key === "url.query") && typeof value === "string"
                  ? redactUrlValue(value)
                  : value,
              );
          }
          return Reflect.get(target, property, target);
        },
      });
    },
  });

export const layer = Layer.mergeAll(
  Layer.effect(
    Headers.CurrentRedactedNames,
    // `expo-session` carries the `eas login` session secret on Expo API requests.
    Effect.map(Headers.CurrentRedactedNames, (names) => [...names, "dpop", "expo-session"]),
  ),
  // This Effect version exposes redacted-name configuration for headers only.
  Layer.effect(Tracer.Tracer, Effect.map(Tracer.Tracer, redactingTracer)),
);
