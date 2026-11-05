# Aperture charts and widgets

If you track training runs in [Aperture](https://github.com/Zyphra/aperture), agents can read those runs and answer with live charts inside the thread. Ask "show the train/loss curves for run 7hjxw8ew" or "make a live table of the latest value of every metric", and the chart or table appears in place of a plain tool call. It works with every provider, on web and desktop.

## Connect

Open **Settings → Integrations → Aperture**, turn on **Enable Aperture**, then fill in:

- **API URL**: where your Aperture API listens.
- **Web URL**: where its web app serves the chart runtime. KM Code downloads the runtime from here once and checks its hash before using it.
- **Default entity** and **Default project**: what agents use when you do not name one.
- **API key**: a read key for your Aperture. KM Code keeps it in its server secret store, so it never appears in `settings.json`, in a thread, or in an agent's context.

**Test connection** reports who the key belongs to and how many projects it can see. Agents only get the Aperture tools while the setting is on. Turning it off removes them without a restart.

The runtime has to be reachable at least the first time. After that KM Code keeps its own copy, so threads keep rendering if Aperture goes down. Rows show "Aperture is unreachable from KM Code." while it is down and recover on their own when it returns.

## What agents can show

- **Figures**: Aperture's standard charts, such as run curves and sweeps.
- **Widgets**: small custom views an agent writes for the question, such as rolling quartiles or a per-run table of the latest metrics.

Every row has a title, a pinned or live label, and a link that opens the same view in Aperture.

**Pinned** rows show the data as it was at the time shown in the label. Re-opening the thread later gives the same picture. **Live** rows stream new points. A thread keeps at most two live rows running at a time, and only while they are on screen. Others show "Live · paused" until you scroll to them or turn another off. Use the toggle on a row to switch it.

## Themes

Charts follow the active KM Code theme and its light or dark mode, and repaint when you switch. Parchment light and dark have matching Aperture themes. For other themes KM Code sends its own colours. An agent can pick a specific Aperture theme for a row, and that choice wins over yours.

## Safety

Widget code is written by the agent, so KM Code treats it as untrusted.

- The page that draws a widget is sandboxed away from KM Code. It cannot read your session, cookies, or the rest of the app, and it cannot make network requests of its own.
- The widget's own logic runs in a separate small interpreter that has no browser objects at all: no `window`, `document`, `fetch`, or `location`. It can only describe what to draw, using a fixed set of text elements and Aperture's chart parts. KM Code draws those parts itself.
- Data comes from the pinned or live queries KM Code makes on its behalf. Those are read-only, limited to the project you configured, and capped in size and in concurrent streams.
- A widget that loops, allocates too much, or recurses too deeply is stopped and shows "Widget failed to render." Chart columns are limited to 10,000 points. Agents are told to downsample longer histories.
- Widgets cannot contain buttons, links, forms, or images. Only the row's own link opens anything.

Rows saved by an older build that used a different widget runtime show "Widget module could not be loaded." The agent can re-render them.

## Other surfaces

- **Terminal-style transcripts** (Minimal and Minimal+ styles) show a single line, `Aperture figure · <title> · pinned <time> · open in Aperture`, with the link.
- **Mobile** shows the same text row with a link that opens Aperture in the browser. It does not draw the chart.

## For agents

Agents learn the tools from `aperture_guide`, which covers figures, widgets, and three worked examples. `aperture_status` reports the connection, projects, and the widget id prefix for the thread. Widget ids must start with that prefix, so one thread cannot overwrite another's widgets.
