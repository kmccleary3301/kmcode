import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    const resumes = yield* Queue.sliding<void>(1);

    yield* powerMonitor.onSimpleEvent("resume", () => {
      Queue.offerUnsafe(resumes, undefined);
    });

    const dropUnresponsiveTunnels = sshEnvironment.dropUnresponsiveTunnels.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("desktop.ssh.resume.dropUnresponsiveTunnels.failed", { cause }),
      ),
    );
    yield* Effect.forever(Queue.take(resumes).pipe(Effect.andThen(dropUnresponsiveTunnels))).pipe(
      Effect.forkScoped,
      Effect.asVoid,
    );
  }),
);
