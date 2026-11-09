// PROTOTYPE: throwaway work-log tree demo. Not production code.
//
// Replays one real OMP turn into two panes (Minimal, Minimal+) under either
// the proposed tree design or the current timeline. Every frame is rendered
// from the playback position alone, so it plays and seeks both ways.
import "./worklog-prototype.css";

import {
  ChevronFirst,
  ChevronLast,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { createSpringChase } from "../../lib/motion";
import { cn } from "../../lib/utils";
import { CurrentTimelinePane } from "./CurrentTimelinePane";
import {
  formatClock,
  loadTrace,
  TRACE_OPTIONS,
  traceMarks,
  type Trace,
  type TraceEvent,
  type TraceId,
} from "./trace";
import { motionLands, useMotionInputs } from "./motion";
import type { TranscriptLook } from "./tree";
import { WorkTreeTranscript, type Overrides } from "./WorkTree";

export const DESIGN_OPTIONS = [
  { id: "tree", label: "Proposed tree", pane: "proposed tree" },
  { id: "flat", label: "Flat", pane: "flat, one indent" },
  { id: "current", label: "Current", pane: "current timeline" },
] as const;
export type Design = (typeof DESIGN_OPTIONS)[number]["id"];

const SPEEDS = [1, 2, 4, 8, 16] as const;
type Speed = (typeof SPEEDS)[number];

const LOOKS: ReadonlyArray<{ id: TranscriptLook; label: string }> = [
  { id: "minimal", label: "Minimal" },
  { id: "minimal-plus", label: "Minimal+" },
];

export function PrototypeWorklogPage(props: {
  readonly traceId: TraceId;
  readonly design: Design;
  readonly onChange: (next: { traceId: TraceId; design: Design }) => void;
}) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTrace(null);
    loadTrace(props.traceId).then(
      (loaded) => {
        if (!cancelled) setTrace(loaded);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.traceId]);

  if (error !== null) {
    return <CenteredMessage>Could not load the trace: {error}</CenteredMessage>;
  }
  if (trace === null) return <CenteredMessage>Loading trace…</CenteredMessage>;
  return <Player key={trace.id} trace={trace} {...props} />;
}

function CenteredMessage(props: { readonly children: ReactNode }) {
  return (
    <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
      {props.children}
    </div>
  );
}

interface Playback {
  readonly position: number;
  readonly playing: boolean;
  readonly direction: 1 | -1;
  readonly speed: Speed;
}

function usePlayback(duration: number) {
  const [state, setState] = useState<Playback>({
    position: 0,
    playing: false,
    direction: 1,
    speed: 4,
  });
  const { playing, direction, speed } = state;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = now - last;
      last = now;
      setState((current) => {
        const position = Math.min(
          duration,
          Math.max(0, current.position + elapsed * current.speed * current.direction),
        );
        const atEdge = position === 0 || position === duration;
        return { ...current, position, playing: !atEdge };
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, direction, speed, duration]);

  const seek = useCallback(
    (position: number) =>
      setState((current) => ({ ...current, position: Math.min(duration, Math.max(0, position)) })),
    [duration],
  );
  const play = useCallback(
    (nextDirection: 1 | -1) =>
      setState((current) => {
        // Playing into an edge starts over from the other end.
        const restart =
          (nextDirection === 1 && current.position >= duration) ||
          (nextDirection === -1 && current.position <= 0);
        return {
          ...current,
          direction: nextDirection,
          playing: true,
          position: restart ? (nextDirection === 1 ? 0 : duration) : current.position,
        };
      }),
    [duration],
  );
  const pause = useCallback(() => setState((current) => ({ ...current, playing: false })), []);
  const setSpeed = useCallback(
    (nextSpeed: Speed) => setState((current) => ({ ...current, speed: nextSpeed })),
    [],
  );
  return { state, seek, play, pause, setSpeed };
}

/** Re-reads `value` at most every `intervalMs`, keeping the newest value. */
function useThrottled<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastRef = useRef(0);
  useEffect(() => {
    const now = performance.now();
    const wait = Math.max(0, lastRef.current + intervalMs - now);
    const timer = window.setTimeout(() => {
      lastRef.current = performance.now();
      setThrottled(value);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [value, intervalMs]);
  return throttled;
}

function Player(props: {
  readonly trace: Trace;
  readonly traceId: TraceId;
  readonly design: Design;
  readonly onChange: (next: { traceId: TraceId; design: Design }) => void;
}) {
  const { trace, design, onChange, traceId } = props;
  const duration = trace.t1 - trace.t0;
  const { state, seek, play, pause, setSpeed } = usePlayback(duration);
  const t = trace.t0 + state.position;
  const marks = useMemo(() => traceMarks(trace), [trace]);
  useMotionInputs();
  const [overrides, setOverrides] = useState<Record<TranscriptLook, Overrides>>({
    minimal: new Map(),
    "minimal-plus": new Map(),
  });

  const stepTo = useCallback(
    (direction: 1 | -1) => {
      pause();
      const target =
        direction === 1
          ? marks.find((mark) => mark.at - trace.t0 > state.position + 1)
          : marks.findLast((mark) => mark.at - trace.t0 < state.position - 1);
      seek(target === undefined ? (direction === 1 ? duration : 0) : target.at - trace.t0);
    },
    [duration, marks, pause, seek, state.position, trace.t0],
  );

  const cycleDesign = useCallback(
    (delta: 1 | -1) => {
      const index = DESIGN_OPTIONS.findIndex((option) => option.id === design);
      const next = DESIGN_OPTIONS[(index + delta + DESIGN_OPTIONS.length) % DESIGN_OPTIONS.length];
      if (next !== undefined) onChange({ traceId, design: next.id });
    },
    [design, onChange, traceId],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;
      if (event.target instanceof HTMLSelectElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === " " || key === "k") {
        event.preventDefault();
        if (state.playing) pause();
        else play(1);
      } else if (key === "j") seek(state.position - 10_000);
      else if (key === "l") seek(state.position + 10_000);
      else if (key === "r") play(-1);
      else if (key === ",") stepTo(-1);
      else if (key === ".") stepTo(1);
      else if (key === "arrowleft") {
        event.preventDefault();
        cycleDesign(-1);
      } else if (key === "arrowright") {
        event.preventDefault();
        cycleDesign(1);
      } else {
        const speed = SPEEDS[Number(key) - 1];
        if (speed !== undefined) setSpeed(speed);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleDesign, pause, play, seek, setSpeed, state.playing, state.position, stepTo]);

  const actionCount = trace.events.filter((event) => event.kind === "tool").length;
  const currentT = useThrottled(t, 90);

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[0.6875rem] font-semibold tracking-wide text-warning-foreground uppercase">
          Prototype
        </span>
        <h1 className="shrink-0 text-sm font-medium whitespace-nowrap">Work log tree</h1>
        <select
          aria-label="Trace"
          value={traceId}
          onChange={(event) => {
            const next = TRACE_OPTIONS.find((option) => option.id === event.target.value);
            if (next !== undefined) onChange({ traceId: next.id, design });
          }}
          className="h-7 shrink-0 rounded-md border border-border bg-background px-2 text-xs"
        >
          {TRACE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          Real OMP turn · {actionCount} actions · {formatClock(duration)} · {trace.cwd} ·{" "}
          {trace.source}
        </span>
        <button
          type="button"
          onClick={() => setOverrides({ minimal: new Map(), "minimal-plus": new Map() })}
          className="ms-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Reset toggles
        </button>
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border">
        {LOOKS.map((look) => (
          <section key={look.id} className="flex min-h-0 min-w-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{look.label}</span>
              <span>·</span>
              <span>{DESIGN_OPTIONS.find((option) => option.id === design)?.pane}</span>
            </div>
            {design !== "current" ? (
              <FollowScroll>
                <div className="km-transcript" data-transcript-style={look.id}>
                  <WorkTreeTranscript
                    trace={trace}
                    t={t}
                    look={look.id}
                    layout={design}
                    overrides={overrides[look.id]}
                    onToggle={(id, open) =>
                      setOverrides((current) => {
                        const next = new Map(current[look.id]);
                        next.set(id, open);
                        return { ...current, [look.id]: next };
                      })
                    }
                  />
                </div>
              </FollowScroll>
            ) : (
              <div className="min-h-0 flex-1">
                <CurrentTimelinePane
                  trace={trace}
                  t={currentT}
                  transcriptStyle={look.id}
                  paneKey={`${trace.id}-${look.id}`}
                />
              </div>
            )}
          </section>
        ))}
      </main>
      <TransportBar
        trace={trace}
        state={state}
        duration={duration}
        design={design}
        onDesign={(next) => onChange({ traceId, design: next })}
        onSeek={(position) => {
          pause();
          seek(position);
        }}
        onPlay={play}
        onPause={pause}
        onStep={stepTo}
        onSpeed={setSpeed}
      />
    </div>
  );
}

/**
 * Keeps a pane pinned to its newest content unless the reader scrolled up.
 * Growth glides the scroll position on KM's transcript spring, retargeted
 * every time the content's height moves, so arrivals slide up instead of
 * the page stepping. Keys, the transport and reduced motion jump.
 */
function FollowScroll(props: { readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const scroller = ref.current;
    const content = contentRef.current;
    if (scroller === null || content === null) return;
    let pinned = true;
    let written = 0;
    const chase = createSpringChase(
      (top) => {
        written = top;
        scroller.scrollTop = top;
      },
      () => {},
    );
    const bottom = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const follow = () => {
      if (!pinned) return;
      const target = bottom();
      if (motionLands()) {
        chase.stop();
        scroller.scrollTop = target;
        return;
      }
      if (!chase.running && Math.abs(target - scroller.scrollTop) < 0.5) return;
      chase.to(chase.running ? chase.value : scroller.scrollTop, target);
    };
    scroller.scrollTop = bottom();
    const onScroll = () => {
      const distance = bottom() - scroller.scrollTop;
      if (chase.running) {
        // Only the reader moves it up against the glide; a clamp lands at bottom.
        if (scroller.scrollTop < written - 2 && distance > 64) {
          chase.stop();
          pinned = false;
        }
        return;
      }
      pinned = distance < 64;
    };
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      chase.stop();
    };
  }, []);
  return (
    // FollowScroll owns the position; browser scroll anchoring would fight
    // the glide whenever a row above starts to fold.
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
      <div ref={contentRef}>{props.children}</div>
    </div>
  );
}

const MARK_TONES: Record<string, string> = {
  thinking: "bg-muted-foreground/40",
  text: "bg-foreground/70",
  explore: "bg-info",
  run: "bg-warning",
  change: "bg-diff-addition",
  delegate: "bg-violet-500",
  plan: "bg-foreground",
};

function markTone(event: TraceEvent): string {
  if (event.kind !== "tool") return MARK_TONES[event.kind] ?? "bg-muted-foreground";
  const name = event.name;
  if (["read", "grep", "find", "glob", "web_search"].includes(name))
    return MARK_TONES.explore ?? "";
  if (["bash", "eval"].includes(name)) return MARK_TONES.run ?? "";
  if (["write", "edit", "ast_edit"].includes(name)) return MARK_TONES.change ?? "";
  if (["task", "wait", "hub"].includes(name)) return MARK_TONES.delegate ?? "";
  return MARK_TONES.plan ?? "";
}

function TransportBar(props: {
  readonly trace: Trace;
  readonly state: Playback;
  readonly duration: number;
  readonly design: Design;
  readonly onDesign: (design: Design) => void;
  readonly onSeek: (position: number) => void;
  readonly onPlay: (direction: 1 | -1) => void;
  readonly onPause: () => void;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onSpeed: (speed: Speed) => void;
}) {
  const { trace, state, duration } = props;
  const percent = (state.position / duration) * 100;
  const playingForward = state.playing && state.direction === 1;
  const playingBack = state.playing && state.direction === -1;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div
        data-wl-transport
        className="pointer-events-auto flex w-full max-w-5xl flex-col gap-2 rounded-xl border border-border bg-popover/95 px-3 py-2.5 shadow-lg backdrop-blur"
      >
        <div className="relative h-6">
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted" />
          <div
            className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-foreground/50"
            style={{ width: `${percent}%` }}
          />
          {trace.events.map((event) => (
            <span
              key={event.id}
              title={event.kind === "tool" ? event.name : event.kind}
              className={cn(
                "pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 opacity-80",
                markTone(event),
              )}
              style={{ left: `${((event.start - trace.t0) / duration) * 100}%` }}
            />
          ))}
          <input
            type="range"
            aria-label="Playback position"
            min={0}
            max={duration}
            step={100}
            value={state.position}
            onChange={(event) => props.onSeek(Number(event.target.value))}
            className="wl-scrubber absolute inset-0 h-6 w-full cursor-pointer appearance-none bg-transparent"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TransportButton label="Start" onClick={() => props.onSeek(0)}>
            <ChevronFirst className="size-4" />
          </TransportButton>
          <TransportButton label="Previous step (,)" onClick={() => props.onStep(-1)}>
            <SkipBack className="size-4" />
          </TransportButton>
          <TransportButton
            label="Play backwards (R)"
            active={playingBack}
            onClick={() => (playingBack ? props.onPause() : props.onPlay(-1))}
          >
            {playingBack ? <Pause className="size-4" /> : <Play className="size-4 rotate-180" />}
          </TransportButton>
          <TransportButton
            label="Play (Space)"
            active={playingForward}
            onClick={() => (playingForward ? props.onPause() : props.onPlay(1))}
          >
            {playingForward ? <Pause className="size-4" /> : <Play className="size-4" />}
          </TransportButton>
          <TransportButton label="Next step (.)" onClick={() => props.onStep(1)}>
            <SkipForward className="size-4" />
          </TransportButton>
          <TransportButton label="End" onClick={() => props.onSeek(duration)}>
            <ChevronLast className="size-4" />
          </TransportButton>
          <span className="w-24 text-center font-mono text-xs text-muted-foreground tabular-nums">
            {formatClock(state.position)} / {formatClock(duration)}
          </span>
          <Segmented
            label="Speed"
            options={SPEEDS.map((speed) => ({ id: speed, label: `${speed}×` }))}
            value={state.speed}
            onChange={props.onSpeed}
          />
          <span className="ms-auto" />
          <Segmented
            label="Design"
            options={DESIGN_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
            value={props.design}
            onChange={props.onDesign}
          />
          <span className="hidden text-[0.6875rem] text-muted-foreground/80 lg:inline">
            ←/→ design · Space play · R reverse · J/L ±10s · , . step · 1–5 speed
          </span>
        </div>
      </div>
    </div>
  );
}

function TransportButton(props: {
  readonly label: string;
  readonly active?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent hover:text-foreground active:scale-[0.96]",
        props.active && "bg-accent text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function Segmented<T extends string | number>(props: {
  readonly label: string;
  readonly options: ReadonlyArray<{ id: T; label: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className="flex rounded-lg bg-muted p-0.5">
      {props.options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === props.value}
          onClick={() => props.onChange(option.id)}
          className={cn(
            "h-7 rounded-md px-2.5 text-xs font-medium tabular-nums transition-colors",
            option.id === props.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
