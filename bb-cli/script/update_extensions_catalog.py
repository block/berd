#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///

import json
import re
import sys
from pathlib import Path
from typing import Dict, Optional

HEADER = "# Generated via `just update-extensions-catalog`, then curated manually.\n"


def parse_yaml_scalar(raw: str) -> str:
    value = raw.split("#", 1)[0].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        quote = value[0]
        value = value[1:-1]
        if quote == "'":
            return value.replace("''", "'").strip()
        return json.loads(f'"{value}"') if "\\" in value else value.strip()
    return value


def parse_generated_catalog(path: Path) -> Dict[str, str]:
    entries: Dict[str, str] = {}
    current_name: Optional[str] = None
    current_about = ""

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if not raw_line or raw_line.startswith("#"):
            continue

        if raw_line.startswith("- name:"):
            if current_name:
                entries[current_name] = current_about
            current_name = parse_yaml_scalar(raw_line.split(":", 1)[1])
            current_about = ""
            continue

        if current_name and raw_line.startswith("  about:"):
            current_about = parse_yaml_scalar(raw_line.split(":", 1)[1])

    if current_name:
        entries[current_name] = current_about

    return entries


def parse_g2_config_entries(path: Path) -> Dict[str, str]:
    entries: Dict[str, str] = {}
    in_config = False
    current_name: Optional[str] = None
    current_display_name = ""

    def flush_current_entry() -> None:
        if not current_name or current_name.endswith("_official"):
            return
        entries[current_name] = current_display_name

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("//"):
            continue

        if not in_config:
            if stripped == "export const oauthConfig = {":
                in_config = True
            continue

        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if indent == 0 and stripped == "}":
            flush_current_entry()
            break

        if indent == 2 and stripped.endswith("{"):
            flush_current_entry()
            key_match = re.match(r"(?:'([^']+)'|([A-Za-z0-9_-]+)):\s*\{$", stripped)
            current_name = (key_match.group(1) or key_match.group(2)) if key_match else None
            current_display_name = ""
            continue

        if current_name is None or indent < 4:
            continue

        display_name_match = re.match(r"displayName:\s*'([^']*)',?$", stripped)
        if display_name_match:
            current_display_name = display_name_match.group(1).strip()

    return entries


def parse_g2_oauth_descriptions(path: Path) -> Dict[str, str]:
    if not path.is_file():
        return {}

    entries: Dict[str, str] = {}
    source = path.read_text(encoding="utf-8")
    match = re.search(r"export const oauthDescriptions.*?=\s*\{(.*?)\}\s*as const", source, re.DOTALL)
    if not match:
        return entries

    for raw_line in match.group(1).splitlines():
        stripped = raw_line.strip().rstrip(",")
        if not stripped:
            continue

        description_match = re.match(r"(?:'([^']+)'|([A-Za-z0-9_-]+)):\s*'([^']*)'$", stripped)
        if not description_match:
            continue

        key = description_match.group(1) or description_match.group(2)
        entries[key] = description_match.group(3).strip()

    return entries


def normalize_about(name: str, about: str) -> str:
    cleaned = about.strip().lstrip("#").strip()
    return cleaned or f"{name} tools"


def render_yaml_scalar(value: str) -> str:
    lowered = value.lower()
    if (
        value
        and lowered not in {"null", "~", "true", "false"}
        and "\n" not in value
        and ": " not in value
        and " #" not in value
        and not value.endswith(":")
        and value[0] not in "-?:,[]{}#&*!|>'\"%@`"
    ):
        return value
    return json.dumps(value, ensure_ascii=False)


def write_catalog(path: Path, entries: Dict[str, str]) -> None:
    rows = [
        {"name": name, "about": normalize_about(name, about)}
        for name, about in sorted(entries.items())
    ]

    with path.open("w", encoding="utf-8") as handle:
        handle.write(HEADER)
        for row in rows:
            handle.write(f"- name: {render_yaml_scalar(row['name'])}\n")
            handle.write(f"  about: {render_yaml_scalar(row['about'])}\n")


def main() -> int:
    generated_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    g2_config_path = Path(sys.argv[3])
    g2_oauth_descriptions_path = Path(sys.argv[4])

    entries = parse_generated_catalog(generated_path)
    descriptions = parse_g2_oauth_descriptions(g2_oauth_descriptions_path)

    for provider, display_name in parse_g2_config_entries(g2_config_path).items():
        entries.setdefault(provider, descriptions.get(provider, display_name))

    write_catalog(output_path, entries)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
