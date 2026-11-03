import { useEffect, useRef, useState } from "react";
import {
  createStreamingRevealController,
  REVEAL_INTERVAL_MS,
  type StreamingRevealController,
  type StreamingRevealSnapshot,
} from "./streamingReveal.ts";

interface StreamingRevealOptions {
  readonly identity: string;
  readonly streaming: boolean;
  readonly boundaryKey?: string;
  readonly reducedMotion?: boolean;
}

export function useStreamingReveal(target: string, options: StreamingRevealOptions): string {
  const controllerRef = useRef<StreamingRevealController | null>(null);
  const identityRef = useRef<string | null>(null);
  const boundaryRef = useRef(options.boundaryKey);
  const frameRef = useRef<number | null>(null);
  const [state, setState] = useState({
    identity: options.identity,
    boundaryKey: options.boundaryKey,
    snapshot: { text: target, complete: true },
  });
  if (controllerRef.current === null) controllerRef.current = createStreamingRevealController();

  useEffect(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    const identityChanged = identityRef.current !== options.identity;
    const boundaryChanged = boundaryRef.current !== options.boundaryKey;
    identityRef.current = options.identity;
    boundaryRef.current = options.boundaryKey;
    const publish = (snapshot: StreamingRevealSnapshot) =>
      setState((previous) =>
        previous.identity === options.identity &&
        previous.boundaryKey === options.boundaryKey &&
        previous.snapshot.text === snapshot.text &&
        previous.snapshot.complete === snapshot.complete
          ? previous
          : { identity: options.identity, boundaryKey: options.boundaryKey, snapshot },
      );
    if (identityChanged) controller.reset();
    controller.updateTarget(target);
    if (identityChanged || boundaryChanged || options.reducedMotion || !options.streaming) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      publish(controller.complete(target));
      return;
    }
    publish(controller.snapshot);
    // Growing targets update the controller without postponing an already scheduled tick.
    if (frameRef.current !== null || controller.snapshot.complete) return;
    let lastTick = performance.now();
    const tick = (timestamp: number) => {
      frameRef.current = null;
      const elapsed = timestamp - lastTick;
      if (elapsed >= REVEAL_INTERVAL_MS) {
        lastTick = timestamp - (elapsed % REVEAL_INTERVAL_MS);
        const next = controller.tick();
        publish(next);
        if (next.complete) return;
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [options.boundaryKey, options.identity, options.reducedMotion, options.streaming, target]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      controllerRef.current?.cancel();
    },
    [],
  );

  return state.identity !== options.identity ||
    state.boundaryKey !== options.boundaryKey ||
    !options.streaming ||
    options.reducedMotion
    ? target
    : state.snapshot.text;
}
