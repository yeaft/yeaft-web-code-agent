#!/usr/bin/env python3
"""Container-only renderer for actual showcase PPTX quality verification."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile


def run(*args, timeout=120):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.stdout:
        print(result.stdout.strip(), flush=True)
    if result.stderr:
        print(result.stderr.strip(), file=sys.stderr, flush=True)
    result.check_returncode()
    return result.stdout


def main():
    for dependency in ("libreoffice", "pdfinfo", "pdftoppm", "fc-match"):
        if not shutil.which(dependency):
            raise RuntimeError(f"Missing renderer dependency: {dependency}")
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise RuntimeError("Missing renderer dependency: python3-pil") from error

    source = Path("/input/deck.pptx")
    output = Path("/output")
    expected_pages = 8
    with zipfile.ZipFile(source) as archive:
        slides = [name for name in archive.namelist()
                  if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]
    if len(slides) != expected_pages:
        raise RuntimeError(f"Expected {expected_pages} PPTX slides, found {len(slides)}")
    os.makedirs(os.environ["HOME"], exist_ok=True)
    font_family = run("fc-match", "-f", "%{family}", "Liberation Sans").strip()
    if font_family != "Liberation Sans":
        raise RuntimeError(f"Liberation Sans is unavailable: {font_family}")
    office_version = run("libreoffice", "--version").strip()
    run("libreoffice", "-env:UserInstallation=file:///tmp/showcase-profile",
        "--headless", "--convert-to", "pdf:impress_pdf_Export",
        "--outdir", str(output), str(source))
    pdf = output / "deck.pdf"
    if not pdf.is_file() or pdf.stat().st_size == 0:
        raise RuntimeError("LibreOffice did not produce a PDF")
    pdf_info = run("pdfinfo", str(pdf))
    count = re.search(r"^Pages:\s+(\d+)$", pdf_info, re.MULTILINE)
    if not count or int(count.group(1)) != expected_pages:
        raise RuntimeError("Rendered PDF must contain exactly 8 pages")
    run("pdftoppm", "-png", "-r", "144", str(pdf), str(output / "page"))
    pages = sorted(output.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
    if len(pages) != expected_pages:
        raise RuntimeError(f"Expected 8 PNG pages, found {len(pages)}")
    font_path = run("fc-match", "-f", "%{file}", "Liberation Sans").strip()
    font = ImageFont.truetype(font_path, 20)
    thumbnail_width, thumbnail_height = 640, 360
    margin, label_height, columns = 20, 32, 2
    cell_width = thumbnail_width + margin * 2
    cell_height = thumbnail_height + label_height + margin * 2
    sheet = Image.new("RGB", (columns * cell_width, 4 * cell_height), "#e5e7eb")
    draw = ImageDraw.Draw(sheet)
    dimensions = []
    for index, path in enumerate(pages):
        # Normalize Poppler's page names and force complete decoding of each PNG.
        target = output / f"page-{index + 1:02d}.png"
        if target != path:
            path.rename(target)
        with Image.open(target) as image:
            image.load()
            dimensions.append(list(image.size))
            thumbnail = image.convert("RGB")
            thumbnail.thumbnail((thumbnail_width, thumbnail_height), Image.Resampling.LANCZOS)
        x = (index % columns) * cell_width + margin
        y = (index // columns) * cell_height + margin
        draw.text((x, y), f"Slide {index + 1:02d}", font=font, fill="#111827")
        sheet.paste(thumbnail, (x, y + label_height))
    sheet.save(output / "contact-sheet.png")
    report = {
        "input_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "renderer": office_version,
        "font": font_family,
        "slide_count": len(slides),
        "pdf_pages": int(count.group(1)),
        "png_pages": len(pages),
        "dpi": 144,
        "page_dimensions": dimensions,
        "contact_sheet": list(sheet.size),
    }
    (output / "render-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"Render failed: {error}", file=sys.stderr)
        sys.exit(1)
