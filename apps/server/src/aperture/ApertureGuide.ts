export const APERTURE_GUIDE_TOPICS = ["overview", "widgets", "figures", "examples"] as const;

export type ApertureGuideTopic = (typeof APERTURE_GUIDE_TOPICS)[number];

const OVERVIEW = `# Aperture in KM Code

Aperture stores experiment runs and their metric history. These tools put its charts in this thread.

## Pick the tool
- Numbers you will state in prose: aperture_query. Only these numbers, or a rendered widget with the same asOf, may appear in your reply.
- A standard paper-style run-curves chart: aperture_figure_preview, then aperture_figure_render. Topic "figures" has the spec.
- Anything else (tables, quantile bands, custom layouts, several metrics): write a widget with aperture_widget_push, check it with aperture_widget_preview, show it with aperture_widget_render. Topic "widgets" has the API and "examples" has three working widgets.
- Static content that does not read Aperture data: html_render.

## Workflow
1. aperture_status: connection, default entity and project, widgetIdPrefix.
2. aperture_query: runs, keys, then history. Keep its asOf and pass it to the render tool.
3. Build the figure or widget and preview it. Read the screenshot, dataStatus, embedErrors, consoleMessages and failedRequests before rendering.
4. Render once. The reader gets a pinned view at asOf and can switch it to Live. Pass mode "live" only when the user asked for a live chart.
5. Reply in one or two sentences. Do not announce or repeat the rendered chart.

## Never
- Render after a failed compile, or when dataStatus is "empty".
- Quote a number you did not read from aperture_query or the widget at the same asOf.
- Make network requests from a widget. The sandbox blocks them.`;

const WIDGETS = `# Writing a widget

A widget is one TSX module. Push it, preview it, fix it, render it.

## Shape
\`\`\`tsx
import { defineWidget, useLiveHistory } from "@aperture/vis-renderers/widget-sdk"

export default defineWidget({
  id: "PREFIXmy-widget",
  title: "Human title",
  workspaces: "*",
  minHeight: 240,
  Component({ theme, panel }) {
    // theme: colors and fonts. panel: { width, height } in CSS pixels.
    return <p>hello</p>
  },
})
\`\`\`
- The id in defineWidget must equal the id you pass to aperture_widget_push, or the runtime refuses the module.
- Ids are PREFIX followed by a lowercase kebab-case slug, at most 63 characters in total. PREFIX is the widgetIdPrefix from aperture_status. Other prefixes are rejected.
- Pushing the same id again makes a new version. Renders you already made keep the version they were rendered with. aperture_widget_list shows this thread's widgets and aperture_widget_delete removes one; delete widgets you are done iterating on.

## Imports (anything else fails to compile)
- "react"
- "@aperture/vis-renderers/widget-sdk": defineWidget, useLiveHistory, useStream, the Plot kit, helpers.
- "@aperture/vis-core" and "@aperture/react": types and low-level exports. Prefer the widget-sdk re-exports.

## Data: useLiveHistory
\`useLiveHistory({ project: "ENTITY/PROJECT", runs: ["RUN_ID"], keys: ["METRIC_KEY"], samples: 300 })\`
- project is "entity/project" from aperture_status. runs are run ids from aperture_query; keys are metric keys or globs.
- Optional: x ("_step" default, "_runtime", "_timestamp"), samples (points per series, default 500), sampling ("lttb" default, or "raw" to keep every point; needed for rolling statistics), maxPoints.
- Returns { data, status, error, live, refetch }. data is null until the first response, then { series }. Each series is { run, key, step, x, y }, where step, x and y are Float64Array columns in step order.
- In a pinned render the widget reads history up to the asOf and no stream opens. In Live the same hook appends points as they are logged. Write the widget once; it must be correct in both.
- Handle the empty case: data null, series missing, or zero points. Show a short status line instead of an empty chart.

## Plot kit
\`\`\`tsx
<Plot theme={theme} x={{ domain: [xMin, xMax], follow: true }} ariaLabel="what the chart shows" fill style={{ width: "100%", height: "100%" }}>
  <Track id="main" frame y={{ domain: [yMin, yMax] }}>
    <AxisMark axis="x" />
    <AxisMark axis="y" title="metric" />
    <LinesMark series={[{ id: run, x, y }]} />
    <BandMark x={x} lower={lower} upper={upper} color={theme.color.accent} alpha={0.2} />
    <LineMark x={x} y={median} color={theme.color.accent} width={2} hero />
    <RuleMark axis="y" value={0} />
  </Track>
</Plot>
\`\`\`
- Compute explicit x and y domains from the data and pad y by about 5 percent. Domains must have min below max.
- Skip titles on the x axis; its title can collide with the tick labels.
- Helpers: rollingQuantile(values, window, p) returns a Float64Array, quantile(values, p), trailing(array, n).
- Mark props are typed; the compile diagnostics name any wrong prop.

## Styling
- The host supplies the background and the typeface. Use CSS variables: var(--plot-text), var(--plot-text-2), var(--plot-font-data), var(--plot-border), var(--plot-accent), var(--plot-space-3, 12px).
- Colors for marks come from the theme prop (theme.color.accent and the rest of theme.color). Never hard-code hex colors, so dark and light hosts both work.
- Fill the panel: height 100% and width 100%. minHeight is the floor.
- The chart follows the reader's active KM Code theme (Parchment, Dracula, and so on) with no work from you. Do not pass a theme to the render tools unless the user asked for a specific look; then pass an Aperture theme id such as "nature", "mint-terminal" or "parchment-dark" as theme.
- To style one widget yourself, override inside it: spread the prop (theme={{ ...theme, color: { ...theme.color, accent: "#c96442" } }}) or set CSS variables and inline styles. That wins over the host theme for what you change. There is no Tailwind in the runtime.

## Loop
1. aperture_widget_push. If diagnostics come back, each has a formatted "file:line:col: severity: text" and the offending lineText. Fix exactly those lines and push again. Stop after five attempts, explain the last diagnostics to the user, and do not preview or render.
2. aperture_widget_preview with the returned version. Check:
   - dataStatus "present": the history queries returned points. "empty": the queries worked but returned no points; fix runs, keys or the time range, do not render. "unknown": no history query ran or one failed; read failedRequests.
   - embedErrors: a thrown error in the widget (code widget_runtime) or a bad module.
   - consoleMessages: warnings and blocked requests.
   - the screenshot: axes, labels, clipping, empty plot area.
3. aperture_widget_render with id, version, title, height, and the asOf from aperture_query.

## Sandbox
The widget runs in a sandboxed frame with no network, no storage and no access to this page. A fetch fails by design. Data arrives only through useLiveHistory and useStream.`;

const FIGURES = `# Figure specs

aperture_figure_preview and aperture_figure_render take a spec for one run-curves chart:

\`\`\`json
{
  "preset": "custom",
  "size": { "widthIn": 5.5, "heightIn": 3.4, "widthPt": 396, "heightPt": 244.8 },
  "font": "sans",
  "palette": "current",
  "legend": "direct",
  "elementOffsets": {},
  "metricKey": "METRIC_KEY",
  "xRange": [0, 20000],
  "yRange": [0, 5],
  "visibleRunIds": ["RUN_ID"]
}
\`\`\`
- preset: one of neurips-full, neurips-half, icml-cvpr-single, icml-double, cvpr-double, ieee-single, ieee-double, nature-single, custom. A preset names a column width; size must carry widthIn and heightIn plus widthPt and heightPt (inches times 72).
- font: "serif" or "sans". palette: "current", "okabe-ito" or "greyscale". legend: "direct", "box" or "none".
- xRange and yRange: [min, max] with min below max, in data units. Read the real min, max and last step from aperture_query first.
- metricKey and visibleRunIds come from aperture_query.
- Optional data: { xAxis ("step", "relative-wall", "relative-process", "wall-time"), smoothing ({ kind: "none" } or { kind: "ema" | "twema", weight }), logX, yScaleMode ("auto-fit", "all-runs", "log", "symlog", "axis-break"), showOriginal, ignoreOutliers, aggregation ("full", "random"), grouped, groupAggregate ("mean", "median", "min", "max"), groupRange ("minmax", "stddev", "stderr", "none"), annotationKinds: [] }. Supply every field if you supply data.
- A malformed spec fails the preview with the reason. Fix it and preview again.
- Use a widget instead when you need rolling statistics, tables, several metrics side by side, or anything this spec cannot say.`;

const EXAMPLES = `# Working widgets

Replace ENTITY/PROJECT, RUN_ID and METRIC_KEY with real values from aperture_status and aperture_query, and use your own id. Each compiles and renders.

## 1. Table of the latest value per run
\`\`\`tsx
import { defineWidget, useLiveHistory } from "@aperture/vis-renderers/widget-sdk"

const RUNS = ["RUN_ID"]
const KEY = "METRIC_KEY"
const cell = { padding: "4px 8px", textAlign: "right" } as const

export default defineWidget({
  id: "PREFIXlatest-table",
  title: "Latest value per run",
  workspaces: "*",
  minHeight: 120,
  Component() {
    const history = useLiveHistory({ project: "ENTITY/PROJECT", runs: RUNS, keys: [KEY], samples: 50 })
    const series = history.data?.series ?? []
    if (series.length === 0) return <p role="status" style={{ color: "var(--plot-text-2)" }}>Waiting for data…</p>
    return <table style={{ width: "100%", borderCollapse: "collapse", color: "var(--plot-text)", fontFamily: "var(--plot-font-data)", fontSize: 13 }}>
      <thead><tr><th style={{ ...cell, textAlign: "left" }}>Run</th><th style={cell}>Step</th><th style={cell}>{KEY}</th></tr></thead>
      <tbody>{series.map((s) => {
        const last = s.step.length - 1
        return <tr key={s.run}>
          <td style={{ ...cell, textAlign: "left" }}>{s.run}</td>
          <td style={cell}>{last >= 0 ? s.step[last] : "–"}</td>
          <td style={cell}>{last >= 0 ? s.y[last].toFixed(3) : "–"}</td>
        </tr>
      })}</tbody>
    </table>
  },
})
\`\`\`

## 2. One line per run
\`\`\`tsx
import { AxisMark, LinesMark, Plot, Track, defineWidget, useLiveHistory } from "@aperture/vis-renderers/widget-sdk"

const RUNS = ["RUN_ID"]
const KEY = "METRIC_KEY"

export default defineWidget({
  id: "PREFIXmetric-lines",
  title: "Metric by run",
  workspaces: "*",
  minHeight: 260,
  Component({ theme }) {
    const history = useLiveHistory({ project: "ENTITY/PROJECT", runs: RUNS, keys: [KEY], samples: 300 })
    const series = (history.data?.series ?? []).filter((s) => s.x.length > 0)
    if (series.length === 0) return <p role="status" style={{ color: "var(--plot-text-2)" }}>Waiting for data…</p>
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity
    for (const s of series) for (let i = 0; i < s.x.length; i++) {
      xMin = Math.min(xMin, s.x[i]); xMax = Math.max(xMax, s.x[i])
      if (Number.isFinite(s.y[i])) { yMin = Math.min(yMin, s.y[i]); yMax = Math.max(yMax, s.y[i]) }
    }
    const pad = (yMax - yMin) * 0.05 || 1
    return <Plot theme={theme} x={{ domain: [xMin, Math.max(xMax, xMin + 1)], follow: true }} ariaLabel={KEY + " by run"} fill style={{ width: "100%", height: "100%" }}>
      <Track id="metric" frame y={{ domain: [yMin - pad, yMax + pad] }}>
        <AxisMark axis="x" />
        <AxisMark axis="y" title={KEY} />
        <LinesMark series={series.map((s) => ({ id: s.run, x: s.x, y: s.y }))} />
      </Track>
    </Plot>
  },
})
\`\`\`

## 3. Rolling quartile band (needs raw points)
\`\`\`tsx
import { AxisMark, BandMark, LineMark, Plot, Track, defineWidget, rollingQuantile, useLiveHistory } from "@aperture/vis-renderers/widget-sdk"

const RUN = "RUN_ID"
const KEY = "METRIC_KEY"
const WINDOW = 25

export default defineWidget({
  id: "PREFIXmetric-quartiles",
  title: "Rolling quartiles",
  workspaces: "*",
  minHeight: 260,
  Component({ theme }) {
    const history = useLiveHistory({ project: "ENTITY/PROJECT", runs: [RUN], keys: [KEY], samples: 400, sampling: "raw" })
    const series = history.data?.series[0]
    if (!series || series.x.length === 0) return <p role="status" style={{ color: "var(--plot-text-2)" }}>Waiting for data…</p>
    const lower = rollingQuantile(series.y, WINDOW, 0.25)
    const median = rollingQuantile(series.y, WINDOW, 0.5)
    const upper = rollingQuantile(series.y, WINDOW, 0.75)
    let yMin = Infinity, yMax = -Infinity
    for (let i = 0; i < lower.length; i++) {
      if (Number.isFinite(lower[i])) yMin = Math.min(yMin, lower[i])
      if (Number.isFinite(upper[i])) yMax = Math.max(yMax, upper[i])
    }
    const pad = (yMax - yMin) * 0.1 || 1
    const x = series.x
    return <Plot theme={theme} x={{ domain: [x[0], Math.max(x[x.length - 1], x[0] + 1)], follow: true }} ariaLabel={"Rolling quartiles of " + KEY} fill style={{ width: "100%", height: "100%" }}>
      <Track id="quartiles" frame y={{ domain: [yMin - pad, yMax + pad] }}>
        <AxisMark axis="x" />
        <AxisMark axis="y" title={KEY + " (window " + WINDOW + ")"} />
        <BandMark x={x} lower={lower} upper={upper} color={theme.color.accent} alpha={0.2} />
        <LineMark x={x} y={median} color={theme.color.accent} width={2} hero />
      </Track>
    </Plot>
  },
})
\`\`\``;

const TOPIC_TEXT: Readonly<Record<ApertureGuideTopic, string>> = {
  overview: OVERVIEW,
  widgets: WIDGETS,
  figures: FIGURES,
  examples: EXAMPLES,
};

/** The guide for one topic, with PREFIX replaced by the caller thread's widget id prefix. */
export const apertureGuideText = (topic: ApertureGuideTopic, widgetIdPrefix: string): string =>
  TOPIC_TEXT[topic].replaceAll("PREFIX", widgetIdPrefix);
