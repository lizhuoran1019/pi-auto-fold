"""Offline PTY regression against the installed bundled CLI (Linux/macOS, Python 3)."""
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

EXTENSION = Path(__file__).resolve().parents[1]
PI = os.environ.get("PI_BIN") or shutil.which("pi")
assert PI, "pi executable not found; set PI_BIN"


def run(directory):
    config = directory / "config"
    config.mkdir()
    (config / "settings.json").write_text(json.dumps({"quietStartup": True, "hideThinkingBlock": True}))
    usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
             "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}

    def assistant(content: list[dict[str, object]], stop: str = "stop") -> dict[str, object]:
        return {"role": "assistant", "content": content, "stopReason": stop, "api": "openai-responses",
                "provider": "test", "model": "test", "timestamp": 1, "usage": usage}

    notice = (
        "[acp_delegate completed] **researcher** (runId `del_smoke_1`, exit 0) No delegates are currently running.\n\n"
        "This is an automated system notification, NOT a user message.\n\nTask: Fixture investigation\n\n"
        "Full result: `/tmp/acp-delegate/del_smoke_1.out`\n(use the `read` tool to open it if you need the details)\n"
    )
    messages: list[dict[str, object]] = [{"role": "user", "content": [{"type": "text", "text": "SMOKE USER"}], "timestamp": 1}]
    for number in (1, 2):
        messages.extend([
            assistant([{"type": "text", "text": "SMOKE PROGRESS"},
                       {"type": "toolCall", "id": f"call-{number}", "name": "bash", "arguments": {"command": "echo fixture"}}], "toolUse"),
            {"role": "toolResult", "toolCallId": f"call-{number}", "toolName": "bash",
             "content": [{"type": "text", "text": f"SMOKE TOOL {number}"}], "isError": False, "timestamp": 1},
        ])
        if number == 1:
            messages.append({"role": "user", "content": [{"type": "text", "text": notice}], "timestamp": 1})
    messages.append(assistant([{"type": "text", "text": "SMOKE FINAL"}]))
    stamp = "2026-01-01T00:00:00.000Z"
    entries: list[dict[str, object]] = [{"type": "session", "version": 3, "id": "11111111-1111-4111-8111-111111111111", "timestamp": stamp, "cwd": str(directory)}]
    entries.extend({"type": "message", "id": str(i), "parentId": str(i-1) if i else None, "timestamp": stamp, "message": msg}
                   for i, msg in enumerate(messages))
    fixture = directory / "fixture.jsonl"
    fixture.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
    env = {key: value for key, value in os.environ.items()
           if key not in ("PI_SESSION_ID", "PI_SESSION_FILE") and not key.endswith(("_API_KEY", "_AUTH_TOKEN", "_OAUTH_TOKEN"))}
    env.update(PI_CODING_AGENT_DIR=str(config), PI_OFFLINE="1", PI_TELEMETRY="0",
               AUTO_FOLD_SMOKE_DIR=str(directory), TERM="xterm-256color")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    command = [PI, "--tui-mode", "fullscreen", "--offline", "--no-extensions", "--no-mcp", "--no-skills",
               "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--session", str(fixture),
               "-e", str(EXTENSION), "-e", str(EXTENSION / "test" / "tui-probe.ts")]
    process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=directory, env=env, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def pump(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if process.poll() is not None:
                raise AssertionError(f"Pi exited early: {process.returncode}")
            if select.select([master], [], [], min(.05, max(0, end-time.monotonic())))[0]:
                chunk = os.read(master, 1_000_000)
                output.extend(chunk)
                if b"\x1b[6n" in chunk:
                    os.write(master, b"\x1b[1;1R")
                if b"\x1b[c" in chunk:
                    os.write(master, b"\x1b[?1;2c")

    def snapshot(label, command=None):
        target = directory / f"{label}.json"
        target.unlink(missing_ok=True)
        if command:
            os.write(master, command.encode() + b"\r")
            pump(.2)
            os.write(master, f"/fold-smoke {label}\r".encode())
        deadline = time.monotonic() + 12
        while not target.exists() and time.monotonic() < deadline:
            pump(.05)
        assert target.exists(), f"No {label} snapshot; terminal: {bytes(output[-3000:])!r}"
        result = json.loads(target.read_text())
        assert len(result["tools"]) == 2 and len(result["notices"]) == 1, result
        assert "SMOKE FINAL" in str(result["finals"]), result
        return result

    def collapsed(result):
        assert len(result["summaries"]) == 1, result
        assert all(not lines for lines in result["tools"] + result["notices"]), result

    def expanded(result):
        assert all("SMOKE TOOL" in str(lines) for lines in result["tools"]), result
        assert "acp_delegate completed" in str(result["notices"]), result

    try:
        collapsed(snapshot("startup"))
        expanded(snapshot("expanded", "/fold expand"))
        collapsed(snapshot("collapsed", "/fold collapse"))
        off = snapshot("off", "/fold off")
        expanded(off)
        assert not off["summaries"], off
        collapsed(snapshot("on", "/fold on"))
        (directory / "startup.json").unlink()
        os.write(master, b"/reload\r")
        collapsed(snapshot("startup"))
        print("PASS: bundled CLI/fullscreen PTY startup, notification grouping, expand, collapse, off/on, reload")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        os.close(master)


with tempfile.TemporaryDirectory(prefix="pi-auto-fold-tui-") as temporary:
    run(Path(temporary))
