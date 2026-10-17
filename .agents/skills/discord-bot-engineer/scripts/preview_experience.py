#!/usr/bin/env python3
"""Render a static, clearly labelled approximation of a Discord UX decision."""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("decision", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = json.loads(args.decision.read_text(encoding="utf-8"))
    title = html.escape(str(data.get("panel", "Discord panel")).replace("_", " ").title())
    surface = html.escape(str(data.get("surface", "unknown")))
    loading = html.escape(str(data.get("loading", {}).get("pattern", "none")))
    required = [html.escape(str(item).replace("_", " ")) for item in data.get("panel_contract", {}).get("requires", [])]
    states = [html.escape(str(item).replace("_", " ")) for item in data.get("states", [])]
    required_html = "".join(f"<li>{item}</li>" for item in required) or "<li>No panel anatomy supplied</li>"
    states_html = "".join(f"<span class='chip'>{item}</span>" for item in states) or "<span class='chip'>No states supplied</span>"
    body = f"""<!doctype html><html lang='en'><meta charset='utf-8'><meta name='viewport' content='width=device-width'><title>{title}</title>
<style>:root{{color-scheme:dark}}body{{margin:0;background:#111214;color:#f2f3f5;font:15px system-ui;display:grid;place-items:center;min-height:100vh}}main{{width:min(680px,90vw)}}.note,.label{{color:#b5bac1}}.panel{{background:#2b2d31;border-left:4px solid #5865f2;border-radius:4px;padding:20px;box-shadow:0 8px 30px #0006}}h1{{font-size:20px;margin:0 0 8px}}dl{{display:grid;grid-template-columns:120px 1fr;gap:8px;margin:18px 0}}dt{{color:#b5bac1}}dd{{margin:0}}ul{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;padding-left:20px}}.states{{display:flex;gap:6px;flex-wrap:wrap}}.chip{{background:#1e1f22;border:1px solid #3f4147;border-radius:999px;padding:5px 9px}}button{{border:0;border-radius:4px;background:#5865f2;color:white;padding:10px 14px;font-weight:650}}@media(prefers-reduced-motion:no-preference){{button{{transition:filter .15s,transform .15s}}button:hover{{filter:brightness(1.1);transform:translateY(-1px)}}}}</style>
<main><p class='note'>Static design-review approximation — not a Discord client screenshot.</p><section class='panel'><h1>{title}</h1><p>Review the selected surface, required anatomy, loading policy, and reachable states before writing final copy.</p><dl><dt>Surface</dt><dd>{surface}</dd><dt>Loading</dt><dd>{loading}</dd><dt>Progress</dt><dd>Only real work units; never a fake percentage.</dd></dl><p class='label'>Required anatomy</p><ul>{required_html}</ul><p class='label'>Reachable states</p><div class='states'>{states_html}</div><p><button>Primary action</button></p></section></main></html>"""
    args.output.write_text(body, encoding="utf-8")
    print(args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
