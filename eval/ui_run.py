#!/usr/bin/env python3
"""Send one question through the UI backend (/api/run) and save the result.
   ui_run.py <ui-url> <title> <prompt-file> <timeout-sec> <events.jsonl> <stderr.txt>
Because the run goes through the UI backend, it shows up in the UI's conversation list.
Exit code: 0 finished without error, 1 run error, 2 could not start, 124 timeout."""
import json
import sys
import time
import urllib.error
import urllib.request

url, title, prompt_file, timeout, out_json, out_err = sys.argv[1:7]
timeout = int(timeout)


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


prompt = open(prompt_file, encoding="utf-8").read().strip()
deadline = time.time() + timeout
while True:  # the UI runs one agent at a time; wait while it is busy
    try:
        status, body = call("POST", "/api/run", {"prompt": prompt, "title": title})
    except OSError as error:
        open(out_err, "w").write(f"UI server unreachable: {error}\n")
        sys.exit(2)
    if status == 202:
        break
    if status != 409 or time.time() > deadline:
        open(out_err, "w").write(f"POST /api/run -> {status} {body}\n")
        sys.exit(2)
    time.sleep(3)

session_id = body["sessionId"]
while True:
    status, session = call("GET", f"/api/sessions/{session_id}")
    turn = session["turns"][0]
    if turn["finished"]:
        break
    if time.time() > deadline:
        open(out_err, "w").write("timeout waiting for the UI run\n")
        sys.exit(124)
    time.sleep(3)

with open(out_json, "w", encoding="utf-8") as out:
    for event in turn["events"]:
        out.write(json.dumps(event, ensure_ascii=False) + "\n")
open(out_err, "w").write((turn["error"] or "") + ("\n" if turn["error"] else ""))
sys.exit(1 if turn["error"] else 0)
