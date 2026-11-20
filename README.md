# AGY Context

An Antigravity plugin (sidecar UI extension + lightweight lifecycle hooks) that docks in the right auxiliary pane to monitor real-time session context occupancy, full interaction traces, and project/global token analytics.

## Features

### Context (`Session | Project | Global`)
- **Adaptive Context Occupancy & Ring Gauge**: Circular occupancy gauge (`≥80%` amber warning, `≥90%` red critical), full-window horizontal bar with free space, cache hit rate, compaction counter, and real-time latest-call speed in the top bar. Defaults to `500k` per session, adapts to observed compaction ceilings, and tracks the historical session peak when exceeded.
- **Current-Window Context Breakdown**: Mutually exclusive breakdown of live context occupancy across `System prompt`, `System tools`, `User messages` (merged by `Text input`, `Image input`, `File / Media`), `Injected context` (grouped by `Time`, `Image`, `Compaction`, `Settings`, `Other`), `Skills` (merged by skill name), `Tool results` (split by tool name & success/error), and per-model output (`Thinking` & `Text output`) with post-compaction average speed.
- **Session Telemetry & Breakdowns**: 4-metric KPI strip (`Total Tokens`, `Cache Read`, `Output`, `Active Time` with `avg` & `max` `tok/s`), **Models**, **Token Breakdown** (cumulative session totals), **Time Breakdown**, **Context Trend** (smooth Bezier curve cleanly broken at every compaction drop), **Tool Execution** (succeeded/failed counts, ratio bar, total & average duration), and **Recent Trace**.
- **Project & Global Insights**: Workspace-scoped and cross-workspace dashboards featuring a free `Start → End` date range picker + quick presets (`Today`, `7d`, `30d`, `All`), adaptive usage charts (`hour` / `day` / `week` / `month` / `year`), **Token & Time Breakdown**, **Models**, **Tool Execution**, ranked **Skills / Tools / Commands** (sorted by `Count`, `Time`, or `Context`), and searchable session cards with one-click jump.

### Trace (Dedicated Side Pane)
- **Standalone Auxiliary Tab**: Open **Trace** alongside **Context** from the `+` or **Extensions** menu to watch requests and tool calls stream live.
- **3-Track Timeline Strip**: Fixed left lane labels (`Input` / `Model` / `Tool`) with vertical grey dashed divider lines for **Context Compaction** events and dimmed markers for **Reverted** branches.
- **Exclusive Type Toggles & Revert Detection**: Independently filter `Input`, `Injected`, `Skill`, `Model`, `Tool`, `Compaction`, and `Error`, with automatic detection and `Reverted` badge / strikethrough marking for superseded branches.
- **Progressive History Loading & Live Generation**: Automatically loads earlier history as you scroll back to Step `#0`, while displaying a pulsing live generating row at the bottom during active model calls.
- **Master-Detail Inspector**: Multi-tag model rows (`Thinking`, `Tool Call`, `Output`), click-to-toggle detail drawer, in-place expandable Markdown preview, raw content blocks, tool arguments/results, host errors, and real measured request timing.

### Customization & Self-Update
- **Bilingual UI & Theme Sync**: English and Simplified Chinese (`EN / 简`), automatically matching Antigravity's light and dark themes.
- **Context Modules & Order Editor**: Show/hide and drag-or-move modules independently for both **Session** and **Project & Global**, with responsive 2-column independent-stack layout on wide screens.
- **Disk-Persisted Settings**: Stored atomically in `$PLUGIN_DATA/settings.json` so preferences survive disable/enable, restarts, and updates.
- **One-Click Self-Update**: Automatically checks GitHub Releases and updates + reloads in-place.

## Installation

### From GitHub (via Antigravity CLI)

```bash
agy plugin install https://github.com/keleus/agy-context
```

### From Local Repository

```bash
git clone https://github.com/keleus/agy-context.git
cd agy-context
./install.sh --link   # symlink into ~/.gemini/config/plugins/agy-context
# or
./install.sh --copy   # copy into ~/.gemini/config/plugins/agy-context
```

To uninstall:

```bash
./install.sh --uninstall
```

## Usage

1. Confirm **AGY Context** is enabled under **Skills & Customizations -> Plugins** in Antigravity.
2. Open **Context** (`Session | Project | Global`) and/or **Trace** (live interaction history) from the conversation header's `+` menu or **Overview -> Extensions**.
3. Both views share one lightweight background sidecar and automatically track the active conversation.

## Privacy & Architecture

- **Local-only sidecar & hooks**: Reads local conversation transcripts under `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/` and stores lightweight timing telemetry & settings under `$PLUGIN_DATA/`. Never modifies conversation files or intercepts tool approval permissions.
- **Zero external runtime dependencies**: Runs directly on Antigravity's bundled Node.js runtime (`sidecar_sdk`) and system `python3`.

## License

Licensed under the [Apache License 2.0](./LICENSE).
