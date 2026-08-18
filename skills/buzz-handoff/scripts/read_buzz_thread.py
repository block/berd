#!/usr/bin/env python3
"""Read the Buzz thread referenced by a buzz://message deep link."""

from __future__ import annotations

import json
import re
import sys
import uuid
from urllib.parse import parse_qs, urlparse

from buzz_runtime import fail, run_buzz_json

EVENT_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
ALLOWED_QUERY_KEYS = {"channel", "id", "thread"}


def parse_message_url(raw_url: str) -> tuple[str, str, str | None]:
    parsed = urlparse(raw_url.strip())
    if parsed.scheme != "buzz" or parsed.netloc != "message" or parsed.path not in {"", "/"}:
        fail("Expected a buzz://message URL.")
    if parsed.username or parsed.password or parsed.fragment:
        fail("Buzz message URL must not contain credentials or a fragment.")

    query = parse_qs(parsed.query, keep_blank_values=True)
    unknown = set(query) - ALLOWED_QUERY_KEYS
    if unknown:
        fail("Buzz message URL contains unsupported query parameters.")
    channel_values = query.get("channel", [])
    event_values = query.get("id", [])
    thread_values = query.get("thread", [])
    if len(channel_values) != 1 or not channel_values[0]:
        fail("Buzz message URL must contain exactly one channel parameter.")
    if len(event_values) != 1 or not event_values[0]:
        fail("Buzz message URL must contain exactly one id parameter.")
    if len(thread_values) > 1:
        fail("Buzz message URL may contain at most one thread parameter.")

    try:
        channel = str(uuid.UUID(channel_values[0]))
    except ValueError:
        fail("Buzz message URL contains an invalid channel UUID.")
    event_id = event_values[0].lower()
    if not EVENT_PATTERN.fullmatch(event_id):
        fail("Buzz message URL contains an invalid event ID.")
    thread_root_id = thread_values[0].lower() if thread_values else None
    if thread_root_id and not EVENT_PATTERN.fullmatch(thread_root_id):
        fail("Buzz message URL contains an invalid thread root ID.")
    return channel, event_id, thread_root_id


def main() -> None:
    if len(sys.argv) != 2:
        fail("Usage: read_buzz_thread.py '<buzz://message?...>'")

    source_url = sys.argv[1].strip()
    channel, event_id, thread_root_id = parse_message_url(source_url)
    query_event_id = thread_root_id or event_id
    messages = run_buzz_json(
        [
            "buzz",
            "messages",
            "thread",
            "--channel",
            channel,
            "--event",
            query_event_id,
            "--limit",
            "200",
        ]
    )
    if not isinstance(messages, list):
        fail("Buzz CLI returned an unexpected thread response.", 4)
    print(
        json.dumps(
            {
                "source_url": source_url,
                "channel": channel,
                "selected_event_id": event_id,
                "thread_root_id": thread_root_id,
                "messages": messages,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
