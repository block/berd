#!/usr/bin/env python3
"""Dependency-free tests for the public Buzz Handoff helpers."""

from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import buzz_runtime
import post_message
import read_buzz_channel
import read_buzz_thread

CHANNEL = "123e4567-e89b-12d3-a456-426614174000"
EVENT = "a" * 64


class BuzzRuntimeTests(unittest.TestCase):
    def test_runtime_requires_configuration_without_exposing_values(self) -> None:
        with patch.object(buzz_runtime.shutil, "which", return_value="/bin/buzz"):
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(SystemExit):
                    buzz_runtime.require_runtime()

    def test_relay_rejects_credentials(self) -> None:
        with self.assertRaises(SystemExit):
            buzz_runtime.validate_relay("https://secret@example.com")

    def test_insecure_remote_relay_is_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            buzz_runtime.validate_relay("http://example.com")

    def test_localhost_relay_is_allowed(self) -> None:
        buzz_runtime.validate_relay("http://localhost:3000")

    def test_cli_errors_are_redacted(self) -> None:
        completed = buzz_runtime.CommandResult(3, b"", False)
        with patch.object(buzz_runtime, "require_runtime"):
            with patch.object(buzz_runtime, "run_bounded", return_value=completed):
                stderr = io.StringIO()
                with patch("sys.stderr", stderr), self.assertRaises(SystemExit):
                    buzz_runtime.run_buzz_json(["buzz", "messages", "get"])
        self.assertNotIn("secret-private-key", stderr.getvalue())

    def test_read_output_limit_fails_before_json_parsing(self) -> None:
        completed = buzz_runtime.CommandResult(1, b"{", True)
        with patch.object(buzz_runtime, "require_runtime"):
            with patch.object(buzz_runtime, "run_bounded", return_value=completed):
                stderr = io.StringIO()
                with patch("sys.stderr", stderr), self.assertRaises(SystemExit):
                    buzz_runtime.run_buzz_json(["buzz", "messages", "get"])
        self.assertIn("exceeded", stderr.getvalue())

    def test_runner_bounds_child_output(self) -> None:
        command = [
            sys.executable,
            "-c",
            "import sys; sys.stdout.write('x' * 32)",
        ]
        with patch.object(buzz_runtime, "MAX_OUTPUT_BYTES", 16):
            result = buzz_runtime.run_bounded(command, timeout=5)
        self.assertTrue(result.exceeded_output_limit)
        self.assertLessEqual(len(result.stdout), 16)

    def test_timeout_includes_blocked_stdin_write(self) -> None:
        command = [sys.executable, "-c", "import time; time.sleep(10)"]
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            buzz_runtime.run_bounded(
                command,
                input_bytes=b"x" * (2 * 1024 * 1024),
                timeout=0.1,
            )
        self.assertLess(time.monotonic() - started, 2)


class ThreadParsingTests(unittest.TestCase):
    def test_parses_supported_deep_link_and_thread_root(self) -> None:
        thread_root = "b" * 64
        channel, event, root = read_buzz_thread.parse_message_url(
            f"buzz://message?channel={CHANNEL}&id={EVENT}&thread={thread_root}"
        )
        self.assertEqual(channel, CHANNEL)
        self.assertEqual(event, EVENT)
        self.assertEqual(root, thread_root)

    def test_parses_link_without_thread_root(self) -> None:
        _, _, root = read_buzz_thread.parse_message_url(
            f"buzz://message?channel={CHANNEL}&id={EVENT}"
        )
        self.assertIsNone(root)

    def test_rejects_unknown_parameters(self) -> None:
        with self.assertRaises(SystemExit):
            read_buzz_thread.parse_message_url(
                f"buzz://message?channel={CHANNEL}&id={EVENT}&relay=other"
            )

    def test_rejects_invalid_event(self) -> None:
        with self.assertRaises(SystemExit):
            read_buzz_thread.parse_message_url(
                f"buzz://message?channel={CHANNEL}&id=not-an-event"
            )


class ChannelValidationTests(unittest.TestCase):
    def test_accepts_canonical_uuid(self) -> None:
        self.assertEqual(read_buzz_channel.channel_uuid(CHANNEL), CHANNEL)

    def test_normalizes_uuid_case(self) -> None:
        self.assertEqual(read_buzz_channel.channel_uuid(CHANNEL.upper()), CHANNEL)

    def test_rejects_malformed_uuid(self) -> None:
        with self.assertRaises(SystemExit):
            read_buzz_channel.channel_uuid("-" * 36)


class PublicCliContractTests(unittest.TestCase):
    def test_channel_read_uses_public_cli_commands(self) -> None:
        argv = ["read_buzz_channel.py", CHANNEL, "--limit", "25"]
        responses = [{"id": CHANNEL}, []]
        with patch.object(sys, "argv", argv):
            with patch.object(
                read_buzz_channel, "run_buzz_json", side_effect=responses
            ) as run:
                with patch("sys.stdout", io.StringIO()):
                    read_buzz_channel.main()
        self.assertEqual(
            [call.args[0] for call in run.call_args_list],
            [
                ["buzz", "channels", "get", "--channel", CHANNEL],
                [
                    "buzz",
                    "messages",
                    "get",
                    "--channel",
                    CHANNEL,
                    "--limit",
                    "25",
                ],
            ],
        )

    def test_thread_read_uses_public_cli_command_and_root(self) -> None:
        root = "b" * 64
        argv = [
            "read_buzz_thread.py",
            f"buzz://message?channel={CHANNEL}&id={EVENT}&thread={root}",
        ]
        with patch.object(read_buzz_thread.sys, "argv", argv):
            with patch.object(
                read_buzz_thread, "run_buzz_json", return_value=[]
            ) as run:
                with patch("sys.stdout", io.StringIO()):
                    read_buzz_thread.main()
        self.assertEqual(
            run.call_args.args[0],
            [
                "buzz",
                "messages",
                "thread",
                "--channel",
                CHANNEL,
                "--event",
                root,
                "--limit",
                "200",
            ],
        )


class PostingTests(unittest.TestCase):
    def test_digest_binds_content_and_destination(self) -> None:
        first = post_message.approval_digest(CHANNEL, EVENT, b"hello")
        second = post_message.approval_digest(CHANNEL, EVENT, b"changed")
        other_destination = post_message.approval_digest(CHANNEL, None, b"hello")
        self.assertNotEqual(first, second)
        self.assertNotEqual(first, other_destination)
        self.assertEqual(len(first), hashlib.sha256().digest_size * 2)

    def test_post_uses_stdin_and_attempts_once(self) -> None:
        content = b"approved message"
        digest = post_message.approval_digest(CHANNEL, EVENT, content)
        completed = buzz_runtime.CommandResult(
            0,
            json.dumps(
                {"event_id": EVENT, "accepted": True, "message": "stored"}
            ).encode(),
            False,
        )
        argv = [
            "post_message.py",
            "--channel",
            CHANNEL,
            "--reply-to",
            EVENT,
            "--approved-sha256",
            digest,
        ]
        with patch.object(post_message, "require_runtime"):
            with patch.object(post_message.sys, "argv", argv):
                with patch.object(post_message.sys, "stdin") as stdin:
                    stdin.buffer.read.return_value = content
                    with patch.object(
                        post_message, "run_bounded", return_value=completed
                    ) as run:
                        with patch("sys.stdout", io.StringIO()):
                            post_message.main()
        run.assert_called_once()
        args, kwargs = run.call_args
        self.assertEqual(kwargs["input_bytes"], content)
        self.assertIn("-", args[0])
        self.assertNotIn(content.decode(), args[0])

    def test_rejected_response_is_not_reported_as_posted(self) -> None:
        content = b"approved message"
        digest = post_message.approval_digest(CHANNEL, None, content)
        completed = buzz_runtime.CommandResult(
            0,
            json.dumps(
                {"event_id": EVENT, "accepted": False, "message": "rejected"}
            ).encode(),
            False,
        )
        argv = [
            "post_message.py",
            "--channel",
            CHANNEL,
            "--approved-sha256",
            digest,
        ]
        stderr = io.StringIO()
        with patch.object(post_message, "require_runtime"):
            with patch.object(post_message.sys, "argv", argv):
                with patch.object(post_message.sys, "stdin") as stdin:
                    stdin.buffer.read.return_value = content
                    with patch.object(post_message, "run_bounded", return_value=completed):
                        with patch("sys.stderr", stderr), self.assertRaises(SystemExit):
                            post_message.main()
        self.assertIn("rejected", stderr.getvalue())
        self.assertNotIn('"posted": true', stderr.getvalue())

    def test_unrecognized_success_response_has_unknown_outcome(self) -> None:
        content = b"approved message"
        digest = post_message.approval_digest(CHANNEL, None, content)
        completed = buzz_runtime.CommandResult(0, json.dumps({"id": EVENT}).encode(), False)
        argv = [
            "post_message.py",
            "--channel",
            CHANNEL,
            "--approved-sha256",
            digest,
        ]
        stderr = io.StringIO()
        with patch.object(post_message, "require_runtime"):
            with patch.object(post_message.sys, "argv", argv):
                with patch.object(post_message.sys, "stdin") as stdin:
                    stdin.buffer.read.return_value = content
                    with patch.object(post_message, "run_bounded", return_value=completed):
                        with patch("sys.stderr", stderr), self.assertRaises(SystemExit):
                            post_message.main()
        self.assertIn("unrecognized", stderr.getvalue())

    def test_mismatched_approval_never_posts(self) -> None:
        argv = [
            "post_message.py",
            "--channel",
            CHANNEL,
            "--approved-sha256",
            "0" * 64,
        ]
        with patch.object(post_message, "require_runtime"):
            with patch.object(post_message.sys, "argv", argv):
                with patch.object(post_message.sys, "stdin") as stdin:
                    stdin.buffer.read.return_value = b"changed"
                    with patch.object(post_message, "run_bounded") as run:
                        with self.assertRaises(SystemExit):
                            post_message.main()
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
