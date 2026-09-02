#!/usr/bin/env python3
"""Verify that the committed generated PRD matches its Markdown source."""

from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path

from docx import Document


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PROJECT_ROOT / "docs" / "Open_Bikeshare_MCP_PRD.md"
DEFAULT_DOCUMENT = (
    PROJECT_ROOT / "docs" / "Open_Bikeshare_MCP_PRD_Cloudflare_v1.3.docx"
)
SOURCE_HASH_PATTERN = re.compile(r"Source SHA-256: ([0-9a-f]{64})")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--document", type=Path, default=DEFAULT_DOCUMENT)
    args = parser.parse_args()

    source_path = args.source.resolve()
    document_path = args.document.resolve()
    expected = hashlib.sha256(source_path.read_bytes()).hexdigest()
    comments = Document(document_path).core_properties.comments or ""
    match = SOURCE_HASH_PATTERN.search(comments)

    if match is None:
        raise SystemExit(
            f"{document_path} has no source hash; regenerate it with tools/build_prd.py"
        )
    if match.group(1) != expected:
        raise SystemExit(
            f"{document_path} is stale; regenerate it with tools/build_prd.py"
        )

    print(f"PRD source hash matches: {expected}")


if __name__ == "__main__":
    main()
