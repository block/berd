#!/usr/bin/env python3
"""Preview or send one explicitly approved Buzz message."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import uuid

from buzz_runtime import WRITE_TIMEOUT_SECONDS, fail, require_runtime, run_bounded

EVENT_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
MAX_CONTENT_BYTES = 100_000


def canonical_channel(raw: str) -> str:
    try:
        parsed = uuid.UUID(raw)
    except ValueError:
        fail("Expected a Buzz channel UUID.")
    if str(parsed) != raw.lower():
        fail("Expected a canonical Buzz channel UUID.")
    return str(parsed)


def approval_digest(channel: str, reply_to: str | None, content: bytes) -> str:
    payload = b"buzz-handoff-v1\0" + channel.encode() + b"\0"
    payload += (reply_to or "").encode() + b"\0" + content
    return hashlib.sha256(payload).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--channel", required=True)
    parser.add_argument("--reply-to")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preview", action="store_true")
    mode.add_argument("--approved-sha256")
    args = parser.parse_args()

    require_runtime()
    channel = canonical_channel(args.channel)
    reply_to = args.reply_to.lower() if args.reply_to else None
    if reply_to and not EVENT_PATTERN.fullmatch(reply_to):
        fail("--reply-to must be a 64-character hexadecimal event ID.")

    content = sys.stdin.buffer.read(MAX_CONTENT_BYTES + 1)
    if len(content) > MAX_CONTENT_BYTES:
        fail("Message content exceeds the 100,000-byte safety limit.")
    if not content.strip():
        fail("Message content is empty.")
    try:
        content.decode("utf-8")
    except UnicodeDecodeError:
        fail("Message content must be valid UTF-8.")

    digest = approval_digest(channel, reply_to, content)
    if args.preview:
        print(
            json.dumps(
                {
                    "channel": channel,
                    "reply_to": reply_to,
                    "content": content.decode("utf-8"),
                    "approved_sha256": digest,
                },
                ensure_ascii=False,
            )
        )
        return
    if args.approved_sha256 != digest:
        fail("Approval digest does not match the exact message and destination.")

    command = [
        "buzz",
        "messages",
        "send",
        "--channel",
        channel,
        "--content",
        "-",
    ]
    if reply_to:
        command += ["--reply-to", reply_to]

    try:
        result = run_bounded(
            command, input_bytes=content, timeout=WRITE_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired:
        fail(
            "Posting outcome is unknown because Buzz timed out. Verify in Buzz before retrying.",
            2,
        )

    if result.exceeded_output_limit:
        fail(
            "Buzz may have posted the message but returned too much output. Verify in Buzz before retrying.",
            4,
        )
    if result.returncode != 0:
        fail(
            "Buzz did not confirm the post. Its outcome may be unknown; verify in Buzz before retrying.",
            result.returncode,
        )
    try:
        response = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail(
            "Buzz may have posted the message but returned an unexpected response. Verify in Buzz before retrying.",
            4,
        )
    print(json.dumps({"posted": True, "result": response}, ensure_ascii=False))


if __name__ == "__main__":
    main()
