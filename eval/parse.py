#!/usr/bin/env python3
"""Turn `opencode run --format json` events into a readable Markdown report.
   parse.py <events.json> > report.md"""
import json
import sys

texts, lines = [], []
for raw in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        e = json.loads(raw)
    except ValueError:
        continue
    part = e.get("part", {})
    if e.get("type") == "tool_use":
        st = part.get("state", {})
        inp = json.dumps(st.get("input"), ensure_ascii=False)[:200]
        out = (st.get("output") or st.get("error") or "").replace("\n", " ")[:160]
        lines.append(f"- `{part.get('tool')}` [{st.get('status')}] {inp} → {out}")
    elif e.get("type") == "text":
        texts.append(part.get("text", ""))
    elif e.get("type") == "error":
        lines.append(f"- **error** {json.dumps(e, ensure_ascii=False)[:300]}")

print("### 도구 호출\n")
print("\n".join(lines) or "(없음)")
print("\n### 최종 답변\n")
print("\n".join(t.strip() for t in texts if t.strip()) or "(답변 없음)")
