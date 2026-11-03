import * as Console from "effect/Console";
import { Command } from "effect/cli";
import { KM_CODE_ANSI_BANNER } from "./bannerText.ts";

export const bannerCommand = Command.make("banner").pipe(
  Command.withDescription("Display the KM Code hacker mascot banner and runtime details."),
  Command.withHandler(() => Console.log(KM_CODE_ANSI_BANNER)),
);
