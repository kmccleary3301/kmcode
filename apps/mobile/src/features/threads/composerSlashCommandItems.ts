import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import {
  buildProviderSlashArgumentCompletions,
  scoreSlashCommandTextMatch,
  slashCommandFuzzyMatch,
  slashCommandFuzzyScore,
  slashCommandSkillBreakoutTier,
} from "@t3tools/shared/providerSlashCommandCompletion";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandPopover";

type SlashCommandItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "provider-slash-argument" }
>;

const BUILT_IN_COMMANDS = [
  {
    id: "cmd:model",
    type: "slash-command",
    command: "model",
    label: "/model",
    description: "Switch model",
  },
  {
    id: "cmd:plan",
    type: "slash-command",
    command: "plan",
    label: "/plan",
    description: "Switch to plan mode",
  },
  {
    id: "cmd:default",
    type: "slash-command",
    command: "default",
    label: "/default",
    description: "Switch to default mode",
  },
] as const satisfies ReadonlyArray<SlashCommandItem>;

function commandDescription(command: ServerProviderSlashCommand): string {
  if (command.description && command.input?.hint) {
    return `${command.description} · ${command.input.hint}`;
  }
  return command.description ?? command.input?.hint ?? "Run provider command";
}

function isSkillProviderCommand(item: SlashCommandItem): boolean {
  return (
    item.type === "provider-slash-command" &&
    (item.command.source === "skill" || item.command.name.toLowerCase().startsWith("skill:"))
  );
}

function scoreSlashCommandItem(
  item: SlashCommandItem,
  query: string,
): { readonly score: number; readonly matchedName: string } | null {
  const primaryNameValue =
    item.type === "slash-command"
      ? item.command
      : item.type === "provider-slash-command"
        ? item.command.name
        : item.searchValue;
  const primaryName = primaryNameValue.toLowerCase();
  const isSkillCommand = primaryName.startsWith("skill:");
  const nameScore =
    query.length === 0 && isSkillProviderCommand(item)
      ? 950
      : isSkillCommand
        ? Math.max(
            scoreSlashCommandTextMatch(query, primaryName),
            scoreSlashCommandTextMatch(query, primaryName.slice("skill:".length)),
          )
        : scoreSlashCommandTextMatch(query, primaryName);
  const description =
    item.type === "provider-slash-command"
      ? (item.command.matchDescription ?? item.command.description ?? "")
      : item.description;
  let bestScore = Math.max(
    nameScore,
    slashCommandFuzzyMatch(query, description.toLowerCase())
      ? slashCommandFuzzyScore(query, description.toLowerCase()) * 0.5
      : 0,
  );
  let matchedName = primaryNameValue;
  if (item.type === "provider-slash-command") {
    for (const alias of item.command.aliases ?? []) {
      const aliasScore = scoreSlashCommandTextMatch(query, alias.toLowerCase());
      if (aliasScore > bestScore) {
        bestScore = aliasScore;
        matchedName = alias;
      }
    }
  }
  if (bestScore <= 0) return null;
  return { score: bestScore, matchedName };
}

function collapseSkillNamespace(
  items: ReadonlyArray<SlashCommandItem>,
  query: string,
): SlashCommandItem[] {
  if (query.startsWith("skill:")) return [...items];
  const approachesNamespace = "skill:".startsWith(query);
  let commandTier = 0;
  if (!approachesNamespace) {
    for (const item of items) {
      if (item.type !== "provider-slash-command" || isSkillProviderCommand(item)) continue;
      const name = item.command.name.toLowerCase();
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
  let skillProvider: Extract<SlashCommandItem, { type: "provider-slash-command" }> | undefined;
  const rest: SlashCommandItem[] = [];
  for (const item of items) {
    if (item.type !== "provider-slash-command" || !isSkillProviderCommand(item)) {
      rest.push(item);
      continue;
    }
    skillCount += 1;
    skillIcon ??= item.command.icon;
    skillProvider ??= item;
    const lowerName = item.command.name.toLowerCase();
    const bareName = lowerName.startsWith("skill:") ? lowerName.slice("skill:".length) : lowerName;
    if (!approachesNamespace && slashCommandSkillBreakoutTier(query, bareName) > commandTier) {
      rest.push(item);
    }
  }

  if (skillCount === 0 || skillProvider === undefined) return [...items];
  if (!"skill:".startsWith(query)) return rest;

  const description = `${skillCount} skill${skillCount === 1 ? "" : "s"}`;
  rest.push({
    id: "provider-slash-command:skill:",
    type: "provider-slash-command",
    command: {
      name: "skill:",
      description,
      matchDescription: description,
      ...(skillIcon ? { icon: skillIcon } : {}),
      source: "builtin",
      executable: false,
    },
    label: "/skill:",
    description,
  });
  return rest;
}

function searchSlashCommandItems(
  items: ReadonlyArray<SlashCommandItem>,
  query: string,
): SlashCommandItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  const candidateItems = collapseSkillNamespace(items, normalizedQuery);
  const ranked: Array<{
    item: SlashCommandItem;
    score: number;
    index: number;
    matchedName: string;
  }> = [];
  for (const [index, item] of candidateItems.entries()) {
    const match = scoreSlashCommandItem(item, normalizedQuery);
    if (match === null) continue;
    ranked.push({ item, index, ...match });
  }
  ranked.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) return scoreDelta;
    const leftUsage =
      left.item.type === "provider-slash-command" ? (left.item.command.usage ?? 0) : 0;
    const rightUsage =
      right.item.type === "provider-slash-command" ? (right.item.command.usage ?? 0) : 0;
    const usageDelta = rightUsage - leftUsage;
    if (usageDelta !== 0) return usageDelta;
    return left.index - right.index;
  });
  return ranked.map(({ item, matchedName }) => {
    if (item.type !== "provider-slash-command" || matchedName === item.command.name) {
      return item;
    }
    return {
      ...item,
      id: `provider-slash-command:${matchedName}`,
      command: { ...item.command, name: matchedName },
      label: `/${matchedName}`,
    };
  });
}

export function buildMobileSlashCommandItems(input: {
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly query: string;
  readonly includeInteractionModeCommands?: boolean;
  readonly preferProviderCommands?: boolean;
}): SlashCommandItem[] {
  const argumentCompletions = buildProviderSlashArgumentCompletions(input);
  if (argumentCompletions) {
    const items = argumentCompletions.items.map((completion): SlashCommandItem => ({
      id: `provider-slash-argument:${completion.key}`,
      type: "provider-slash-argument",
      command: completion.command,
      insertText: completion.insertText,
      searchValue: completion.searchValue,
      label: completion.label,
      description: completion.description,
    }));
    return searchSlashCommandItems(items, argumentCompletions.searchQuery);
  }

  const builtInCommands =
    input.includeInteractionModeCommands === false
      ? BUILT_IN_COMMANDS.filter((item) => item.command === "model")
      : BUILT_IN_COMMANDS;
  const providerItems: SlashCommandItem[] = input.commands.map((command) => ({
    id: `provider-slash-command:${command.name}`,
    type: "provider-slash-command",
    command,
    label: `/${command.name}`,
    description: commandDescription(command),
  }));
  const mergedItems: SlashCommandItem[] = [];
  const commandNames = new Set<string>();
  const orderedItems = input.preferProviderCommands
    ? [...providerItems, ...builtInCommands]
    : [...builtInCommands, ...providerItems];
  for (const item of orderedItems) {
    const commandName = item.type === "slash-command" ? item.command : item.command.name;
    if (commandNames.has(commandName)) {
      continue;
    }
    commandNames.add(commandName);
    mergedItems.push(item);
  }
  return searchSlashCommandItems(mergedItems, input.query);
}
