import { describe, expect, it } from "@effect/vitest";

import {
  GROK_COST_USD_TICKS_PER_DOLLAR,
  initialCodexScanState,
  parseClaudeRecord,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  totalTokens,
} from "./usageTranscripts.ts";

/** Shaped after a real Claude Code assistant record. */
function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  model?: string;
  outputTokens?: number;
  speed?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T04:05:13.944Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    cwd: "/home/theo/project",
    message: {
      id: overrides.messageId,
      role: "assistant",
      model: overrides.model ?? "claude-fable-5",
      content: [{ type: overrides.contentType }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 66818,
        cache_read_input_tokens: 1000,
        output_tokens: overrides.outputTokens ?? 286,
        ...(overrides.speed === undefined ? {} : { speed: overrides.speed }),
      },
    },
  });
}

describe("parseClaudeLine", () => {
  it("extracts token totals and a dedupe key", () => {
    const [record] = parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text" }));

    expect(record).toBeDefined();
    expect(record?.provider).toBe("claude");
    expect(record?.model).toBe("claude-fable-5");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 66818,
      outputTokens: 286,
      reasoningTokens: 0,
    });
    expect(record?.dedupeKey).toBe("msg_1:");
    expect(record?.speed).toBe("standard");
  });

  it("marks fast-mode requests", () => {
    const parse = (speed: string) =>
      parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text", speed }))[0];

    expect(parse("fast")?.speed).toBe("fast");
    expect(parse("standard")?.speed).toBe("standard");
  });

  it("gives every content block of one message the same dedupe key", () => {
    // T3 Code writes one record per content block, each repeating the parent
    // message's full usage. Summing them would overcount ~2.4x on real data.
    const [text] = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "text" }));
    const [toolUse] = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }));

    expect(text?.dedupeKey).toBe(toolUse?.dedupeKey);
    expect(text?.totals).toEqual(toolUse?.totals);
  });

  it("ignores records that are not assistant messages", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "user", message: {} }))).toEqual([]);
    expect(parseClaudeLine("not json")).toEqual([]);
  });
});

describe("Claude advisor iterations", () => {
  const advisorTurn = {
    type: "assistant",
    timestamp: "2026-10-22T01:31:11.984Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 118320,
        cache_creation_input_tokens: 2676,
        output_tokens: 4506,
        speed: "standard",
        iterations: [
          {
            type: "message",
            input_tokens: 2,
            cache_read_input_tokens: 58352,
            cache_creation_input_tokens: 1616,
            output_tokens: 141,
          },
          {
            type: "advisor_message",
            model: "claude-fable-5-1",
            input_tokens: 54204,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 4229,
          },
          {
            type: "message",
            input_tokens: 2,
            cache_read_input_tokens: 59968,
            cache_creation_input_tokens: 1060,
            output_tokens: 4365,
          },
        ],
      },
    },
  };
  const withIterations = (iterations: readonly unknown[]) => ({
    ...advisorTurn,
    message: { ...advisorTurn.message, usage: { ...advisorTurn.message.usage, iterations } },
  });
  const parse = (turn: unknown) => parseClaudeLine(JSON.stringify(turn));

  it("reports advisor tokens under their model beside the executor record", () => {
    const records = parse(advisorTurn);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      totals: {
        uncachedInputTokens: 4,
        cachedInputTokens: 118320,
        cacheCreationTokens: 2676,
        outputTokens: 4506,
        reasoningTokens: 0,
      },
      dedupeKey: "msg_1:req_1",
    });
    expect(records[1]).toMatchObject({
      provider: "claude",
      model: "claude-fable-5-1",
      sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
      totals: {
        uncachedInputTokens: 54204,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 4229,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      dedupeKey: "msg_1:req_1:advisor:1",
    });
    expect(parseClaudeRecord(advisorTurn)).toEqual(records);
  });

  it("keys advisor records separately and consistently across message content blocks", () => {
    const block = (contentType: string) =>
      parse({
        ...advisorTurn,
        message: { ...advisorTurn.message, content: [{ type: contentType }] },
      });
    const [executorKey, advisorKey] = block("text").map((record) => record.dedupeKey);

    expect(advisorKey).toEqual(expect.any(String));
    expect(advisorKey).not.toBe(executorKey);
    expect(block("tool_use").map((record) => record.dedupeKey)).toEqual([executorKey, advisorKey]);

    const unkeyed = parse({
      ...advisorTurn,
      requestId: undefined,
      message: { ...advisorTurn.message, id: undefined },
    });
    expect(unkeyed.map((record) => record.dedupeKey)).toEqual([null, null]);
  });

  it("emits only the executor record without an advisor iteration", () => {
    const executorIterations = advisorTurn.message.usage.iterations.filter(
      (iteration) => iteration.type === "message",
    );

    expect(parse(withIterations(executorIterations))).toHaveLength(1);
    expect(parse(withIterations([]))).toHaveLength(1);
    expect(parseClaudeLine(claudeLine({ messageId: "msg_3", contentType: "text" }))).toHaveLength(
      1,
    );
  });

  it("ignores advisor iterations without a usable model and malformed entries", () => {
    const unusable = withIterations([
      null,
      "advisor_message",
      { type: "advisor_message", input_tokens: 5 },
      { type: "advisor_message", model: "", input_tokens: 5 },
      { type: "advisor_message", model: "<synthetic>", input_tokens: 5 },
    ]);

    expect(parse(unusable).map((record) => record.model)).toEqual(["claude-opus-5-5"]);
  });
});

describe("parseCodexLine", () => {
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T05:17:41.289Z",
    payload: { type: "session_meta", id: "019fbbc1-b12c-7360-a685-28c181f0025f" },
  });
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T05:17:42.694Z",
    payload: { type: "turn_context", model: "gpt-5.6-sol" },
  });
  const tokenCount = (inputTokens: number, cached: number, output: number, reasoning: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
          },
        },
      },
    });
  type CodexUsageCounters = {
    readonly input_tokens: number;
    readonly cached_input_tokens: number;
    readonly cache_write_input_tokens: number;
    readonly output_tokens: number;
    readonly reasoning_output_tokens: number;
    readonly total_tokens: number;
  };
  const counters = (
    inputTokens: number,
    cached: number,
    output: number,
    reasoning: number,
  ): CodexUsageCounters => ({
    input_tokens: inputTokens,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: inputTokens + output,
  });
  const counted = (
    last: CodexUsageCounters,
    total: CodexUsageCounters,
    timestamp = "2026-08-01T05:17:49.919Z",
  ) =>
    JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: { last_token_usage: last, total_token_usage: total },
      },
    });

  it("attributes usage to the model from the preceding turn context", () => {
    const state = initialCodexScanState();
    parseCodexLine(sessionMeta, state);
    parseCodexLine(turnContext, state);
    const record = parseCodexLine(tokenCount(19239, 11008, 299, 116), state);

    expect(record?.provider).toBe("codex");
    expect(record?.model).toBe("gpt-5.6-sol");
    expect(record?.sessionId).toBe("019fbbc1-b12c-7360-a685-28c181f0025f");
    // Codex reports input_tokens inclusive of the cached portion.
    expect(record?.totals.uncachedInputTokens).toBe(19239 - 11008);
    expect(record?.totals.cachedInputTokens).toBe(11008);
    expect(record?.totals.reasoningTokens).toBe(116);
  });

  it("skips a repeated token_count so deltas are not double counted", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const first = parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const repeat = parseCodexLine(tokenCount(100, 0, 10, 0), state);

    expect(first).not.toBeNull();
    expect(repeat).toBeNull();
  });

  it("ignores a replay of the current sequence's first request without rewinding the baseline", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const request = counters(100, 20, 20, 0);
    const processed = [
      counted(request, request),
      counted(counters(200, 40, 40, 0), counters(300, 60, 60, 0), "2026-08-01T05:17:50.000Z"),
      counted(request, request),
      counted(counters(30, 5, 5, 0), counters(330, 65, 65, 0), "2026-08-01T05:17:51.000Z"),
    ].map((line) => {
      const record = parseCodexLine(line, state);
      return record === null ? 0 : totalTokens(record.totals);
    });

    expect(processed).toEqual([120, 240, 0, 35]);
  });

  it("bills a genuine restart with the same counters at a new timestamp", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const request = counters(100, 20, 20, 0);
    const processed = [
      counted(request, request),
      counted(counters(200, 40, 40, 0), counters(300, 60, 60, 0), "2026-08-01T05:17:50.000Z"),
      counted(request, request, "2026-08-01T05:18:49.919Z"),
    ].map((line) => {
      const record = parseCodexLine(line, state);
      return record === null ? 0 : totalTokens(record.totals);
    });

    expect(processed).toEqual([120, 240, 120]);
  });

  it("forgets the sequence start when a zero baseline resets the counters", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const request = counters(100, 20, 20, 0);
    const zero = counters(0, 0, 0, 0);
    const processed = [
      counted(request, request),
      counted(zero, zero, "2026-08-01T05:17:50.000Z"),
      counted(request, request),
    ].map((line) => {
      const record = parseCodexLine(line, state);
      return record === null ? 0 : totalTokens(record.totals);
    });

    expect(processed).toEqual([120, 0, 120]);
  });

  it("drops usage that arrives before any model is known", () => {
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
  });

  it("does not let a pre-model event poison the duplicate signature", () => {
    // A token_count before its turn_context is dropped; the identical event
    // re-emitted once the model is known must still be counted.
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
    parseCodexLine(turnContext, state);
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).not.toBeNull();
  });

  it("carries the service tier from the latest thread settings", () => {
    const settings = (thread_settings: Record<string, unknown>) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T05:17:42.000Z",
        payload: { type: "thread_settings_applied", thread_settings },
      });
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const speedAfter = (line: string, output: number) => {
      parseCodexLine(line, state);
      return parseCodexLine(tokenCount(100, 0, output, 0), state)?.speed;
    };

    expect(parseCodexLine(tokenCount(100, 0, 1, 0), state)?.speed).toBe("standard");
    expect(speedAfter(settings({ service_tier: "ultrafast" }), 2)).toBe("ultrafast");
    expect(speedAfter(settings({ service_tier: "priority" }), 3)).toBe("fast");
    // Codex omits the field when no tier was requested.
    expect(speedAfter(settings({ model: "gpt-6-astra" }), 4)).toBe("standard");
  });

  // A forked/subagent rollout opens with the parent's history copied in and
  // every line re-stamped to the fork instant, then the ancestors' session
  // metas. Counting those again multiplied usage ~1.85x on real data (#5758).
  describe("forked rollouts", () => {
    const meta = (overrides: {
      id: string;
      timestamp: string;
      forkedFromId?: string;
      spawnParentId?: string;
    }) =>
      JSON.stringify({
        type: "session_meta",
        timestamp: overrides.timestamp,
        payload: {
          type: "session_meta",
          id: overrides.id,
          ...(overrides.forkedFromId === undefined
            ? {}
            : { forked_from_id: overrides.forkedFromId }),
          ...(overrides.spawnParentId === undefined
            ? {}
            : {
                source: {
                  subagent: { thread_spawn: { parent_thread_id: overrides.spawnParentId } },
                },
              }),
        },
      });
    const stamped = (timestamp: string, line: string) => {
      const parsed = JSON.parse(line) as { timestamp: string };
      parsed.timestamp = timestamp;
      return JSON.stringify(parsed);
    };

    it("keeps the child session id over copied ancestor metas", () => {
      const state = initialCodexScanState();
      parseCodexLine(meta({ id: "child", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(meta({ id: "parent", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(turnContext, state);
      const record = parseCodexLine(tokenCount(100, 0, 10, 0), state);

      expect(record?.sessionId).toBe("child");
    });

    it("drops the re-stamped copied burst and keeps the first real event", () => {
      const state = initialCodexScanState();
      const forkInstant = "2026-08-01T05:00:00.000Z";
      parseCodexLine(meta({ id: "child", timestamp: forkInstant, forkedFromId: "parent" }), state);
      parseCodexLine(meta({ id: "parent", timestamp: forkInstant }), state);
      parseCodexLine(stamped(forkInstant, turnContext), state);

      // Copied history: written in one burst at the fork instant.
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.001Z", tokenCount(100, 0, 10, 0)), state),
      ).toBeNull();
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.002Z", tokenCount(200, 0, 20, 0)), state),
      ).toBeNull();

      // The child's first genuine turn lands seconds later and must count.
      const real = parseCodexLine(
        stamped("2026-08-01T05:00:06.000Z", tokenCount(300, 0, 30, 0)),
        state,
      );
      expect(real).not.toBeNull();
      expect(real?.totals.outputTokens).toBe(30);

      // Suppression never restarts, even for closely spaced later events.
      const next = parseCodexLine(
        stamped("2026-08-01T05:00:06.100Z", tokenCount(400, 0, 40, 0)),
        state,
      );
      expect(next).not.toBeNull();
    });

    it("recognizes subagent spawns without forked_from_id", () => {
      const state = initialCodexScanState();
      const spawnInstant = "2026-08-01T05:00:00.000Z";
      parseCodexLine(
        meta({ id: "child", timestamp: spawnInstant, spawnParentId: "parent" }),
        state,
      );
      parseCodexLine(stamped(spawnInstant, turnContext), state);
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.001Z", tokenCount(100, 0, 10, 0)), state),
      ).toBeNull();
    });

    it("does not suppress anything in a rollout that is not a fork", () => {
      const state = initialCodexScanState();
      parseCodexLine(meta({ id: "root", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(stamped("2026-08-01T05:00:00.100Z", turnContext), state);
      const record = parseCodexLine(
        stamped("2026-08-01T05:00:00.200Z", tokenCount(100, 0, 10, 0)),
        state,
      );
      expect(record).not.toBeNull();
    });
  });
});

describe("totalTokens", () => {
  it("does not add reasoning on top of output", () => {
    expect(
      totalTokens({
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 30,
        outputTokens: 40,
        reasoningTokens: 25,
      }),
    ).toBe(100);
  });
});

describe("parseGrokLine", () => {
  /** Shaped after a real Grok Build `turn_completed` session update. */
  function turnCompleted(overrides?: {
    sessionId?: string;
    promptId?: string;
    timestamp?: number;
    agentTimestampMs?: number;
    usage?: Record<string, unknown>;
    modelUsage?: Record<string, Record<string, unknown>> | null;
  }): string {
    const modelUsage =
      overrides && "modelUsage" in overrides
        ? overrides.modelUsage
        : {
            "grok-4.5-build": {
              inputTokens: 20_272,
              outputTokens: 272,
              totalTokens: 20_544,
              cachedReadTokens: 11_264,
              cacheCreationTokens: 0,
              reasoningTokens: 180,
              costUsdTicks: 230_272_000,
            },
          };

    return JSON.stringify({
      timestamp: overrides?.timestamp ?? 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: overrides?.sessionId ?? "019fec1a-12f7-72f2-9b1f-7778a00aea3c",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: overrides?.promptId ?? "prompt-1",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 20_272,
            outputTokens: 272,
            totalTokens: 20_544,
            cachedReadTokens: 11_264,
            cacheCreationTokens: 0,
            reasoningTokens: 180,
            costUsdTicks: 230_272_000,
            ...(modelUsage === null ? {} : { modelUsage }),
            ...overrides?.usage,
          },
        },
        _meta: {
          eventId: "event-1",
          agentTimestampMs: overrides?.agentTimestampMs ?? 1_786_372_566_485,
        },
      },
    });
  }

  it("extracts per-model totals and provider-reported cost ticks", () => {
    const records = parseGrokLine(turnCompleted());

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.provider).toBe("grok");
    expect(record?.model).toBe("grok-4.5-build");
    expect(record?.sessionId).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c");
    expect(record?.timestampMs).toBe(1_786_372_566_485);
    expect(record?.totals).toEqual({
      uncachedInputTokens: 20_272 - 11_264,
      cachedInputTokens: 11_264,
      cacheCreationTokens: 0,
      outputTokens: 272,
      reasoningTokens: 180,
    });
    expect(record?.reportedCostUsd).toBeCloseTo(230_272_000 / GROK_COST_USD_TICKS_PER_DOLLAR, 12);
    expect(record?.dedupeKey).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c:prompt-1:grok-4.5-build");
  });

  it("emits one record per model when modelUsage has several entries", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 1000,
            outputTokens: 50,
            cachedReadTokens: 400,
            reasoningTokens: 20,
            costUsdTicks: 50_000_000,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 200,
            outputTokens: 30,
            cachedReadTokens: 100,
            reasoningTokens: 0,
            costUsdTicks: 10_000_000,
          },
        },
      }),
    );

    expect(records.map((record) => record.model).toSorted()).toEqual([
      "grok-4.5",
      "grok-composer-2.5-fast",
    ]);
    expect(records.every((record) => record.provider === "grok")).toBe(true);
    expect(records.find((record) => record.model === "grok-4.5")?.reportedCostUsd).toBeCloseTo(
      0.005,
      12,
    );
  });

  it("inherits top-level cost ticks for a single model without its own ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5-build": {
            inputTokens: 1000,
            outputTokens: 10,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.reportedCostUsd).toBe(1);
  });

  it("falls back to a generic grok model when modelUsage is absent", () => {
    const records = parseGrokLine(turnCompleted({ modelUsage: null }));

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.provider).toBe("grok");
    expect(record?.model).toBe("grok");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 20_272 - 11_264,
      cachedInputTokens: 11_264,
      cacheCreationTokens: 0,
      outputTokens: 272,
      reasoningTokens: 180,
    });
    expect(record?.reportedCostUsd).toBeCloseTo(230_272_000 / GROK_COST_USD_TICKS_PER_DOLLAR, 12);
    expect(record?.dedupeKey).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c:prompt-1:grok");
  });

  it("pro-rates top-level cost ticks across multi-model turns without per-model ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.75, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.25, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("pro-rates aggregate cost when a zero-token sibling carries costUsdTicks: 0", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
          "empty-sibling": {
            inputTokens: 0,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            costUsdTicks: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    expect(records.every((record) => record.model !== "empty-sibling")).toBe(true);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.75, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.25, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("allocates leftover aggregate ticks to models that omit per-model ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            costUsdTicks: 0.4 * GROK_COST_USD_TICKS_PER_DOLLAR,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.4, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.6, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("does not invent a colliding dedupe key when prompt_id is missing", () => {
    const line = JSON.stringify({
      timestamp: 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            modelUsage: {
              "grok-4.5": { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
      },
    });

    expect(parseGrokLine(line)[0]?.dedupeKey).toBeNull();
  });

  it("ignores non-turn lines and empty usage", () => {
    expect(parseGrokLine(JSON.stringify({ method: "session/update", params: {} }))).toEqual([]);
    expect(parseGrokLine("not json")).toEqual([]);
    expect(
      parseGrokLine(
        turnCompleted({
          modelUsage: {
            "grok-4.5-build": {
              inputTokens: 0,
              outputTokens: 0,
              cachedReadTokens: 0,
              reasoningTokens: 0,
              costUsdTicks: 0,
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("falls back to the outer unix-seconds timestamp when agent meta is missing", () => {
    const line = JSON.stringify({
      timestamp: 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            modelUsage: {
              "grok-4.5": { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
      },
    });

    const records = parseGrokLine(line);
    expect(records[0]?.timestampMs).toBe(1_786_372_566_000);
  });
});
