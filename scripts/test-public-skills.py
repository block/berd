#!/usr/bin/env python3
"""Run dependency-free tests shipped inside public Agent Skills."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest


def main() -> int:
    root = Path(__file__).resolve().parents[1] / "skills"
    suites: list[unittest.TestSuite] = []
    for skill_md in sorted(root.glob("*/SKILL.md")):
        scripts = skill_md.parent / "scripts"
        if scripts.is_dir():
            suites.append(
                unittest.defaultTestLoader.discover(
                    str(scripts), pattern="test_*.py", top_level_dir=str(scripts)
                )
            )

    suite = unittest.TestSuite(suites)
    count = suite.countTestCases()
    if count == 0:
        print("No public skill tests were found.", file=sys.stderr)
        return 1
    print(f"Running {count} public skill tests.")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
