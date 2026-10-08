/**
 * Agents right-panel surface: the fleet view over the native subagent fold.
 * The chat carries one expandable row per spawn batch and links here.
 *
 * Visualization rules (from live-test feedback):
 * - Spawn order is stable. Activity and completion update rows in place.
 * - Agent rows reserve three fixed lines for identity, activity, and metrics;
 *   changing data must never change their height.
 * - Workflow expansion is presentation state. A live run stays expanded when
 *   it settles; older collapsed runs can still be opened at run granularity.
 * - Static status dots, DOM-write elapsed timers, plain token counters.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  NativeUiState,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ProviderSubagentTranscriptEntry, ThreadId } from "@t3tools/contracts";
import {
  ArrowLeft,
  Bot,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  ListTodo,
  Wrench,
  X,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { serverEnvironment } from "~/state/server";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";

const AgentSelectionContext = createContext<((agentId: string) => void) | null>(null);

/**
 * In-flight states all present as Working (one steady state, per the
 * monitoring-pill design: detail belongs in the activity sub-line, and a
 * stalled/waiting/queued subagent is still the fleet doing its job, not a
 * user problem). Only settled states differentiate.
 */
const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed — live-test: sky idle dots read as stuck in-progress.
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

/** Flat agent status line. Selecting it swaps the panel to that agent's transcript. */
function AgentRow({ agent }: { agent: RuntimeSubagent }) {
  const selectAgent = useContext(AgentSelectionContext);
  const visuals = STATUS_VISUALS[agent.status];
  const statusLabel =
    agent.kind === "subagent_batch" && agent.status === "idle" ? "Idle" : visuals.label;
  const activity = agentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const metadata = [
    modelLabel,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);

  return (
    <button
      type="button"
      onClick={() => selectAgent?.(agent.id)}
      className="grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
      aria-label={`View ${agent.title} transcript`}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot status={agent.status} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
        {role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-3xs text-muted-foreground">
            {role}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-2xs text-muted-foreground/80">
        <span className="inline-flex items-center gap-1">
          <AgentElapsed agent={agent} />
          {agent.status === "completed" ? (
            <Check aria-hidden className="size-3 text-success" />
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {activity ?? statusLabel}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-2xs tabular-nums text-muted-foreground/70">
        {metadata.join(" · ")}
      </span>
      <span className="sr-only">{statusLabel}</span>
    </button>
  );
}

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  );
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/**
 * Phase rail: the run's shape at a glance. One segment per phase in order,
 * separated by chevrons; each segment shows title + one dot per member.
 * The whole arc (done → live → pending) is visible without scrolling the
 * member list.
 */
function PhaseRail({ group }: { group: AgentPanelWorkflowGroup }) {
  if (group.phases.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1.5 pb-1 pt-1.5">
      {group.phases.map((phase, index) => (
        <div key={phase.index} className="flex items-center gap-1">
          {index > 0 ? (
            <ChevronRight aria-hidden className="size-3 text-muted-foreground/40" />
          ) : null}
          <div
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
              phase.state === "running"
                ? "border-info/40"
                : phase.state === "done"
                  ? "border-success/30"
                  : "border-border/50",
            )}
          >
            <span
              className={cn(
                "font-mono text-3xs",
                phase.state === "running"
                  ? "text-info-foreground"
                  : phase.state === "done"
                    ? "text-success-foreground"
                    : "text-muted-foreground/70",
              )}
            >
              {phase.state === "done" ? "✓ " : ""}
              {phase.title}
            </span>
            <span className="flex items-center gap-0.5">
              {phase.members.length === 0 ? (
                <span className="font-mono text-3xs text-muted-foreground/50">–</span>
              ) : (
                phase.members.map((member) => <StatusDot key={member.id} status={member.status} />)
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only workflow script viewer, fetched through the contained
 * getWorkflowScript RPC (never a raw filesystem read from the client).
 */
function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mx-1.5 mb-1 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-3xs text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close script"
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible phase section. A phase opens when it becomes active, then keeps
 * that shape as it settles so completion never yanks rows out from under the
 * user. Manual toggles stick until a later activation begins.
 */
function PhaseSection({
  phase,
  defaultOpen = false,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || phase.state === "running");
  const previousState = useRef(phase.state);

  useEffect(() => {
    if (previousState.current !== "running" && phase.state === "running") {
      setOpen(true);
    }
    previousState.current = phase.state;
  }, [phase.state]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-3xs font-medium uppercase tracking-wider hover:bg-accent/40",
          phase.state === "done"
            ? "text-success-foreground"
            : phase.state === "running"
              ? "text-info-foreground"
              : "text-muted-foreground/70",
        )}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        )}
        {phase.state === "done" ? <Check aria-hidden className="size-3" /> : null}
        <span>{phase.title}</span>
        <span className="font-normal normal-case text-muted-foreground/70">
          {phase.state === "pending" && phase.members.length === 0
            ? "pending"
            : phase.state === "done"
              ? `${phase.settledCount} done`
              : `${phase.activeCount} active · ${phase.settledCount} done`}
        </span>
        {!open && phase.members.length > 0 ? (
          <span className="ml-auto flex items-center gap-0.5">
            {phase.members.map((member) => (
              <StatusDot key={member.id} status={member.status} />
            ))}
          </span>
        ) : null}
      </button>
      {open ? phase.members.map((member) => <AgentRow key={member.id} agent={member} />) : null}
    </div>
  );
}

/** Expanded workflow: phase rail + full phase tree. */
function ExpandedWorkflowSection({
  group,
  environmentId,
  threadId,
  onCollapse,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onCollapse: () => void;
}) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group);
  const settled = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;
  return (
    <section className="rounded-lg border border-border/50 bg-card/30 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
        <StatusDot status={group.workflow.status} />
        <span className="min-w-0 truncate">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        {canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            className={cn(
              "rounded-sm border border-border/60 px-1 font-mono normal-case hover:text-foreground",
              scriptOpen && "text-foreground",
            )}
            aria-expanded={scriptOpen}
          >
            {"{}"} script
          </button>
        ) : null}
        <span className="ml-auto font-mono normal-case text-muted-foreground/80">
          {settled}/{members.length} settled
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onCollapse}
          aria-label="Collapse workflow"
        >
          <ChevronDown aria-hidden className="size-3" />
        </Button>
      </div>
      <PhaseRail group={group} />
      {scriptOpen && canShowScript ? (
        <WorkflowScriptView
          environmentId={environmentId}
          threadId={threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptOpen(false)}
        />
      ) : null}
      {group.phases.map((phase) => (
        <PhaseSection key={phase.index} phase={phase} defaultOpen={!workflowIsLive(group)} />
      ))}
      {group.unphasedMembers.map((member) => (
        <AgentRow key={member.id} agent={member} />
      ))}
      {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
        <AgentRow agent={group.workflow} />
      ) : null}
    </section>
  );
}

/**
 * Collapsed workflow: one summary line. The parent owns expansion so a live
 * workflow keeps its shape when it settles.
 */
function CollapsedWorkflowSection({
  group,
  onExpand,
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
}) {
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  // Coordinator usage may already aggregate members (panel-footer rule):
  // count it only when there are no member rows to sum.
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
        aria-expanded={false}
      >
        <StatusDot status={failed > 0 ? "failed" : group.workflow.status} />
        <span className="truncate text-sm">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-2xs text-muted-foreground/80">
          {failed > 0 ? <span className="text-destructive-foreground">{failed} failed</span> : null}
          <span>{members.length} agents</span>
          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          <ChevronRight aria-hidden className="size-3" />
        </span>
      </button>
    </section>
  );
}

/** A workflow's open state is presentation state, not a status derivative. */
function WorkflowSection({
  group,
  environmentId,
  threadId,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  const [open, setOpen] = useState(() => workflowIsLive(group));
  return open ? (
    <ExpandedWorkflowSection
      group={group}
      environmentId={environmentId}
      threadId={threadId}
      onCollapse={() => setOpen(false)}
    />
  ) : (
    <CollapsedWorkflowSection group={group} onExpand={() => setOpen(true)} />
  );
}

const EMPTY_NATIVE_UI_STATE: NativeUiState = { statuses: [], widgets: [] };

function panelAgents(model: AgentPanelModel): ReadonlyArray<RuntimeSubagent> {
  const agents = new Map<string, RuntimeSubagent>();
  for (const group of model.workflows) {
    agents.set(group.workflow.id, group.workflow);
    for (const member of workflowMembers(group)) agents.set(member.id, member);
  }
  for (const agent of model.directAgents) agents.set(agent.id, agent);
  return [...agents.values()];
}

function NativeUiShelf({ state }: { state: NativeUiState }) {
  if (state.statuses.length === 0 && state.widgets.length === 0) return null;
  const widgets = [...state.widgets].toSorted(
    (left, right) => Number(left.placement === "below") - Number(right.placement === "below"),
  );
  return (
    <section className="border-b border-border/60 p-2" data-t3-surface="native-session">
      {state.statuses.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {state.statuses.map((status) => (
            <span
              key={status.key}
              className="rounded-sm border border-border/60 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground"
            >
              {status.value}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {widgets.map((widget) => (
          <div
            key={widget.key}
            className="rounded-md border border-border/60 bg-card/30 px-2 py-1.5"
          >
            <div className="mb-1 flex items-center gap-1.5 font-mono text-3xs text-muted-foreground">
              <ListTodo aria-hidden className="size-3" />
              <span>{widget.key}</span>
            </div>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-foreground/90">
              {widget.content}
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}

function transcriptLabel(entry: ProviderSubagentTranscriptEntry, agent: RuntimeSubagent): string {
  if (entry.kind === "user") return "Assignment";
  if (entry.kind === "reasoning") return "Reasoning";
  if (entry.kind === "tool") return entry.toolName ?? "Tool";
  if (entry.kind === "system") return "System";
  return agent.role ?? agent.title;
}

function AgentTranscriptBody({
  agent,
  environmentId,
  threadId,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [cursor, setCursor] = useState<string>();
  const [entries, setEntries] = useState<ReadonlyArray<ProviderSubagentTranscriptEntry>>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const result = useAtomValue(
    serverEnvironment.subagentTranscript({
      environmentId,
      input: {
        threadId,
        subagentId: agent.id,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  );

  useEffect(() => {
    if (result._tag !== "Success") return;
    const page = result.value;
    setEntries((current) => {
      const base = page.reset ? [] : current;
      const known = new Set(base.map((entry) => entry.id));
      const additions = page.entries.filter((entry) => !known.has(entry.id));
      return additions.length === 0 && !page.reset ? current : [...base, ...additions];
    });
    if (page.nextCursor !== cursor) setCursor(page.nextCursor);
  }, [cursor, result]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

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
      {entries.map((entry) => (
        <article key={entry.id} className="min-w-0">
          <div
            className={cn(
              "mb-1 flex items-center gap-1.5 font-mono text-3xs uppercase tracking-wide text-muted-foreground",
              entry.isError && "text-destructive-foreground",
            )}
          >
            {entry.kind === "tool" ? <Wrench aria-hidden className="size-3" /> : null}
            {transcriptLabel(entry, agent)}
          </div>
          <pre
            className={cn(
              "whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90",
              entry.kind === "reasoning" && "text-muted-foreground",
              entry.kind === "tool" &&
                "rounded-md border border-border/60 bg-card/30 p-2 font-mono text-2xs",
            )}
          >
            {entry.text}
          </pre>
        </article>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function AgentTranscript({
  agent,
  agents,
  environmentId,
  threadId,
  onBack,
  onSelect,
}: {
  agent: RuntimeSubagent;
  agents: ReadonlyArray<RuntimeSubagent>;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onBack: () => void;
  onSelect: (agentId: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <Button size="icon-sm" variant="ghost-muted" onClick={onBack} aria-label="Back to agents">
          <ArrowLeft aria-hidden className="size-4" />
        </Button>
        <StatusDot status={agent.status} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{agent.title}</div>
          <div className="truncate font-mono text-3xs text-muted-foreground">
            {[agent.role, formatSubagentModelLabel(agent.model, agent.effort)]
              .filter((value): value is string => Boolean(value))
              .join(" · ")}
          </div>
        </div>
        <select
          aria-label="Switch agent"
          value={agent.id}
          onChange={(event) => onSelect(event.currentTarget.value)}
          className="ml-auto max-w-32 rounded-md border border-border/60 bg-background px-1.5 py-1 font-mono text-3xs text-muted-foreground"
        >
          {agents.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </select>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {environmentId !== null && threadId !== null ? (
          <AgentTranscriptBody
            key={agent.id}
            agent={agent}
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

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
  nativeUiState = EMPTY_NATIVE_UI_STATE,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  nativeUiState?: NativeUiState;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const agents = useMemo(() => panelAgents(model), [model]);
  const selectedAgent =
    selectedAgentId === null
      ? null
      : (agents.find((agent) => agent.id === selectedAgentId) ?? null);

  if (selectedAgent !== null) {
    return (
      <AgentTranscript
        agent={selectedAgent}
        agents={agents}
        environmentId={environmentId}
        threadId={threadId}
        onBack={() => setSelectedAgentId(null)}
        onSelect={setSelectedAgentId}
      />
    );
  }

  const hasNativeUi = nativeUiState.statuses.length > 0 || nativeUiState.widgets.length > 0;
  if (!model.hasAgents && !hasNativeUi) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents or runs a workflow, they show up here with live status,
          activity, and token usage.
        </p>
      </div>
    );
  }

  return (
    <AgentSelectionContext.Provider value={setSelectedAgentId}>
      <div className="flex h-full min-h-0 flex-col" data-t3-surface="tool-output">
        <NativeUiShelf state={nativeUiState} />
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-2">
            {model.workflows.map((group) => (
              <WorkflowSection
                key={group.workflow.id}
                group={group}
                environmentId={environmentId}
                threadId={threadId}
              />
            ))}
            {model.directAgents.length > 0 ? (
              <section>
                <div className="px-1.5 pt-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                  Direct spawns
                </div>
                {model.directAgents.map((agent) => (
                  <AgentRow key={agent.id} agent={agent} />
                ))}
              </section>
            ) : null}
          </div>
        </ScrollArea>
        {model.hasAgents ? (
          <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-2xs text-muted-foreground">
            <span className="flex items-center gap-2">
              {model.runningCount + model.waitingCount > 0 ? (
                <span className="text-info-foreground">
                  ● {model.runningCount + model.waitingCount} working
                </span>
              ) : null}
              {model.idleCount > 0 ? <span>{model.idleCount} idle</span> : null}
              {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}
            </span>
            <span className="tabular-nums">
              Σ {formatSubagentTokenCount(model.totalTokens)} tok
            </span>
          </footer>
        ) : null}
      </div>
    </AgentSelectionContext.Provider>
  );
}
