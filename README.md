# AGY Context

An Antigravity plugin (sidecar UI extension + lightweight lifecycle hooks) that docks in the right auxiliary pane to monitor real-time session context occupancy, full interaction traces, and project/global token analytics.

## Features

### Context (`Session | Project | Global`)
- **Adaptive Context Occupancy**: Full-window horizontal context bar with remaining free space, cache hit rate, and output speed (`tok/s`). Defaults to `500k` per session, locks to the first observed compaction peak once compaction occurs, and automatically extends if a session grows past its ceiling without compacting.
- **Expandable Context Breakdown**: Categories sorted descending by token usage (with free space pinned at the bottom). Expand any category to inspect individual files, skills, injected blocks, user messages, tool outputs, active rule files (`AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md`), or per-model usage.
- **Per-Model Telemetry**: Token totals, call counts, cache hit rate, and measured output speed broken down by model ID across Session, Project, and Global scopes.
- **Turn Execution & Live Timer**: Powered by lightweight read-only lifecycle hooks (`SessionStart`, `PreInvocation`, `PostToolUse`, `PostInvocation`, `Stop`), showing a live in-flight timer (`Generating` / `Tools`) in the top bar, exact final-reply latency & throughput, turn averages, loop depth, tool error rate, and stop-reason breakdown.
- **Context Trend & Recent Trace**: Stacked bar or curve chart tracking context growth and compaction events per model call, plus a reverse-chronological live feed of the latest trace events.
- **Project & Global Insights**: Workspace-scoped and cross-workspace dashboards featuring adaptive usage charts (`hour` / `day` / `week` / `month` / `year`), interactive calendar heatmap, ranked skills/tools/commands, and searchable session cards.

### Trace (Dedicated Side Pane)
- **Standalone Auxiliary Tab**: Open **Trace** alongside **Context** from the `+` or **Extensions** menu to watch requests and tool calls stream live.
- **Multi-Select Type Toggles**: Toggle visibility for `Input`, `Injected`, `Skill`, `Model`, `Tool`, and `Error`, with `ADDITIONAL_METADATA` time injections automatically tagged as `Time Context`.
- **3-Track Mini Timeline**: Sticky left lane labels (`Input` / `Model` / `Tool`) with auto-scrolling clickable event cells.
- **Rich Master-Detail Inspector**: Multi-tag model rows (`Thinking`, `toolcall`, `output`), click-to-toggle detail drawer (top/bottom in portrait, left/right in landscape), in-place expandable Markdown preview, raw content blocks, tool arguments/results, host errors, and request timing.

### Customization
- **Bilingual UI**: English by default with a persistent `EN / 简` switcher in the top bar.
- **Native Theme Sync**: Automatically follows Antigravity's light and dark themes.
- **Settings**: Configure language, refresh interval, default view, and check for GitHub releases.

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

- **Local-only sidecar & hooks**: Reads local conversation transcripts under `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/` and stores lightweight timing telemetry under `$PLUGIN_DATA/timings/`. Never modifies conversation files or intercepts tool approval permissions.
- **Zero external runtime dependencies**: Runs directly on Antigravity's bundled Node.js runtime (`sidecar_sdk`) and system `python3`.

## License

Licensed under the [Apache License 2.0](./LICENSE).
