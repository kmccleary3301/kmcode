import type { ProviderDriverKind, ServerProviderSlashCommand } from "@t3tools/contracts";
import {
  buildProviderSlashArgumentCompletions,
  scoreSlashCommandTextMatch,
  slashCommandFuzzyMatch,
  slashCommandFuzzyScore,
  slashCommandSkillBreakoutTier,
} from "@t3tools/shared/providerSlashCommandCompletion";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";

type SlashSearchItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "provider-slash-argument" | "skill" }
>;

function commandNameForItem(item: SlashSearchItem): string {
  if (item.type === "slash-command") return item.command;
  if (item.type === "provider-slash-command") return item.command.name;
  if (item.type === "provider-slash-argument") return item.searchValue;
  return `skill:${item.skill.name}`;
}

function commandAliasesForItem(item: SlashSearchItem): ReadonlyArray<string> {
  return item.type === "provider-slash-command" ? (item.command.aliases ?? []) : [];
}

function staticDescriptionForItem(item: SlashSearchItem): string {
  if (item.type === "provider-slash-command") {
    return item.command.matchDescription ?? item.command.description ?? "";
  }
  return item.description;
}

function isSkillItem(item: SlashSearchItem): boolean {
  if (item.type === "skill") return true;
  return (
    item.type === "provider-slash-command" &&
    (item.command.source === "skill" || item.command.name.startsWith("skill:"))
  );
}

function scoreSlashCommandItem(
  item: SlashSearchItem,
  query: string,
): { readonly score: number; readonly matchedName: string } | null {
  const primaryNameValue = commandNameForItem(item);
  const primaryName = primaryNameValue.toLowerCase();
  const staticDescription = staticDescriptionForItem(item).toLowerCase();
  const isSkillCommand = primaryName.startsWith("skill:");
  const nameScore =
    query.length === 0 && isSkillItem(item)
      ? 950
      : isSkillCommand
        ? Math.max(
            scoreSlashCommandTextMatch(query, primaryName),
            scoreSlashCommandTextMatch(query, primaryName.slice("skill:".length)),
          )
        : scoreSlashCommandTextMatch(query, primaryName);
  let bestScore = Math.max(
    nameScore,
    slashCommandFuzzyMatch(query, staticDescription)
      ? slashCommandFuzzyScore(query, staticDescription) * 0.5
      : 0,
  );
  let matchedName = primaryNameValue;
  if (item.type === "skill") {
    const displayNameScore = scoreSlashCommandTextMatch(
      query,
      formatProviderSkillDisplayName(item.skill).toLowerCase(),
    );
    if (displayNameScore > bestScore) bestScore = displayNameScore;
  }
  for (const alias of commandAliasesForItem(item)) {
    const aliasScore = scoreSlashCommandTextMatch(query, alias.toLowerCase());
    if (aliasScore > bestScore) {
      bestScore = aliasScore;
      matchedName = alias;
    }
  }
  if (bestScore <= 0) return null;
  return { score: bestScore, matchedName };
}

type SlashCommandItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" }
>;

/**
 * A provider expands a slash command only when it opens the whole message;
 * anywhere else it reaches the agent as literal text, so it is not offered
 * there. Built-ins apply locally on selection and skills insert a `$` mention
 * the server dispatches from any position, so both stay available.
 */
export function slashCommandItemsForPromptPosition(
  items: ReadonlyArray<SlashSearchItem>,
  isAtPromptStart: boolean,
): SlashSearchItem[] {
  if (isAtPromptStart) {
    return [...items];
  }
  return items.filter((item) => item.type !== "provider-slash-command");
}
export function mergeSlashCommandItems(
  builtInItems: ReadonlyArray<SlashCommandItem>,
  providerItems: ReadonlyArray<SlashCommandItem>,
): SlashCommandItem[] {
  const providerNames = new Set<string>();
  for (const item of providerItems) {
    providerNames.add(
      (item.type === "slash-command" ? item.command : item.command.name).toLowerCase(),
    );
    if (item.type === "provider-slash-command") {
      for (const alias of item.command.aliases ?? []) {
        providerNames.add(alias.toLowerCase());
      }
    }
  }
  const merged = [...providerItems];
  for (const item of builtInItems) {
    const commandName = (
      item.type === "slash-command" ? item.command : item.command.name
    ).toLowerCase();
    if (!providerNames.has(commandName)) {
      merged.push(item);
    }
  }
  return merged;
}

export function buildProviderSlashArgumentItems(input: {
  readonly provider: ProviderDriverKind;
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly query: string;
}): { readonly items: SlashSearchItem[]; readonly searchQuery: string } | null {
  const completions = buildProviderSlashArgumentCompletions({
    commands: input.commands,
    query: input.query,
  });
  if (!completions) return null;

  return {
    items: completions.items.map((completion): SlashSearchItem => ({
      id: `provider-slash-argument:${input.provider}:${completion.key}`,
      type: "provider-slash-argument",
      provider: input.provider,
      command: completion.command,
      insertText: completion.insertText,
      searchValue: completion.searchValue,
      label: completion.label,
      description: completion.description,
    })),
    searchQuery: completions.searchQuery,
  };
}

function collapseSkillNamespace(
  items: ReadonlyArray<SlashSearchItem>,
  query: string,
): SlashSearchItem[] {
  if (query.startsWith("skill:")) return [...items];
  const approachesNamespace = "skill:".startsWith(query);
  let commandTier = 0;
  if (!approachesNamespace) {
    for (const item of items) {
      if (item.type !== "provider-slash-command") continue;
      const name = item.command.name.toLowerCase();
      if (name.startsWith("skill:")) continue;
      commandTier = Math.max(commandTier, slashCommandSkillBreakoutTier(query, name));
      for (const alias of item.command.aliases ?? []) {
        commandTier = Math.max(
          commandTier,
          slashCommandSkillBreakoutTier(query, alias.toLowerCase()),
        );
      }
      if (commandTier === 1000) break;
    }
  }

  let skillCount = 0;
  let skillIcon: string | undefined;
  let skillProvider: Extract<SlashSearchItem, { type: "provider-slash-command" }> | undefined;
  const rest: SlashSearchItem[] = [];
  for (const item of items) {
    if (
      item.type !== "provider-slash-command" ||
      !item.command.name.toLowerCase().startsWith("skill:")
    ) {
      rest.push(item);
      continue;
    }

    skillCount += 1;
    skillIcon ??= item.command.icon;
    skillProvider ??= item;
    if (
      !approachesNamespace &&
      slashCommandSkillBreakoutTier(query, item.command.name.slice("skill:".length).toLowerCase()) >
        commandTier
    ) {
      rest.push(item);
    }
  }

  if (skillCount === 0 || skillProvider === undefined) return [...items];
  if (!"skill:".startsWith(query)) return rest;

  rest.push({
    id: `provider-slash-command:${skillProvider.provider}:skill:`,
    type: "provider-slash-command",
    provider: skillProvider.provider,
    command: {
      name: "skill:",
      description: `${skillCount} skill${skillCount === 1 ? "" : "s"}`,
      matchDescription: `${skillCount} skill${skillCount === 1 ? "" : "s"}`,
      ...(skillIcon ? { icon: skillIcon } : {}),
      source: "builtin",
      executable: false,
    },
    label: "/skill:",
    description: `${skillCount} skill${skillCount === 1 ? "" : "s"}`,
  });
  return rest;
}

export function searchSlashCommandItems(
  items: ReadonlyArray<SlashSearchItem>,
  query: string,
): SlashSearchItem[] {
  const normalizedQuery = query.trim().replace(/^\/+/, "").toLowerCase();
  const candidateItems = collapseSkillNamespace(items, normalizedQuery);
  const ranked = candidateItems
    .map((item, index) => {
      const match = scoreSlashCommandItem(item, normalizedQuery);
      return match ? { item, index, ...match } : null;
    })
    .filter(
      (
        entry,
      ): entry is {
        item: SlashSearchItem;
        index: number;
        score: number;
        matchedName: string;
      } => entry !== null,
    )
    .sort((left, right) => {
      const scoreDiff = right.score - left.score;
      if (scoreDiff !== 0) return scoreDiff;
      const leftUsage =
        left.item.type === "provider-slash-command" ? (left.item.command.usage ?? 0) : 0;
      const rightUsage =
        right.item.type === "provider-slash-command" ? (right.item.command.usage ?? 0) : 0;
      const usageDiff = rightUsage - leftUsage;
      if (usageDiff !== 0) return usageDiff;
      return left.index - right.index;
    })
    .map(({ item, matchedName }) => {
      if (item.type !== "provider-slash-command" || matchedName === item.command.name) return item;
      return {
        ...item,
        id: `${item.id.slice(0, item.id.lastIndexOf(":") + 1)}${matchedName}`,
        command: { ...item.command, name: matchedName },
        label: `/${matchedName}`,
      };
    });
  return [
    ...ranked.filter((item) => item.type !== "slash-command"),
    ...ranked.filter((item) => item.type === "slash-command"),
  ];
}
