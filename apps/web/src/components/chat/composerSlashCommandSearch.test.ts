import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ServerProviderSlashCommand } from "@t3tools/contracts";
import ompCompletionFixture from "../../../../../packages/shared/src/ompSlashCompletionFixture.json";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  buildProviderSlashArgumentItems,
  mergeSlashCommandItems,
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";

type OmpCompletionRow = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly hint?: string;
};

const ompFixtureCatalog = Schema.decodeUnknownSync(Schema.Array(ServerProviderSlashCommand))(
  ompCompletionFixture.catalog,
);
const ompFixtureOutputs = {
  "": ompCompletionFixture[""],
  g: ompCompletionFixture.g,
  go: ompCompletionFixture.go,
  goal: ompCompletionFixture.goal,
  s: ompCompletionFixture.s,
  se: ompCompletionFixture.se,
  set: ompCompletionFixture.set,
  pl: ompCompletionFixture.pl,
  mod: ompCompletionFixture.mod,
  sk: ompCompletionFixture.sk,
  q: ompCompletionFixture.q,
  clip: ompCompletionFixture.clip,
  "goal ": ompCompletionFixture["goal "],
  "goal s": ompCompletionFixture["goal s"],
  zzzz: ompCompletionFixture.zzzz,
} satisfies Record<string, ReadonlyArray<OmpCompletionRow>>;
const ompCompletionQueries = [
  "",
  "g",
  "go",
  "goal",
  "s",
  "se",
  "set",
  "pl",
  "mod",
  "sk",
  "q",
  "clip",
  "goal ",
  "goal s",
  "zzzz",
] as const;

describe("OMP completion parity", () => {
  const provider = ProviderDriverKind.make("omp");
  it("uses the full live runtime catalog source set", () => {
    expect(ompCompletionFixture.catalogSource).toBe("rpc");
    const sourceCounts = new Map<string, number>();
    for (const command of ompFixtureCatalog) {
      sourceCounts.set(
        command.source ?? "unknown",
        (sourceCounts.get(command.source ?? "unknown") ?? 0) + 1,
      );
    }
    expect(Object.fromEntries(sourceCounts)).toEqual({
      builtin: 79,
      extension: 1,
      custom: 2,
      skill: 55,
      file: 13,
    });
  });

  it("matches the real provider's ordered command rows for the corpus", () => {
    const items = ompFixtureCatalog.map(
      (command): Extract<ComposerCommandItem, { type: "provider-slash-command" }> => ({
        id: `provider-slash-command:${provider}:${command.name}`,
        type: "provider-slash-command",
        provider,
        command,
        label: `/${command.name}`,
        description: command.input?.hint
          ? command.description
            ? `${command.input.hint} - ${command.description}`
            : command.input.hint
          : (command.description ?? ""),
      }),
    );

    for (const query of ompCompletionQueries) {
      if (query.includes(" ")) continue;
      const expectedRows = ompFixtureOutputs[query];
      const actual = searchSlashCommandItems(items, query).map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
      }));
      expect(actual, query).toEqual(
        expectedRows.map((row) => ({
          id: `provider-slash-command:${provider}:${row.value}`,
          label: `/${row.label}`,
          description: row.description ?? "",
        })),
      );
    }

    const emptyIds = searchSlashCommandItems(items, "").map((item) => item.id);
    expect(emptyIds[0]).toContain(":skill:");
    expect(emptyIds.findIndex((id) => id.endsWith(":security"))).toBeGreaterThan(0);
  });

  it("matches the real provider's subcommand rows and prefix filtering", () => {
    const commands = ompFixtureCatalog;
    for (const query of ["goal ", "goal s"] as const) {
      const completion = buildProviderSlashArgumentItems({ provider, commands, query });
      expect(
        completion?.items.map((item) => ({
          label: item.label,
          description: item.description,
        })),
      ).toEqual(
        ompFixtureOutputs[query].map((row) => ({
          label: `/goal ${row.label}`,
          description:
            row.description && row.hint
              ? `${row.description} · ${row.hint}`
              : (row.description ?? row.hint ?? ""),
        })),
      );
    }
  });
});

describe("searchSlashCommandItems", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");

  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
      {
        id: "provider-slash-command:claudeAgent:ui",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:claudeAgent:frontend-design",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" | "skill" }>
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:ui",
      "slash:default",
    ]);
  });

  it("keeps app-only matches in their trailing group", () => {
    const items = [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch response model",
      },
      {
        id: "provider-slash-command:claudeAgent:models",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "models", description: "Switch response model" },
        label: "/models",
        description: "Switch response model",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "model").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:models",
      "slash:model",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [
      {
        id: "provider-slash-command:claudeAgent:gh-fix-ci",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "gh-fix-ci" },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:claudeAgent:github",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" | "skill" }>
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:gh-fix-ci",
    ]);
  });

  it("includes skills by name and description", () => {
    const items = [
      {
        id: "skill:claudeAgent:browser",
        type: "skill",
        provider: claudeDriver,
        skill: {
          name: "browser",
          path: "/skills/browser/SKILL.md",
          enabled: true,
          shortDescription: "Open and control the in-app browser",
        },
        label: "/skill:browser",
        description: "Open and control the in-app browser",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "skill" }>>;

    expect(searchSlashCommandItems(items, "browser").map((item) => item.id)).toEqual([
      "skill:claudeAgent:browser",
    ]);
    expect(searchSlashCommandItems(items, "control").map((item) => item.id)).toEqual([
      "skill:claudeAgent:browser",
    ]);
  });

  it("matches skills by display name", () => {
    const items = [
      {
        id: "skill:claudeAgent:ask-matt",
        type: "skill",
        provider: claudeDriver,
        skill: {
          name: "ask-matt",
          displayName: "Ask Matt",
          path: "/skills/ask-matt/SKILL.md",
          enabled: true,
          shortDescription: "Find the right skill or workflow",
        },
        label: "/skill:ask-matt",
        description: "Find the right skill or workflow",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "skill" }>>;

    expect(searchSlashCommandItems(items, "ask matt").map((item) => item.id)).toEqual([
      "skill:claudeAgent:ask-matt",
    ]);
    expect(searchSlashCommandItems(items, "/skill:ask-matt").map((item) => item.id)).toEqual([
      "skill:claudeAgent:ask-matt",
    ]);
  });

  it("matches skills by their rendered prefix", () => {
    const items = [
      {
        id: "skill:claudeAgent:browser",
        type: "skill",
        provider: claudeDriver,
        skill: {
          name: "browser",
          path: "/skills/browser/SKILL.md",
          enabled: true,
        },
        label: "/skill:browser",
        description: "Open and control the in-app browser",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "skill" }>>;

    expect(searchSlashCommandItems(items, "/skill:brow").map((item) => item.id)).toEqual([
      "skill:claudeAgent:browser",
    ]);
    expect(searchSlashCommandItems(items, "/sk").map((item) => item.id)).toEqual([
      "skill:claudeAgent:browser",
    ]);
    expect(searchSlashCommandItems(items, "/ill").map((item) => item.id)).toEqual([
      "skill:claudeAgent:browser",
    ]);
  });

  it("keeps skills alongside commands for an empty slash query", () => {
    const items = [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch model",
      },
      {
        id: "skill:claudeAgent:unslop",
        type: "skill",
        provider: claudeDriver,
        skill: {
          name: "unslop",
          path: "/skills/unslop/SKILL.md",
          enabled: true,
        },
        label: "/skill:unslop",
        description: "Cut AI tells from writing",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "slash-command" | "skill" }>>;

    expect(searchSlashCommandItems(items, "").map((item) => item.id)).toEqual([
      "skill:claudeAgent:unslop",
      "slash:model",
    ]);
  });

  it("hides provider commands from slash completion after the first message line", () => {
    const items = [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch model",
      },
      {
        id: "provider-slash-command:claudeAgent:compact",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "compact" },
        label: "/compact",
        description: "Compact the conversation",
      },
      {
        id: "skill:claudeAgent:unslop",
        type: "skill",
        provider: claudeDriver,
        skill: {
          name: "unslop",
          path: "/skills/unslop/SKILL.md",
          enabled: true,
        },
        label: "/skill:unslop",
        description: "Cut AI tells from writing",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" | "skill" }>
    >;

    expect(slashCommandItemsForPromptPosition(items, false).map((item) => item.id)).toEqual([
      "slash:model",
      "skill:claudeAgent:unslop",
    ]);
    expect(slashCommandItemsForPromptPosition(items, true).map((item) => item.id)).toEqual([
      "slash:model",
      "provider-slash-command:claudeAgent:compact",
      "skill:claudeAgent:unslop",
    ]);
  });

  it("keeps native aliases while removing built-in name collisions", () => {
    const builtIn = [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch response model",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;
    const provider = ["model", "models"].map(
      (name) =>
        ({
          id: `provider-slash-command:omp:${name}`,
          type: "provider-slash-command",
          provider: ProviderDriverKind.make("omp"),
          command: { name },
          label: `/${name}`,
          description: "OMP command",
        }) satisfies Extract<ComposerCommandItem, { type: "provider-slash-command" }>,
    );

    expect(mergeSlashCommandItems(builtIn, provider).map((item) => item.label)).toEqual([
      "/model",
      "/models",
    ]);
  });

  it("completes native subcommands and later arguments", () => {
    const completion = buildProviderSlashArgumentItems({
      provider: ProviderDriverKind.make("omp"),
      commands: [
        {
          name: "goal",
          subcommands: [
            { name: "set", usage: "<objective>" },
            { name: "budget", description: "Adjust token budget", usage: "<N|off>" },
          ],
        },
      ],
      query: "goal bud",
    });
    expect(
      completion
        ? searchSlashCommandItems(completion.items, completion.searchQuery).map(
            (item) => item.label,
          )
        : [],
    ).toEqual(["/goal budget"]);

    expect(
      buildProviderSlashArgumentItems({
        provider: ProviderDriverKind.make("omp"),
        commands: [
          {
            name: "goal",
            subcommands: [{ name: "budget", usage: "<N|off>" }],
          },
        ],
        query: "goal budget o",
      })?.items,
    ).toMatchObject([{ label: "off", insertText: "/goal budget off " }]);
  });
});
