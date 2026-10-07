#!/usr/bin/env python3
"""TrustRoute Korea UI backend.

The host image has Python but not Node. This standard-library server preserves the
same security boundary as the Node design: OpenShell is executed with an argv list
and shell=False, and OpenCode JSONL is forwarded to the browser over SSE.
"""
from __future__ import annotations

import json
import mimetypes
import os
import queue
import re
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_DIR = ROOT / "ui" / "public"
SANDBOX = "k-culture-agent"
PORT = int(os.environ.get("PORT", "3000"))
RUNS: dict[str, "Run"] = {}
RUNS_LOCK = threading.Lock()
ACTIVE_RUN_ID: str | None = None


@dataclass
class Run:
    id: str
    prompt: str
    events: list[dict[str, Any]] = field(default_factory=list)
    clients: set[queue.Queue] = field(default_factory=set)
    finished: bool = False
    error: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def emit(self, event_type: str, data: Any) -> None:
        event = {"type": event_type, "data": data, "at": int(time.time() * 1000)}
        with self.lock:
            self.events.append(event)
            for client in list(self.clients):
                client.put(event)

    def finish(self, error: str | None = None) -> None:
        global ACTIVE_RUN_ID
        with self.lock:
            if self.finished:
                return
            self.finished, self.error = True, error
        self.emit("complete", {"ok": error is None, "error": error})
        with RUNS_LOCK:
            if ACTIVE_RUN_ID == self.id:
                ACTIVE_RUN_ID = None


def command(command: str, args: list[str], timeout: int = 15) -> tuple[bool, str, str]:
    """Run a fixed command without a shell; input is never interpolated."""
    try:
        completed = subprocess.run(
            [command, *args], capture_output=True, text=True, timeout=timeout, shell=False
        )
        return completed.returncode == 0, completed.stdout, completed.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, "", str(error)


def start_run(prompt: str) -> Run:
    global ACTIVE_RUN_ID
    run = Run(id=str(uuid.uuid4()), prompt=prompt)
    with RUNS_LOCK:
        RUNS[run.id] = run
        ACTIVE_RUN_ID = run.id
    run.emit("status", {"state": "running"})

    def execute() -> None:
        # `prompt` remains one exact argv item. There is deliberately no shell.
        argv = [
            "openshell", "sandbox", "exec", "-n", SANDBOX, "--",
            "opencode", "run", "--format", "json", "--dir", "/workspace/app",
            "--agent", "k-culture", prompt,
        ]
        try:
            process = subprocess.Popen(
                argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                bufsize=1, shell=False,
            )
        except OSError as error:
            run.finish(f"Could not start OpenShell: {error}")
            return
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                run.emit("opencode", json.loads(line))
            except json.JSONDecodeError:
                run.emit("runtime", {"message": line})
        stderr = process.stderr.read().strip() if process.stderr else ""
        exit_code = process.wait()
        run.finish(None if exit_code == 0 else (stderr or f"OpenCode exited with code {exit_code}"))

    threading.Thread(target=execute, daemon=True, name=f"agent-run-{run.id[:8]}").start()
    return run


def yaml_list(policy: str, name: str) -> list[str]:
    match = re.search(rf"{re.escape(name)}:\n((?:\s+- .+\n?)+)", policy)
    return re.findall(r"^\s+-\s+(.+)$", match.group(1), re.MULTILINE) if match else []


def security_data() -> dict[str, Any]:
    ok, stdout, stderr = command("openshell", ["policy", "get", SANDBOX, "--full"])
    if not ok:
        return {"ok": False, "error": stderr or "Could not read OpenShell policy"}
    policy = stdout.split("---", 1)[-1]
    endpoints = [
        {"host": host, "port": int(port)}
        for host, port in re.findall(r"- host: ([^\n]+)\n\s+port: (\d+)", policy)
    ]
    try:
        agent = (ROOT / "app/.opencode/agents/k-culture.md").read_text(encoding="utf-8")
    except OSError:
        agent = ""
    custom_tools = '"culture_*": allow' in agent
    return {
        "ok": True,
        "policy": {
            "filesystem": {
                "readOnly": yaml_list(policy, "read_only"),
                "readWrite": yaml_list(policy, "read_write"),
                "restrictedByAllowlist": "/workspace/hackathon/restricted" not in policy
                and "/workspace/hackathon/secrets" not in policy,
            },
            "network": {"endpoints": endpoints},
        },
        "agent": {"customToolsOnly": custom_tools, "guardrails": custom_tools},
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "TrustRouteKorea/1.0"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def json_response(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/run":
            self.json_response(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > 10000:
                raise ValueError
            body = json.loads(self.rfile.read(size) or b"{}")
            prompt = body.get("prompt", "").strip() if isinstance(body, dict) else ""
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            self.json_response(HTTPStatus.BAD_REQUEST, {"error": "Invalid request body"})
            return
        if not isinstance(prompt, str) or not prompt or len(prompt) > 4000:
            self.json_response(HTTPStatus.BAD_REQUEST, {"error": "Enter a goal up to 4,000 characters."})
            return
        with RUNS_LOCK:
            busy = ACTIVE_RUN_ID is not None
        if busy:
            self.json_response(HTTPStatus.CONFLICT, {"error": "An agent run is already in progress."})
            return
        run = start_run(prompt)
        self.json_response(HTTPStatus.ACCEPTED, {"runId": run.id})

    def do_GET(self) -> None:
        route = urlparse(self.path).path
        if route == "/api/health":
            ok, _, _ = command("openshell", ["sandbox", "get", SANDBOX])
            self.json_response(HTTPStatus.OK if ok else HTTPStatus.SERVICE_UNAVAILABLE, {"ok": ok, "sandbox": SANDBOX})
            return
        if route == "/api/security":
            self.json_response(HTTPStatus.OK, security_data())
            return
        match = re.fullmatch(r"/api/runs/([\w-]+)/events", route)
        if match:
            with RUNS_LOCK:
                run = RUNS.get(match.group(1))
            if not run:
                self.json_response(HTTPStatus.NOT_FOUND, {"error": "Run not found"})
            else:
                self.stream_events(run)
            return
        self.serve_static(route)

    def stream_events(self, run: Run) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        subscriber: queue.Queue = queue.Queue()
        try:
            with run.lock:
                replay = list(run.events)
                finished = run.finished
                if not finished:
                    run.clients.add(subscriber)
            for event in replay:
                self.write_event(event)
            if finished:
                return
            while True:
                try:
                    event = subscriber.get(timeout=15)
                    self.write_event(event)
                    if event["type"] == "complete":
                        break
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with run.lock:
                run.clients.discard(subscriber)

    def write_event(self, event: dict[str, Any]) -> None:
        payload = json.dumps(event["data"], ensure_ascii=False)
        self.wfile.write(f"event: {event['type']}\ndata: {payload}\n\n".encode("utf-8"))
        self.wfile.flush()

    def serve_static(self, route: str) -> None:
        filename = "index.html" if route == "/" else Path(route).name
        if filename not in {"index.html", "app.js", "styles.css"}:
            self.json_response(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        target = PUBLIC_DIR / filename
        try:
            data = target.read_bytes()
        except OSError:
            self.json_response(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"TrustRoute Korea UI listening on http://0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
