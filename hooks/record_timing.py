#!/usr/bin/env python3
"""Lightweight lifecycle telemetry hook for AGY Context.

Records millisecond-precision SessionStart / PreInvocation / PostToolUse /
PostInvocation / Stop events per conversation so the monitor can compute:
  - Live in-flight generation / tool status & elapsed timer
  - Exact millisecond duration & throughput for final model replies
  - Exact per-tool completion timestamps & host error reasons
  - Wall-clock turn duration, invocation depth, and termination reasons

Intentionally does NOT hook PreToolUse, so tool approval policies are untouched.
Never blocks, injects, or alters agent behavior. Always exits 0 with valid JSON.
"""

import json
import os
import re
import sys
import time

ID_RE = re.compile(r"^[a-zA-Z0-9_-]{4,128}$")


def resolve_data_root(payload):
    env_dir = os.environ.get("PLUGIN_DATA", "").strip()
    if env_dir:
        return env_dir
    tp = str(payload.get("transcriptPath") or "")
    if "/brain/" in tp:
        app_data = tp.split("/brain/", 1)[0]
        if app_data:
            return os.path.join(app_data, "plugin_data", "agy-context")
    return os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "plugin_data", "agy-context")


def main():
    ts_ms = int(time.time() * 1000)
    ev = ""
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw and raw.strip() else {}
        if not isinstance(payload, dict):
            payload = {}
        ev = str(payload.get("hookEventName") or "")
        conv_id = str(payload.get("conversationId") or "")
        if ev and ID_RE.match(conv_id):
            timings_dir = os.path.join(resolve_data_root(payload), "timings")
            os.makedirs(timings_dir, exist_ok=True)
            entry = {
                "ev": ev,
                "ts": ts_ms,
            }
            if payload.get("modelName"):
                entry["model"] = str(payload.get("modelName"))[:80]
            if payload.get("invocationNum") is not None:
                entry["inv"] = payload.get("invocationNum")
            if payload.get("initialNumSteps") is not None:
                entry["steps"] = payload.get("initialNumSteps")
            if payload.get("stepIdx") is not None:
                entry["step"] = payload.get("stepIdx")
            if payload.get("executionNum") is not None:
                entry["exec"] = payload.get("executionNum")
            tc = payload.get("toolCall")
            if isinstance(tc, dict):
                if tc.get("name"):
                    entry["tool"] = str(tc.get("name"))[:80]
                if tc.get("id"):
                    entry["toolId"] = str(tc.get("id"))[:80]
            if payload.get("terminationReason"):
                entry["reason"] = str(payload.get("terminationReason"))[:60]
            if payload.get("error"):
                entry["err"] = str(payload.get("error")).strip()[:240]
            if payload.get("fullyIdle") is not None:
                entry["idle"] = bool(payload.get("fullyIdle"))

            out_path = os.path.join(timings_dir, f"{conv_id}.jsonl")
            with open(out_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
    except Exception:
        # Telemetry must never fail or interfere with agent execution.
        pass

    if ev == "Stop":
        sys.stdout.write('{"decision":"allow"}\n')
    else:
        sys.stdout.write("{}\n")


if __name__ == "__main__":
    main()
