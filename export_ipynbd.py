#!/usr/bin/env python3
"""
Export a .ipynb with overlay_v1 ink drawn *exactly over the rendered cell contents*,
and preserve common rich outputs (PNG/JPEG/SVG/HTML/text).

- Standalone HTML with absolute-positioned SVG overlays over each cell's input.
- Optional PDF via WeasyPrint (vector-safe for SVG; raster for PNG/JPEG).
- Keeps multiple outputs per cell in their original order.
- JS-heavy outputs (e.g., Plotly JSON without a static image) won't execute in PDF;
  they will appear in HTML but may need internet-free assets you can inline later.

Usage:
  python export_overlay_exact.py input.ipynb --html out.html [--pdf out.pdf]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

import nbformat
from nbformat.notebooknode import NotebookNode

# Minimal deps:
#   pip install markdown2 pygments weasyprint (weasyprint optional)
import markdown2
from pygments import highlight
from pygments.lexers import get_lexer_by_name, TextLexer
from pygments.formatters import HtmlFormatter

try:
    from weasyprint import HTML as WeasyHTML  # optional
except Exception:
    WeasyHTML = None  # type: ignore

html_formatter = HtmlFormatter(nowrap=False, full=False, cssclass="codehilite")

@dataclass
class Stroke:
    tool: str
    color: str
    width: float   # normalized to wrapper width
    alpha: float
    points: List[Tuple[float, float]]  # normalized points


def escape_html(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def extract_strokes(meta: Dict[str, Any]) -> List[Stroke]:
    ov = (meta or {}).get("overlay_v1") or {}
    out: List[Stroke] = []
    for st in ov.get("strokes", []):
        pts = st.get("points", []) or []
        out.append(
            Stroke(
                tool=st.get("tool", "pen"),
                color=st.get("color", "#000"),
                width=float(st.get("width", 0.003)),
                alpha=float(st.get("alpha", 1.0)),
                points=[(float(x), float(y)) for x, y in pts],
            )
        )
    return out


def strokes_to_svg_normalized(strokes: List[Stroke]) -> str:
    """
    Build an SVG that fills its parent (100% x 100%) while keeping strokes aligned
    to the parent's pixel box. We draw in a 1000x1000 viewBox so normalized points
    map to that grid; CSS scales to the wrapper size.
    """
    if not strokes:
        return ""
    vb = 1000.0
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" '
        'class="overlay-svg" '
        'preserveAspectRatio="none" '
        f'viewBox="0 0 {int(vb)} {int(vb)}">'
    ]
    for s in strokes:
        if not s.points:
            continue
        d = []
        for i, (nx, ny) in enumerate(s.points):
            x = nx * vb
            y = ny * vb
            d.append(("M" if i == 0 else "L") + f" {x:.2f} {y:.2f}")
        opacity = (0.3 if s.tool == "highlighter" else 1.0) if s.alpha is None else s.alpha
        # width is normalized to parent width: convert to the 1000-wide viewBox
        stroke_w = max(1.0, s.width * vb)
        parts.append(
            f'<path d="{" ".join(d)}" fill="none" '
            f'stroke="{s.color or "#000"}" stroke-linecap="round" stroke-linejoin="round" '
            f'stroke-opacity="{opacity:.3f}" stroke-width="{stroke_w:.2f}"/>'
        )
    parts.append("</svg>")
    return "".join(parts)


def render_markdown(md: str) -> str:
    return markdown2.markdown(md, extras=["fenced-code-blocks", "tables"])


def render_code(src: str, lang_guess: str = "python") -> str:
    try:
        lexer = get_lexer_by_name(lang_guess or "python", stripall=False)
    except Exception:
        lexer = TextLexer()
    return highlight(src, lexer, html_formatter)


def render_outputs(outputs: List[Dict[str, Any]]) -> str:
    """Render rich outputs with smart fallbacks.
    Preference per output bundle:
      1) image/svg+xml
      2) image/png / image/jpeg
      3) text/html  (scripts may not run in PDF)
      4) text/plain
    Special handling:
      - For interactive widget JSON (Plotly/Vega/Vega-Lite/Bokeh), if a PNG is present
        alongside the JSON/HTML, we *prefer the PNG* for portability/PDF fidelity.
    """
    if not outputs:
        return ""
    rendered: List[str] = []
    WIDGET_MIME_PREFIXES = (
        "application/vnd.plotly",
        "application/vnd.vega",
        "application/vnd.vegalite",
        "application/vnd.bokehjs",
    )

    for out in outputs:
        otype = out.get("output_type")
        if otype == "stream":
            txt = out.get("text", "")
            if txt:
                rendered.append(f"<pre class='codehilite'>{escape_html(txt)}</pre>")
            continue

        if otype in ("display_data", "execute_result"):
            data = out.get("data", {})

            # Detect if this bundle likely came from a widget (plotly/vega/bokeh)
            is_widget = any(any(k.startswith(pref) for k in data.keys()) for pref in WIDGET_MIME_PREFIXES)

            # Prefer SVG first
            if "image/svg+xml" in data:
                svg = data["image/svg+xml"]
                if isinstance(svg, list):
                    svg = "".join(svg)
                rendered.append(f"<div class='out-svg'>{svg}</div>")
                continue  # we already displayed a good vector representation

            # Next: if widget, strongly prefer PNG/JPEG if present (for PDF)
            if is_widget:
                if "image/png" in data or "image/jpeg" in data:
                    for mime in ("image/png", "image/jpeg"):
                        if mime in data:
                            b64 = data[mime]
                            if isinstance(b64, list):
                                b64 = "".join(b64)
                            rendered.append(f"<img class='out-img' alt='{mime}' src='data:{mime};base64,{b64}'/>")
                    continue
                # else fall back to HTML (may not render in PDF but fine in HTML)
                if "text/html" in data:
                    html = data["text/html"]
                    if isinstance(html, list):
                        html = "".join(html)
                    rendered.append(f"<div class='out-html'>{html}</div>")
                    if "text/plain" in data:
                        txt = data["text/plain"]
                        if isinstance(txt, list):
                            txt = "".join(txt)
                        rendered.append(f"<pre class='codehilite'>{escape_html(txt)}</pre>")
                    continue

            # Non-widget (or no PNG): try PNG/JPEG
            for mime in ("image/png", "image/jpeg"):
                if mime in data:
                    b64 = data[mime]
                    if isinstance(b64, list):
                        b64 = "".join(b64)
                    rendered.append(f"<img class='out-img' alt='{mime}' src='data:{mime};base64,{b64}'/>")
                    # don't 'continue' so we can still include accompanying HTML/plain if present

            # HTML next
            if "text/html" in data:
                html = data["text/html"]
                if isinstance(html, list):
                    html = "".join(html)
                rendered.append(f"<div class='out-html'>{html}</div>")

            # Plain text fallback
            if "text/plain" in data:
                txt = data["text/plain"]
                if isinstance(txt, list):
                    txt = "".join(txt)
                rendered.append(f"<pre class='codehilite'>{escape_html(txt)}</pre>")

    return "".join(rendered)


BASE_CSS = r"""
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
  margin: 32px;
}
h1,h2,h3 { margin-top: 1.6em; }
.nb-title { margin-bottom: 1rem; opacity: 0.8; font-size: 0.9rem; }
.cell {
  margin: 24px 0;
  border: 1px solid #ddd;
  border-radius: 10px;
  overflow: hidden;
}
.cell-header {
  background: rgba(0,0,0,0.04);
  padding: 8px 12px;
  font-size: 12px;
  color: #555;
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.cell-body { padding: 0; }
.input-wrapper {
  position: relative; /* anchor for overlay */
  padding: 16px;
}
.codehilite {
  background: #f7f7f9;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
}
.overlay-abs {
  position: absolute;
  inset: 16px; /* match .input-wrapper padding so overlay covers content box */
  pointer-events: none;
}
.overlay-svg {
  width: 100%;
  height: 100%;
  display: block;
}
.outputs {
  padding: 8px 16px 16px 16px;
  border-top: 1px solid rgba(0,0,0,0.06);
}
.out-img { max-width: 100%; height: auto; display: block; margin: 8px 0; }
.out-svg, .out-html { margin: 8px 0; }
@media (prefers-color-scheme: dark) {
  body { color: #eee; background: #0b0b0d; }
  .cell { border-color: #2a2a2e; }
  .cell-header { background: rgba(255,255,255,0.05); color: #bbb; }
  .codehilite { background: #151516; }
}
"""

HTML_SHELL = """<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{title}</title>
<style>{css}</style>
</head>
<body>
<div class="nb-title">{title}</div>
{body}
</body>
</html>
"""


def export_html(ipynb_path: str, html_path: str) -> None:
    nb: NotebookNode = nbformat.read(ipynb_path, as_version=4)
    kernel_lang = (nb.metadata.get("kernelspec") or {}).get("language", "python")

    cells_html: List[str] = []
    for i, cell in enumerate(nb.cells):
        ctype = cell.cell_type
        meta = cell.get("metadata", {})
        strokes = extract_strokes(meta)

        # Render input block
        if ctype == "markdown":
            input_html = render_markdown(cell.get("source", ""))
        elif ctype == "code":
            input_html = render_code(cell.get("source", ""), lang_guess=kernel_lang)
        else:
            input_html = f"<pre class='codehilite'>{escape_html(cell.get('source',''))}</pre>"

        # Overlay HTML (absolute over input wrapper)
        overlay_html = ""
        if strokes:
            overlay_html = f"<div class='overlay-abs'>{strokes_to_svg_normalized(strokes)}</div>"

        # Render outputs (rich)
        outputs_block = ""
        if ctype == "code":
            outs_html = render_outputs(cell.get("outputs", []))
            if outs_html:
                outputs_block = f"<div class='outputs'>{outs_html}</div>"

        cells_html.append(
            f"<div class='cell'>"
            f"  <div class='cell-header'>"
            f"    <div>Cell {i+1} — {ctype}</div>"
            f"    <div>{len(strokes)} stroke(s)</div>"
            f"  </div>"
            f"  <div class='cell-body'>"
            f"    <div class='input-wrapper'>"
            f"      {input_html}"
            f"      {overlay_html}"
            f"    </div>"
            f"    {outputs_block}"
            f"  </div>"
            f"</div>"
        )

    html = HTML_SHELL.format(
        title=os.path.basename(ipynb_path),
        css=BASE_CSS,
        body="\n".join(cells_html),
    )
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)


def export_pdf(html_path: str, pdf_path: str) -> None:
    if WeasyHTML is None:
        raise RuntimeError("WeasyPrint not installed. `pip install weasyprint` (plus Cairo/Pango libs) "
                           "or export via your browser's Print to PDF.")
    WeasyHTML(filename=html_path).write_pdf(pdf_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("notebook", help=".ipynb path")
    ap.add_argument("--html", default=None, help="output HTML path (default: <name>_overlay.html)")
    ap.add_argument("--pdf", default=None, help="output PDF path (optional)")
    args = ap.parse_args()

    if not os.path.exists(args.notebook):
        print(f"not found: {args.notebook}", file=sys.stderr); sys.exit(1)

    html_out = args.html or os.path.splitext(args.notebook)[0] + "_overlay.html"
    export_html(args.notebook, html_out)
    print(f"✓ Wrote {html_out}")
    if args.pdf:
        export_pdf(html_out, args.pdf)
        print(f"✓ Wrote {args.pdf}")


if __name__ == "__main__":
    main()
