#!/usr/bin/env python3
"""Shared helpers for invoking Buzz without handling private credentials."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
import shutil
import subprocess
import sys
import threading
from typing import NoReturn
from urllib.parse import urlparse

READ_TIMEOUT_SECONDS = 30
WRITE_TIMEOUT_SECONDS = 30
MAX_OUTPUT_BYTES = 5 * 1024 * 1024


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: bytes
    exceeded_output_limit: bool


def fail(message: str, exit_code: int = 1) -> NoReturn:
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(exit_code)


def require_runtime() -> None:
    if shutil.which("buzz") is None:
        fail("The buzz CLI is not available on PATH.")
    if sys.version_info < (3, 10):
        fail("Buzz Handoff requires Python 3.10 or newer.")
    missing = [
        name
        for name in ("BUZZ_RELAY_URL", "BUZZ_PRIVATE_KEY")
        if not os.environ.get(name, "").strip()
    ]
    if missing:
        fail(
            "Buzz CLI configuration is missing: "
            + ", ".join(missing)
            + ". Configure it outside this conversation and retry.",
            3,
        )
    validate_relay(os.environ["BUZZ_RELAY_URL"])


def validate_relay(raw: str) -> None:
    parsed = urlparse(raw.strip())
    if parsed.scheme not in {"https", "wss", "http", "ws"} or not parsed.hostname:
        fail("BUZZ_RELAY_URL must be an http(s) or ws(s) URL with a host.", 3)
    if parsed.username or parsed.password or parsed.fragment:
        fail("BUZZ_RELAY_URL must not contain credentials or a fragment.", 3)
    if parsed.scheme in {"http", "ws"} and parsed.hostname not in {
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        fail("BUZZ_RELAY_URL must use secure transport unless it targets localhost.", 3)


def _safe_cli_error(returncode: int) -> str:
    if returncode == 1:
        return "Buzz rejected the command input."
    if returncode == 2:
        return "Buzz could not reach the configured relay."
    if returncode == 3:
        return "Buzz authentication failed. Check the configured identity and authorization."
    return "The Buzz CLI operation failed."


def run_bounded(
    command: list[str], *, input_bytes: bytes | None = None, timeout: int
) -> CommandResult:
    """Run a command while bounding each captured stream to MAX_OUTPUT_BYTES."""
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=os.environ.copy(),
        )
    except OSError:
        fail("The buzz CLI could not be started.", 4)

    streams: dict[str, bytearray] = {"stdout": bytearray(), "stderr": bytearray()}
    exceeded = threading.Event()

    def drain(name: str) -> None:
        stream = process.stdout if name == "stdout" else process.stderr
        assert stream is not None
        while chunk := stream.read(64 * 1024):
            remaining = MAX_OUTPUT_BYTES - len(streams[name])
            if remaining > 0:
                streams[name].extend(chunk[:remaining])
            if len(chunk) > remaining:
                exceeded.set()
                process.kill()
                return

    threads = [
        threading.Thread(target=drain, args=(name,), daemon=True)
        for name in ("stdout", "stderr")
    ]
    for thread in threads:
        thread.start()

    if input_bytes is not None:
        assert process.stdin is not None
        try:
            process.stdin.write(input_bytes)
            process.stdin.close()
        except BrokenPipeError:
            pass

    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        for thread in threads:
            thread.join()
        raise
    for thread in threads:
        thread.join()
    return CommandResult(process.returncode, bytes(streams["stdout"]), exceeded.is_set())


def run_buzz_json(
    command: list[str], *, timeout: int = READ_TIMEOUT_SECONDS
) -> object:
    require_runtime()
    try:
        result = run_bounded(command, timeout=timeout)
    except subprocess.TimeoutExpired:
        fail("The Buzz CLI operation timed out.", 2)

    if result.exceeded_output_limit:
        fail("The Buzz CLI response exceeded the 5 MiB safety limit.", 4)
    if result.returncode != 0:
        fail(_safe_cli_error(result.returncode), result.returncode)
    try:
        return json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Buzz CLI returned an unexpected response.", 4)
