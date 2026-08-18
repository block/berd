#!/usr/bin/env python3
"""Read recent messages and metadata from a configured Buzz channel."""

from __future__ import annotations

import argparse
import json
import uuid

from buzz_runtime import fail, run_buzz_json


def channel_uuid(raw: str) -> str:
    try:
        parsed = uuid.UUID(raw)
    except ValueError:
        fail("Expected a Buzz channel UUID.")
    if str(parsed) != raw.lower():
        fail("Expected a canonical Buzz channel UUID.")
    return str(parsed)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("channel")
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    channel = channel_uuid(args.channel)
    if not 1 <= args.limit <= 200:
        fail("--limit must be between 1 and 200.")

    metadata = run_buzz_json(
        ["buzz", "channels", "get", "--channel", channel]
    )
    if not isinstance(metadata, dict) or not metadata:
        fail("The configured Buzz relay does not contain that channel.", 2)
    messages = run_buzz_json(
        [
            "buzz",
            "messages",
            "get",
            "--channel",
            channel,
            "--limit",
            str(args.limit),
        ]
    )
    if not isinstance(messages, list):
        fail("Buzz CLI returned an unexpected message list.", 4)

    print(
        json.dumps(
            {"channel": metadata, "messages": messages},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
