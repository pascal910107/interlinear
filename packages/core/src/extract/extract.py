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
          "figures": [
            { "marker": "FIGURE_1", "kind": "raster", "bbox": [x0,y0,x1,y1],
              "xref": 12, "pngPath": "page-0001-figure-1.png" },
            { "marker": "FIGURE_2", "kind": "vector", "bbox": [x0,y0,x1,y1],
              "pngPath": "page-0001-figure-2.png" }
          ],
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


def collect_raster_figures(
    page: fitz.Page,
    exclude_xrefs: set[int],
    min_dim_pt: float = 50.0,
    max_page_area_ratio: float = 0.85,
) -> list[tuple[int, tuple[float, float, float, float]]]:
    """Detect raster figures from embedded PDF image xrefs.

    Returns (xref, bbox) tuples in source order. PNG rendering and marker
    numbering are deferred to `merge_and_render_figures` so raster and
    vector figures share a single numbering pass.

    Skips images whose bbox covers more than `max_page_area_ratio` of the
    page — those are cover-page backgrounds or watermark images, not
    real figures.
    """
    page_rect = page.rect
    page_area = (page_rect.x1 - page_rect.x0) * (page_rect.y1 - page_rect.y0) or 1.0
    seen: set[int] = set()
    out: list[tuple[int, tuple[float, float, float, float]]] = []
    for inf in page.get_image_info(xrefs=True):
        xref = inf.get("xref", 0)
        if not xref or xref in exclude_xrefs or xref in seen:
            continue
        bbox = inf.get("bbox", (0, 0, 0, 0))
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        if w < min_dim_pt or h < min_dim_pt:
            continue
        if (w * h) / page_area > max_page_area_ratio:
            continue
        seen.add(xref)
        out.append((xref, tuple(bbox)))
    return out


_MAX_DRAWINGS_PER_PAGE = 3000


def cluster_rects(
    rects: list[tuple[float, float, float, float]], gap: float
) -> list[tuple[int, tuple[float, float, float, float]]]:
    """Union-find clustering: merge rects that overlap or sit within `gap`.

    Returns one (member_count, union_bbox) per cluster.
    """
    n = len(rects)
    if n == 0:
        return []
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    def near(a, b) -> bool:
        return not (
            a[2] + gap < b[0] or b[2] + gap < a[0]
            or a[3] + gap < b[1] or b[3] + gap < a[1]
        )

    for i in range(n):
        ai = rects[i]
        for j in range(i + 1, n):
            if near(ai, rects[j]):
                union(i, j)

    groups: dict[int, list[float]] = {}
    counts: dict[int, int] = {}
    for i, r in enumerate(rects):
        root = find(i)
        if root not in groups:
            groups[root] = [r[0], r[1], r[2], r[3]]
            counts[root] = 1
        else:
            g = groups[root]
            g[0] = min(g[0], r[0])
            g[1] = min(g[1], r[1])
            g[2] = max(g[2], r[2])
            g[3] = max(g[3], r[3])
            counts[root] += 1
    return [(counts[k], tuple(groups[k])) for k in groups]


def _overlap_ratio(a, b) -> float:
    """Fraction of `a`'s area that lies inside `b`."""
    ix0 = max(a[0], b[0]); iy0 = max(a[1], b[1])
    ix1 = min(a[2], b[2]); iy1 = min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    aa = (a[2] - a[0]) * (a[3] - a[1])
    return inter / aa if aa else 0.0


def collect_vector_figures(
    page: fitz.Page,
    table_bboxes: list[list[float]],
    raster_bboxes: list[tuple[float, float, float, float]],
    text_bboxes: list[tuple[float, float, float, float]],
    min_dim_pt: float = 80.0,
    gap: float = 10.0,
    min_drawings: int = 3,
    max_page_area_ratio: float = 0.7,
) -> list[tuple[float, float, float, float]]:
    """Detect vector graphics regions (block diagrams, schematics, timing
    diagrams) by clustering drawing operators on the page.

    Filters out:
      - clusters whose center sits inside a text block (the PDF renders a
        per-line highlight/strikethrough rect behind every line of prose,
        or — in some Chinese PDFs — glyphs themselves appear in the
        drawing stream; either way it's text, not a figure)
      - clusters whose center sits inside a detected table (table grid lines)
      - clusters that mostly coincide with a raster figure (already covered)
      - degenerate clusters with too few drawings (single backgrounds, rules,
        separator lines) — `min_drawings` floor
      - clusters whose bbox dominates the page (page background, watermark
        frame) — `max_page_area_ratio` ceiling
      - clusters whose bbox is below `min_dim_pt` on either axis
    """
    try:
        drawings = page.get_drawings()
    except Exception:
        return []
    if not drawings:
        return []

    rects: list[tuple[float, float, float, float]] = []
    truncated = False
    for d in drawings:
        r = d.get("rect")
        if r is None:
            continue
        if r.width < 2 or r.height < 2:
            # Hairline strokes — table grids, underlines, dividers.
            continue
        if len(rects) >= _MAX_DRAWINGS_PER_PAGE:
            truncated = True
            break
        rects.append((r.x0, r.y0, r.x1, r.y1))
    if truncated:
        print(
            f"  warning: drawing count exceeds {_MAX_DRAWINGS_PER_PAGE}; "
            "vector-figure detection on this page is partial.",
            file=sys.stderr,
        )

    page_rect = page.rect
    page_area = (page_rect.x1 - page_rect.x0) * (page_rect.y1 - page_rect.y0) or 1.0
    clusters = cluster_rects(rects, gap=gap)

    kept: list[tuple[float, float, float, float]] = []
    for count, bbox in clusters:
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        if w < min_dim_pt or h < min_dim_pt:
            continue
        if count < min_drawings:
            continue
        if (w * h) / page_area > max_page_area_ratio:
            continue
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        if any(t[0] <= cx <= t[2] and t[1] <= cy <= t[3] for t in table_bboxes):
            continue
        # Text-as-paths and per-line highlight rects: drawings hugging a
        # text-block bbox. If the cluster's center is inside any text
        # block, OR the cluster is mostly contained inside the union of
        # text blocks, reject — it's text, not a figure.
        if any(t[0] <= cx <= t[2] and t[1] <= cy <= t[3] for t in text_bboxes):
            continue
        text_overlap = sum(
            _overlap_ratio(bbox, t) for t in text_bboxes
        )
        if text_overlap > 0.5:
            continue
        if any(_overlap_ratio(bbox, r) > 0.5 for r in raster_bboxes):
            continue
        kept.append(bbox)
    kept.sort(key=lambda b: b[1])
    return kept


def merge_and_render_figures(
    page: fitz.Page,
    page_no: int,
    png_dir: Path,
    raster: list[tuple[int, tuple[float, float, float, float]]],
    vector: list[tuple[float, float, float, float]],
    scale: float = 2.0,
) -> list[dict]:
    """Merge raster + vector figures, sort by y, number sequentially, and
    render one PNG per figure by clipping the page render at its bbox.

    Cropping from the page render (not the source xref) preserves vector
    overlays on raster images AND captures the text labels that compose
    most vector diagrams.
    """
    items: list[dict] = []
    for xref, bbox in raster:
        items.append({"kind": "raster", "xref": xref, "bbox": list(bbox)})
    for bbox in vector:
        items.append({"kind": "vector", "bbox": list(bbox)})
    items.sort(key=lambda f: f["bbox"][1])

    out: list[dict] = []
    for i, fig in enumerate(items, 1):
        bbox = fig["bbox"]
        entry: dict = {"marker": f"FIGURE_{i}", "kind": fig["kind"], "bbox": bbox}
        if fig["kind"] == "raster":
            entry["xref"] = fig["xref"]
        png_name = f"page-{page_no:04d}-figure-{i}.png"
        try:
            clip = fitz.Rect(*bbox) & page.rect
            if not clip.is_empty and clip.width >= 10 and clip.height >= 10:
                pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip)
                pix.save(str(png_dir / png_name))
                entry["pngPath"] = png_name
        except Exception as e:
            print(f"  failed to render figure {png_name}: {e}", file=sys.stderr)
        out.append(entry)
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

    # Tables first — their bboxes filter out table grid-lines from the
    # vector-figure clustering step. Text-block bboxes filter out the
    # per-line highlight rects (and text-as-paths glyphs) that some PDFs
    # emit as drawing operators.
    tables = collect_tables(page)
    text_bboxes: list[tuple[float, float, float, float]] = []
    for block in page.get_text("blocks") or []:
        x0, y0, x1, y1, _t, _bno, btype = block
        if btype != 0:
            continue
        text_bboxes.append((x0, y0, x1, y1))
    raster = collect_raster_figures(page, exclude_xrefs)
    vector = collect_vector_figures(
        page,
        [t["bbox"] for t in tables],
        [b for _, b in raster],
        text_bboxes,
    )
    figures = merge_and_render_figures(page, page_no, png_dir, raster, vector)
    text, watermark_removed = build_positional_text(page, figures)

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
