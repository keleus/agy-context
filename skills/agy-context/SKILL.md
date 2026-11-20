---
name: agy-context
description: Open the AGY Context live monitor panel in the right auxiliary pane to inspect current session context occupancy, token composition breakdown, and global Antigravity context insights. Use when the user asks about context usage, token consumption, cache hit rate, or wants to open the context sidebar.
---

# AGY Context

This plugin provides a real-time **Context** panel in Antigravity's right-hand auxiliary side pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`).

## Opening the Panels

This plugin registers two independent auxiliary pane views:

- **Context** (`Session | Project | Global`): `[Context](sidecar://agy-context/context_monitor/)`
- **Trace** (live auto-scrolling chronological execution & tool call history): `[Trace](sidecar://agy-context/context_monitor/trace)`

Deep links into specific Context scopes:

- Current session: `[Session Context](sidecar://agy-context/context_monitor/?tab=session)`
- Current project: `[Project Context](sidecar://agy-context/context_monitor/?tab=project)`
- Global overview: `[Global Context](sidecar://agy-context/context_monitor/?tab=global)`

## What It Shows

1. **当前会话 (Current Session)**: Real-time context window occupancy ring & percentage, 8-category token composition bar & breakdown, context growth curve (with compaction detection), cache hit rate, estimated cost, timing & output speed, plus skills/tools/commands used in this session.
2. **全局洞察 (Overview)**: Cross-session dashboard with date range filters (`今天` / `近 7 天` / `近 30 天` / `全部`), 6 KPI cards, daily token & cost bar chart, token & duration donut charts, interactive activity heatmap, ranked skill/tool/command usage, and searchable/sortable session cards with one-click jump to conversation.
