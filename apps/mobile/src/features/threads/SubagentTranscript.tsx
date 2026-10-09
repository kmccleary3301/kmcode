import { parseActivityDetail } from "@t3tools/client-runtime/activity-details";
import {
  deriveSubagentTranscriptEntries,
  type DerivedSubagentTranscriptEntry,
} from "@t3tools/client-runtime/subagentTranscript";
import type {
  EnvironmentId,
  OrchestrationV2SubagentTranscriptEntry,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { ToolActivityPresenter } from "./tool-activity-presenter";

export interface SubagentTranscriptProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly subagentId: string;
  readonly live?: boolean;
}

function transcriptEntryLabel(entry: OrchestrationV2SubagentTranscriptEntry): string {
  if (entry.kind === "user") return "Assignment";
  if (entry.kind === "reasoning") return "Reasoning";
  if (entry.kind === "tool") return entry.toolName ?? "Tool";
  if (entry.kind === "system") return "System";
  return "Assistant";
}

function SubagentTranscriptItem({ item }: { readonly item: DerivedSubagentTranscriptEntry }) {
  const detail = useMemo(
    () => (item.activity ? parseActivityDetail(item.activity) : null),
    [item.activity],
  );
  const entry = item.entry;

  if (entry.kind === "tool") {
    return (
      <View className="min-w-0">
        <View className="mb-1 flex-row items-center gap-2">
          <SymbolView
            name={{ ios: "hammer", android: "build" }}
            size={14}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
          <Text
            className={`font-mono text-xs uppercase tracking-wider ${
              entry.isError ? "text-destructive-foreground" : "text-foreground-muted"
            }`}
          >
            {transcriptEntryLabel(entry)}
          </Text>
        </View>
        {detail ? (
          <ToolActivityPresenter detail={detail} />
        ) : (
          <Text selectable className="text-sm leading-5 text-foreground">
            {entry.text}
          </Text>
        )}
      </View>
    );
  }

  return (
    <View className="min-w-0">
      <View className="mb-1 flex-row items-center gap-2">
        <Text
          className={`font-mono text-xs uppercase tracking-wider ${
            entry.isError ? "text-destructive-foreground" : "text-foreground-muted"
          }`}
        >
          {transcriptEntryLabel(entry)}
        </Text>
      </View>
      <Text
        selectable
        className={`text-sm leading-5 ${
          entry.kind === "reasoning" ? "text-foreground-muted" : "text-foreground"
        }`}
      >
        {entry.text}
      </Text>
    </View>
  );
}

export function SubagentTranscript({
  environmentId,
  threadId,
  subagentId,
  live = false,
}: SubagentTranscriptProps) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [transcriptState, setTranscriptState] = useState<{
    readonly entriesById: Record<string, OrchestrationV2SubagentTranscriptEntry>;
    readonly order: ReadonlyArray<string>;
  }>({ entriesById: {}, order: [] });

  const input = useMemo(
    () => ({
      threadId,
      subagentId,
      ...(cursor === undefined ? {} : { cursor }),
    }),
    [cursor, subagentId, threadId],
  );

  const transcript = useEnvironmentQuery(
    orchestrationEnvironment.subagentTranscript({ environmentId, input }),
  );

  useEffect(() => {
    if (transcript.data === null) return;
    const page = transcript.data;
    setTranscriptState((current) => {
      const baseMap = page.reset ? {} : { ...current.entriesById };
      const baseOrder = page.reset ? [] : [...current.order];
      let changed = page.reset && current.order.length > 0;
      for (const entry of page.entries) {
        if (!baseMap[entry.id]) {
          baseMap[entry.id] = entry;
          baseOrder.push(entry.id);
          changed = true;
        }
      }
      return changed ? { entriesById: baseMap, order: baseOrder } : current;
    });
    if (page.nextCursor !== null && page.nextCursor !== cursor) {
      setCursor(page.nextCursor);
    }
  }, [cursor, transcript.data]);

  const entries = useMemo(
    () => transcriptState.order.map((id) => transcriptState.entriesById[id]!),
    [transcriptState],
  );

  const transcriptEntries = useMemo(() => deriveSubagentTranscriptEntries(entries), [entries]);

  if (entries.length === 0 && transcript.isPending) {
    return (
      <View className="items-center px-5 py-10">
        <ActivityIndicator />
        <Text className="mt-3 text-sm text-foreground-muted">Loading transcript…</Text>
      </View>
    );
  }

  if (entries.length === 0 && transcript.error !== null) {
    return (
      <EmptyState
        variant="plain"
        title="Transcript unavailable"
        detail={transcript.error}
        actionLabel="Retry"
        onAction={transcript.refresh}
      />
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title="No transcript yet"
        detail={
          live
            ? "Transcript entries will appear as this child works."
            : "This child did not expose transcript entries."
        }
        actionLabel="Refresh"
        onAction={transcript.refresh}
      />
    );
  }

  return (
    <View className="gap-4 py-2">
      {transcript.error !== null ? (
        <Pressable
          accessibilityRole="button"
          className="rounded-2xl border border-border bg-card px-3 py-2 active:opacity-70"
          onPress={transcript.refresh}
        >
          <Text className="text-sm text-foreground-muted">
            Transcript update failed. Tap to retry.
          </Text>
        </Pressable>
      ) : null}
      {transcriptEntries.map((item) => (
        <SubagentTranscriptItem key={item.entry.id} item={item} />
      ))}
    </View>
  );
}
