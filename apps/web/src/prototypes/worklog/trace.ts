// PROTOTYPE: throwaway work-log tree demo. Not production code.
//
// A trace is one real OMP turn, flattened by the extraction step into timed
// events. Every view in the prototype is a pure function of (trace, t), so
// seeking backwards is just rendering an earlier t.
import * as Schema from "effect/Schema";

const TextEvent = Schema.Struct({
  kind: Schema.Literals(["thinking", "text"]),
  id: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
  text: Schema.String,
});

const ToolFields = {
  kind: Schema.Literal("tool"),
  id: Schema.String,
  name: Schema.String,
  intent: Schema.NullOr(Schema.String),
  args: Schema.Record(Schema.String, Schema.Unknown),
  /** The model starts streaming the call's arguments. */
  start: Schema.Number,
  /** The arguments finished streaming (the assistant message ended). */
  argsEnd: Schema.Number,
  /** OMP started executing the tool. */
  execStart: Schema.Number,
  /** The tool result arrived. */
  end: Schema.Number,
  output: Schema.NullOr(Schema.String),
  isError: Schema.Boolean,
  details: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
} as const;

const SubagentToolEvent = Schema.Struct(ToolFields);
const SubagentEvent = Schema.Union([TextEvent, SubagentToolEvent]);

const TraceSubagent = Schema.Struct({
  id: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
  events: Schema.Array(SubagentEvent),
});

const ToolEvent = Schema.Struct({
  ...ToolFields,
  subagents: Schema.optional(Schema.Array(TraceSubagent)),
});

const TraceEvent = Schema.Union([TextEvent, ToolEvent]);

const TraceDocument = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  source: Schema.String,
  cwd: Schema.String,
  prompt: Schema.Struct({ text: Schema.String, at: Schema.Number }),
  events: Schema.Array(TraceEvent),
});

export type TraceTextEvent = typeof TextEvent.Type;
export type TraceSubagentToolEvent = typeof SubagentToolEvent.Type;
export type TraceToolEvent = typeof ToolEvent.Type;
export type TraceSubagent = typeof TraceSubagent.Type;
export type TraceEvent = typeof TraceEvent.Type;
/** Tool or text events of either the parent or a subagent. */
export type AnyTraceEvent = TraceEvent | typeof SubagentEvent.Type;
export type Trace = typeof TraceDocument.Type & {
  /** First and last instants of the turn. */
  readonly t0: number;
  readonly t1: number;
};

const decodeTrace = Schema.decodeUnknownSync(TraceDocument);

export const TRACE_OPTIONS = [
  { id: "php-advisory", label: "PHP advisory check" },
  { id: "native-sessions", label: "Native sessions kickoff" },
] as const;
export type TraceId = (typeof TRACE_OPTIONS)[number]["id"];

export function isTraceId(value: unknown): value is TraceId {
  return TRACE_OPTIONS.some((option) => option.id === value);
}

export async function loadTrace(id: TraceId): Promise<Trace> {
  const response = await fetch(`/__prototype/worklog/${id}.json`);
  if (!response.ok) throw new Error(`Trace ${id} is missing (${response.status}).`);
  const document = decodeTrace(await response.json());
  let t1 = document.prompt.at;
  for (const event of document.events) {
    t1 = Math.max(t1, event.end);
  }
  return { ...document, t0: document.prompt.at, t1: t1 + 1_500 };
}

export function isToolEvent(
  event: AnyTraceEvent,
): event is Extract<AnyTraceEvent, { readonly kind: "tool" }> {
  return event.kind === "tool";
}

/** Fraction of a span covered at `t`, clamped to [0, 1]. */
export function progressAt(t: number, start: number, end: number): number {
  if (end <= start) return t >= start ? 1 : 0;
  return Math.min(1, Math.max(0, (t - start) / (end - start)));
}

/** The prefix of a streamed text visible at `t`, cut on a code point boundary. */
export function streamedPrefix(text: string, t: number, start: number, end: number): string {
  const fraction = progressAt(t, start, end);
  if (fraction >= 1) return text;
  const points = Array.from(text);
  return points.slice(0, Math.floor(points.length * fraction)).join("");
}

export type ToolPhase = "absent" | "streaming" | "running" | "done";

export function toolPhase(event: TraceSubagentToolEvent, t: number): ToolPhase {
  if (t < event.start) return "absent";
  if (t < event.argsEnd) return "streaming";
  if (t < event.end) return "running";
  return "done";
}

/** Instants worth stepping between: every event start and tool result. */
export function traceMarks(trace: Trace): ReadonlyArray<{ at: number; event: TraceEvent }> {
  return trace.events.map((event) => ({ at: event.start, event })).toSorted((a, b) => a.at - b.at);
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
