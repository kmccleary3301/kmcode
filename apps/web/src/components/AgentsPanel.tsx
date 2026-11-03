import { useAtomValue } from "@effect/atom-react";
import {
  deriveSubagentTranscriptEntries,
  type DerivedSubagentTranscriptEntry,
} from "@t3tools/client-runtime/subagentTranscript";
import {
  type EnvironmentId,
  isOrchestrationV2WorkActive,
  type OrchestrationV2SubagentTranscriptEntry,
  type OrchestrationV2TurnItem,
  type ScopedThreadRef,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import { ArrowLeft, Bot, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "./ChatMarkdown";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import { ToolWorkEntryCard, type ToolWorkEntryCardEntry } from "./chat/ToolWorkEntryCard";

export type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;

export interface AgentsPanelProps {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly subagents: ReadonlyArray<SubagentTurnItem>;
}

const STATUS_VISUALS: Record<SubagentTurnItem["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Queued" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function StatusDot({ status }: { readonly status: SubagentTurnItem["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function SubagentElapsed({ item }: { readonly item: SubagentTurnItem }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const live = isOrchestrationV2WorkActive(item.status);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  const elapsedMs = deriveSubagentElapsedMs(
    {
      status: item.status,
      startedAt: item.startedAt === null ? null : DateTime.formatIso(item.startedAt),
      completedAt: item.completedAt === null ? null : DateTime.formatIso(item.completedAt),
    },
    nowMs,
  );

  if (elapsedMs === null) return null;
  return (
    <span className="tabular-nums font-mono text-3xs text-muted-foreground">
      {formatDuration(elapsedMs)}
    </span>
  );
}

function toolCardEntry(item: DerivedSubagentTranscriptEntry): ToolWorkEntryCardEntry {
  const entry = item.entry;
  const toolCallId = item.callEntry?.tool?.callId ?? item.resultEntry?.tool?.callId;
  return {
    id: entry.id,
    createdAt: entry.timestamp,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    label: entry.toolName ?? "Tool",
    ...(entry.toolName === undefined ? {} : { toolTitle: entry.toolName }),
    ...(item.toolData === undefined ? {} : { toolData: item.toolData }),
    detail: entry.text,
    tone: "tool",
    ...(item.callEntry === undefined ? {} : { toolStartedAt: item.callEntry.timestamp }),
    ...(item.resultEntry === undefined ? {} : { toolCompletedAt: item.resultEntry.timestamp }),
  };
}

function TranscriptEntry({
  item,
  threadRef,
}: {
  readonly item: DerivedSubagentTranscriptEntry;
  readonly threadRef: ScopedThreadRef;
}) {
  const entry = item.entry;

  if (entry.kind === "tool") {
    return (
      <ToolWorkEntryCard
        entry={toolCardEntry(item)}
        icon={<Wrench className="icon size-4 shrink-0" aria-hidden />}
      />
    );
  }

  if (entry.kind === "reasoning") {
    return (
      <article className="min-w-0 rounded-md border border-border/40 bg-muted/10 p-2 text-xs text-muted-foreground">
        <div className="mb-1 font-mono text-3xs uppercase tracking-wide">Reasoning</div>
        <div className="whitespace-pre-wrap break-words">{entry.text}</div>
      </article>
    );
  }

  return (
    <article className="min-w-0">
      <div
        className={cn(
          "mb-1 flex items-center gap-1.5 font-mono text-3xs uppercase tracking-wide text-muted-foreground",
          entry.isError && "text-destructive",
        )}
      >
        {entry.kind === "user" ? "Assignment" : entry.kind === "system" ? "System" : "Assistant"}
      </div>
      {entry.kind === "user" || entry.kind === "assistant" ? (
        <ChatMarkdown text={entry.text} cwd={undefined} threadRef={threadRef} />
      ) : (
        <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">
          {entry.text}
        </pre>
      )}
    </article>
  );
}

function SubagentTranscriptBody({
  turnItemId,
  environmentId,
  threadId,
}: {
  readonly turnItemId: TurnItemId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [cursor, setCursor] = useState<string>();
  const [transcriptState, setTranscriptState] = useState<{
    readonly entriesById: Record<string, OrchestrationV2SubagentTranscriptEntry>;
    readonly order: ReadonlyArray<string>;
  }>({ entriesById: {}, order: [] });
  const [appliedResult, setAppliedResult] = useState<unknown>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const result = useAtomValue(
    orchestrationEnvironment.subagentTranscript({
      environmentId,
      input: {
        threadId,
        turnItemId,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  );

  // Each page arrives as a new atom result; fold it in while rendering rather
  // than in an effect, so the accumulated transcript never lags a render.
  if (result !== appliedResult) {
    setAppliedResult(result);
    if (result._tag === "Success") {
      const page = result.value;
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
      if (page.nextCursor !== cursor) {
        setCursor(page.nextCursor);
      }
    }
  }

  const entries = useMemo(
    () => transcriptState.order.map((id) => transcriptState.entriesById[id]!),
    [transcriptState],
  );

  const transcriptEntries = useMemo(() => deriveSubagentTranscriptEntries(entries), [entries]);
  const threadRef = useMemo<ScopedThreadRef>(
    () => ({ environmentId, threadId }),
    [environmentId, threadId],
  );

  const entryCount = entries.length;
  useEffect(() => {
    if (entryCount > 0) endRef.current?.scrollIntoView({ block: "end" });
  }, [entryCount]);

  if (entries.length === 0 && result._tag === "Failure") {
    return (
      <div className="p-4 text-center text-xs text-muted-foreground">
        This provider does not expose this agent&apos;s transcript.
      </div>
    );
  }

  if (entries.length === 0) {
    return <div className="p-4 text-center text-xs text-muted-foreground">Loading transcript…</div>;
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {transcriptEntries.map((entryItem) => (
        <TranscriptEntry key={entryItem.entry.id} item={entryItem} threadRef={threadRef} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function SubagentTranscriptView({
  item,
  subagents,
  environmentId,
  threadId,
  onBack,
  onSelect,
}: {
  readonly item: SubagentTurnItem;
  readonly subagents: ReadonlyArray<SubagentTurnItem>;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly onBack: () => void;
  readonly onSelect: (itemId: TurnItemId) => void;
}) {
  const selectableCandidates = useMemo(
    () => subagents.filter((candidate) => candidate.childThreadId === null),
    [subagents],
  );

  return (
    <div
      className="km-transcript flex h-full min-h-0 flex-col"
      data-t3-surface="subagent-transcript"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <Button size="icon-sm" variant="ghost-muted" onClick={onBack} aria-label="Back to agents">
          <ArrowLeft aria-hidden className="size-4" />
        </Button>
        <StatusDot status={item.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{item.prompt}</div>
          <div className="flex items-center gap-2 font-mono text-3xs text-muted-foreground">
            <span>{STATUS_VISUALS[item.status].label}</span>
            <SubagentElapsed item={item} />
          </div>
        </div>
        {selectableCandidates.length > 1 ? (
          <select
            aria-label="Switch agent"
            value={item.id}
            onChange={(event) => onSelect(event.currentTarget.value as TurnItemId)}
            className="ml-auto max-w-32 rounded-md border border-border/60 bg-background px-1.5 py-1 font-mono text-3xs text-muted-foreground"
          >
            {selectableCandidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.prompt.slice(0, 30)}
              </option>
            ))}
          </select>
        ) : null}
      </header>

      {item.liveContent && isOrchestrationV2WorkActive(item.status) ? (
        <section
          className="shrink-0 border-b border-border/60 bg-muted/20 px-3 py-2"
          data-t3-part="agent-live-content"
        >
          <div className="mb-1 font-mono text-3xs uppercase tracking-wide text-muted-foreground">
            Live {item.liveContent.kind}
            {item.liveContent.truncated ? " · preview truncated" : ""}
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
            {item.liveContent.text}
          </pre>
        </section>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        {environmentId !== null && threadId !== null ? (
          <SubagentTranscriptBody
            key={item.id}
            turnItemId={item.id}
            environmentId={environmentId}
            threadId={threadId}
          />
        ) : (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Transcript unavailable without an active environment.
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function SubagentRow({
  item,
  onSelect,
}: {
  readonly item: SubagentTurnItem;
  readonly onSelect: (itemId: TurnItemId) => void;
}) {
  const isSelectable = item.childThreadId === null;

  return (
    <div
      role={isSelectable ? "button" : undefined}
      tabIndex={isSelectable ? 0 : undefined}
      onClick={isSelectable ? () => onSelect(item.id) : undefined}
      onKeyDown={
        isSelectable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(item.id);
              }
            }
          : undefined
      }
      className={cn(
        "flex flex-col gap-1 rounded-md border border-border/60 bg-card/40 p-2 text-left transition-colors",
        isSelectable ? "cursor-pointer hover:bg-muted/40" : "cursor-default opacity-85",
      )}
      data-t3-part="subagent-row"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-mono text-3xs text-muted-foreground">
          <StatusDot status={item.status} />
          <span>{STATUS_VISUALS[item.status].label}</span>
          {item.childThreadId !== null ? (
            <span className="rounded bg-muted px-1 py-0.5 text-3xs">Child thread</span>
          ) : null}
        </div>
        <SubagentElapsed item={item} />
      </div>

      <div className="truncate text-xs font-medium text-foreground">{item.prompt}</div>

      {item.progress ? (
        <div className="truncate text-2xs text-muted-foreground">{item.progress}</div>
      ) : null}

      {item.liveContent ? (
        <div className="mt-0.5 flex flex-col gap-0.5 rounded border border-border/40 bg-muted/20 px-1.5 py-1 font-mono text-3xs">
          <div className="flex items-center gap-1 uppercase tracking-wide text-muted-foreground">
            <span className="font-semibold">{item.liveContent.kind}</span>
            {item.liveContent.truncated ? <span>· preview truncated</span> : null}
          </div>
          <div className="line-clamp-2 break-words text-foreground/90">{item.liveContent.text}</div>
        </div>
      ) : null}
    </div>
  );
}

export function AgentsPanel({
  environmentId = null,
  threadId = null,
  subagents,
}: AgentsPanelProps) {
  const [selectedItemId, setSelectedItemId] = useState<TurnItemId | null>(null);

  const selectedItem = useMemo(
    () =>
      selectedItemId === null
        ? null
        : (subagents.find((item) => item.id === selectedItemId && item.childThreadId === null) ??
          null),
    [selectedItemId, subagents],
  );

  if (selectedItem !== null) {
    return (
      <SubagentTranscriptView
        item={selectedItem}
        subagents={subagents}
        environmentId={environmentId}
        threadId={threadId}
        onBack={() => setSelectedItemId(null)}
        onSelect={setSelectedItemId}
      />
    );
  }

  if (subagents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents, they will show up here with live status, progress, and
          transcripts.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-t3-surface="tool-output">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          {subagents.map((item) => (
            <SubagentRow key={item.id} item={item} onSelect={setSelectedItemId} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
