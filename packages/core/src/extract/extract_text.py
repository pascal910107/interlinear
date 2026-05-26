#!/usr/bin/env python3
"""Text-only PDF extractor for the interlinear search index.

The full extractor at extract.py also renders PNGs and detects figures /
tables. The search index only needs plain reading-order text per page, so
this trimmed-down variant is used by pdf-text-index.ts to keep the
background extraction cheap.

Usage:
    python3 extract_text.py \\
        --pdf <source.pdf> \\
        --out-json <file.json>

Output:
    {
      "source": "<absPath>",
      "pageCount": <int>,
      "pages": {
        "page-0001": "<plain text>",
        "page-0002": "<plain text>",
        ...
      }
    }

The keys use the same 4-digit zero-padded page id scheme as the rest of
the codebase so the consumer can look up by pageId directly.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pymupdf as fitz


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, help="Path to the source PDF")
    ap.add_argument("--out-json", required=True, help="Output JSON path")
    args = ap.parse_args()

    pdf_path = Path(args.pdf).resolve()
    if not pdf_path.exists():
        print(f"PDF not found: {pdf_path}", file=sys.stderr)
        return 2

    doc = fitz.open(str(pdf_path))
    pages: dict[str, str] = {}
    for i in range(doc.page_count):
        page = doc.load_page(i)
        # "text" mode preserves reading order; this matches what the search
        # endpoint already does for translation pages (substring match) and
        # keeps line breaks intact so headings sit on their own line.
        pages[f"page-{i + 1:04d}"] = page.get_text("text")

    out_path = Path(args.out_json)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "source": str(pdf_path),
                "pageCount": doc.page_count,
                "pages": pages,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
