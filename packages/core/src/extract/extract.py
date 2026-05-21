#!/usr/bin/env python3
"""interlinear PDF extractor.

Renders per-page PNGs, extracts text (watermark-filtered), detects figures
and tables, and emits a JSON manifest the translate-pdf SKILL consumes.

Usage:
    python3 extract.py \\
        --pdf <source.pdf> \\
        --pages 1-10            # or 1,3,5  or 'all'
        --out-png <png-dir>     # one page-NNNN.png per page
        --out-json <file.json>  # manifest

Output JSON shape:
    {
      "source": "<absPath>",
      "pages": [
        {
          "id": "page-0001",
          "number": 1,
          "pngPath": "<png-dir>/page-0001.png",
          "width": <pdf-points>,
          "height": <pdf-points>,
          "text": "<flat text with [[FIGURE_N]] markers>",
          "figures": [{ "marker": "FIGURE_1", "bbox": [x0,y0,x1,y1], "xref": 12 }, ...],
          "tables": [
            {
              "bbox": [x0,y0,x1,y1],
              "rows": <int>,
              "cols": <int>,
              "cells": [
                { "row": 0, "col": 0, "rowSpan": 1, "colSpan": 1, "text": "header", "bbox": [...] },
                ...
              ]
            },
            ...
          ],
          "watermarkRemoved": <int>
        },
        ...
      ]
    }

The table-cell algorithm clusters row/column gridlines from cell bboxes, then
counts how many gridlines each cell spans.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import pymupdf as fitz

WATERMARK_PATTERNS = [
    re.compile(r"CONFIDEN[CT]IAL", re.I),
    re.compile(r"Downloaded\s+by", re.I),
    re.compile(r"^\s*[A-Za-z]+\d{3,}\s*$"),
    re.compile(r"^\s*[A-Z][a-z]{2,3}\.?\s*\d{1,2},?\s*\d{4}\s*$"),
]


def parse_pages(spec: str, total: int) -> list[int]:
    """Convert "118-119" / "1,3,5" / "all" into a sorted 1-based page list."""
    if spec == "all":
        return list(range(1, total + 1))
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        elif part:
            out.add(int(part))
    return sorted(n for n in out if 1 <= n <= total)


def filter_watermark(text: str) -> tuple[str, int]:
    kept: list[str] = []
    removed = 0
    for line in text.splitlines():
        if any(p.search(line.strip()) for p in WATERMARK_PATTERNS):
            removed += 1
            continue
        kept.append(line)
    return "\n".join(kept).strip(), removed


def find_recurring_image_xrefs(doc: fitz.Document, min_pages: int = 20) -> set[int]:
    """Headers/footers/logos: images whose xref appears on many pages."""
    count: dict[int, int] = {}
    for n in range(len(doc)):
        seen: set[int] = set()
        for inf in doc[n].get_image_info(xrefs=True):
            x = inf.get("xref", 0)
            if x and x not in seen:
                seen.add(x)
                count[x] = count.get(x, 0) + 1
    return {x for x, c in count.items() if c >= min_pages}


def collect_figures(
    page: fitz.Page,
    exclude_xrefs: set[int],
    min_dim_pt: float = 50.0,
) -> list[dict]:
    out: list[dict] = []
    seen: set[int] = set()
    raw: list[tuple[float, int, tuple[float, float, float, float]]] = []
    for inf in page.get_image_info(xrefs=True):
        xref = inf.get("xref", 0)
        if not xref or xref in exclude_xrefs or xref in seen:
            continue
        bbox = inf.get("bbox", (0, 0, 0, 0))
        if bbox[2] - bbox[0] < min_dim_pt or bbox[3] - bbox[1] < min_dim_pt:
            continue
        seen.add(xref)
        raw.append((bbox[1], xref, tuple(bbox)))
    raw.sort(key=lambda f: f[0])
    for i, (_y, xref, bbox) in enumerate(raw, 1):
        out.append({"marker": f"FIGURE_{i}", "xref": xref, "bbox": list(bbox)})
    return out


def cluster_coords(coords: list[float], tol: float) -> list[float]:
    """Return canonical gridline positions by greedy clustering."""
    if not coords:
        return []
    coords = sorted(coords)
    clusters: list[list[float]] = [[coords[0]]]
    for c in coords[1:]:
        if c - clusters[-1][-1] <= tol:
            clusters[-1].append(c)
        else:
            clusters.append([c])
    return [sum(c) / len(c) for c in clusters]


def snap(value: float, lines: list[float]) -> int:
    """Return the index of the gridline closest to value."""
    best = 0
    best_d = abs(value - lines[0])
    for i, ln in enumerate(lines[1:], 1):
        d = abs(value - ln)
        if d < best_d:
            best_d = d
            best = i
    return best


def extract_table_cells(t, page: fitz.Page, tol: float = 2.0) -> list[dict]:
    """Walk t.cells and emit one entry per *physical* cell with rowSpan/colSpan
    resolved from bbox span across detected gridlines."""
    cells = list(getattr(t, "cells", []) or [])
    if not cells:
        return []

    # Cluster row and col gridlines from cell corners.
    xs: list[float] = []
    ys: list[float] = []
    for c in cells:
        if c is None:
            continue
        x0, y0, x1, y1 = c[:4]
        xs.extend([x0, x1])
        ys.extend([y0, y1])
    col_lines = cluster_coords(xs, tol)
    row_lines = cluster_coords(ys, tol)
    if len(col_lines) < 2 or len(row_lines) < 2:
        return []

    # Extract the cell text via PyMuPDF's grid extraction (one entry per
    # logical cell, row-major). For merged cells, only the anchor cell carries
    # text; the others are repeats or empty.
    try:
        grid = t.extract()
    except Exception:
        grid = []
    text_at: dict[tuple[int, int], str] = {}
    for r, row in enumerate(grid):
        for c, val in enumerate(row):
            if val is None:
                continue
            text_at[(r, c)] = str(val).strip()

    out: list[dict] = []
    seen_anchors: set[tuple[int, int]] = set()
    for c in cells:
        if c is None:
            continue
        x0, y0, x1, y1 = c[:4]
        col_a = snap(x0, col_lines)
        col_b = snap(x1, col_lines)
        row_a = snap(y0, row_lines)
        row_b = snap(y1, row_lines)
        col_span = max(1, col_b - col_a)
        row_span = max(1, row_b - row_a)
        anchor = (row_a, col_a)
        if anchor in seen_anchors:
            # Duplicate cell entry for the same anchor — keep the first.
            continue
        seen_anchors.add(anchor)
        text = text_at.get(anchor, "")
        out.append(
            {
                "row": row_a,
                "col": col_a,
                "rowSpan": row_span,
                "colSpan": col_span,
                "text": text,
                "bbox": [x0, y0, x1, y1],
            }
        )
    out.sort(key=lambda c: (c["row"], c["col"]))
    return out


def collect_tables(page: fitz.Page) -> list[dict]:
    out: list[dict] = []
    try:
        tabs = page.find_tables()
    except Exception:
        return out
    for t in tabs:
        cells = extract_table_cells(t, page)
        if not cells:
            continue
        rows = max(c["row"] + c["rowSpan"] for c in cells)
        cols = max(c["col"] + c["colSpan"] for c in cells)
        bbox = list(t.bbox) if hasattr(t, "bbox") else [0, 0, 0, 0]
        out.append({"bbox": bbox, "rows": rows, "cols": cols, "cells": cells})
    return out


def build_positional_text(
    page: fitz.Page, figures: list[dict]
) -> tuple[str, int]:
    """Interleave text blocks with [[FIGURE_N]] markers ordered by y-position."""
    items: list[tuple[float, str, str]] = []
    blocks = page.get_text("blocks") or []
    removed_total = 0
    for block in blocks:
        x0, y0, x1, y1, btext, bno, btype = block
        if btype != 0:
            continue
        kept, removed = filter_watermark(btext)
        removed_total += removed
        if kept:
            items.append((y0, "text", kept))
    for fig in figures:
        items.append((fig["bbox"][1], "img", fig["marker"]))
    items.sort(key=lambda x: x[0])
    parts = [f"[[{c}]]" if k == "img" else c for _y, k, c in items]
    return "\n\n".join(parts), removed_total


def extract_page(doc: fitz.Document, page_no: int, png_dir: Path, exclude_xrefs: set[int]) -> dict:
    page = doc[page_no - 1]
    page_id = f"page-{page_no:04d}"
    png_path = png_dir / f"{page_id}.png"
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
    pix.save(str(png_path))

    figures = collect_figures(page, exclude_xrefs)
    text, watermark_removed = build_positional_text(page, figures)
    tables = collect_tables(page)

    rect = page.rect
    return {
        "id": page_id,
        "number": page_no,
        "pngPath": str(png_path),
        "width": rect.width,
        "height": rect.height,
        "text": text,
        "figures": figures,
        "tables": tables,
        "watermarkRemoved": watermark_removed,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract a PDF for interlinear.")
    ap.add_argument("--pdf", required=True, help="Absolute path to source PDF.")
    ap.add_argument(
        "--pages",
        required=True,
        help='Pages to extract: "118-119", "1,3,5", or "all".',
    )
    ap.add_argument(
        "--out-png", required=True, help="Directory to write page-NNNN.png files."
    )
    ap.add_argument("--out-json", required=True, help="Path to output manifest JSON.")
    args = ap.parse_args()

    pdf_path = Path(args.pdf).resolve()
    if not pdf_path.exists():
        print(f"PDF not found: {pdf_path}", file=sys.stderr)
        return 1
    png_dir = Path(args.out_png)
    png_dir.mkdir(parents=True, exist_ok=True)
    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    page_nos = parse_pages(args.pages, len(doc))
    if not page_nos:
        print(f"No pages selected from spec: {args.pages}", file=sys.stderr)
        return 1

    exclude_xrefs = find_recurring_image_xrefs(doc)

    pages: list[dict] = []
    for n in page_nos:
        pages.append(extract_page(doc, n, png_dir, exclude_xrefs))
        print(f"  extracted {n}/{len(doc)}", file=sys.stderr)

    manifest = {"source": str(pdf_path), "pages": pages}
    out_json.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"wrote {out_json}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
