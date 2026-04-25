#!/usr/bin/env python3
"""Image manipulation CLI wrapper around Pillow.

Usage:
    image-tools.py resize <input> <WxH> <output> [--stretch]
    image-tools.py compress <input> <output> <quality:1-100>
    image-tools.py crop <input> <output> <spec>
    image-tools.py convert <input> <output>
    image-tools.py info <input>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

from PIL import Image, ImageOps


def _open_image(path: str) -> Image.Image:
    """Open an image and apply EXIF orientation."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    return img


def _save_atomic(img: Image.Image, output: str, **kwargs: Any) -> None:
    """Save image atomically: write to temp file, then rename."""
    outdir = os.path.dirname(output) or "."
    os.makedirs(outdir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=outdir, suffix=Path(output).suffix)
    os.close(fd)
    try:
        ext = Path(output).suffix.lower()
        if ext in (".jpg", ".jpeg"):
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            img.save(tmp, format="JPEG", **kwargs)
        elif ext == ".webp":
            img.save(tmp, format="WEBP", **kwargs)
        elif ext == ".png":
            img.save(tmp, format="PNG", **kwargs)
        elif ext == ".gif":
            img.save(tmp, format="GIF", **kwargs)
        elif ext == ".bmp":
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            img.save(tmp, format="BMP", **kwargs)
        elif ext in (".tif", ".tiff"):
            img.save(tmp, format="TIFF", **kwargs)
        else:
            img.save(tmp, **kwargs)
        shutil.move(tmp, output)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _parse_dimensions(spec: str) -> tuple[int, int]:
    """Parse 'WxH' or 'WXH' into (width, height)."""
    m = re.match(r"(\d+)[xX](\d+)", spec)
    if not m:
        raise ValueError(f"Invalid dimensions: {spec}. Use format WxH (e.g., 800x600)")
    return int(m.group(1)), int(m.group(2))


def cmd_resize(args: argparse.Namespace) -> None:
    img = _open_image(args.input)
    w, h = _parse_dimensions(args.size)

    if args.stretch:
        img = img.resize((w, h), Image.LANCZOS)
    else:
        img.thumbnail((w, h), Image.LANCZOS)

    _save_atomic(img, args.output)
    print(f"Resized to {img.size[0]}x{img.size[1]} -> {args.output}", file=sys.stderr)


def cmd_compress(args: argparse.Namespace) -> None:
    img = _open_image(args.input)
    quality = max(1, min(100, args.quality))

    ext = Path(args.output).suffix.lower()
    if ext not in (".jpg", ".jpeg", ".webp"):
        if img.mode == "RGBA":
            ext = ".webp"
            args.output = str(Path(args.output).with_suffix(".webp"))
        else:
            ext = ".jpg"
            args.output = str(Path(args.output).with_suffix(".jpg"))

    _save_atomic(img, args.output, quality=quality, optimize=True)
    in_size = os.path.getsize(args.input)
    out_size = os.path.getsize(args.output)
    pct = ((in_size - out_size) / in_size * 100) if in_size > 0 else 0
    print(f"Compressed: {in_size} -> {out_size} bytes ({pct:.0f}% reduction) -> {args.output}", file=sys.stderr)
    # Output actual path to stdout (may differ from requested if format was changed)
    print(json.dumps({"output": args.output, "size_bytes": out_size, "reduction_pct": round(pct, 1)}))


def cmd_crop(args: argparse.Namespace) -> None:
    img = _open_image(args.input)
    spec = args.spec

    # Try ratio format: "16:9", "1:1", "4:3"
    ratio_match = re.match(r"(\d+):(\d+)$", spec)
    if ratio_match:
        rw, rh = int(ratio_match.group(1)), int(ratio_match.group(2))
        iw, ih = img.size
        target_ratio = rw / rh
        current_ratio = iw / ih

        if current_ratio > target_ratio:
            # Image is wider than target — crop width
            new_w = int(ih * target_ratio)
            left = (iw - new_w) // 2
            box = (left, 0, left + new_w, ih)
        else:
            # Image is taller than target — crop height
            new_h = int(iw / target_ratio)
            top = (ih - new_h) // 2
            box = (0, top, iw, top + new_h)

        img = img.crop(box)
        _save_atomic(img, args.output)
        print(f"Cropped to {img.size[0]}x{img.size[1]} (ratio {rw}:{rh}) -> {args.output}", file=sys.stderr)
        return

    # Try explicit format: "WxH+X+Y"
    explicit_match = re.match(r"(\d+)[xX](\d+)\+(\d+)\+(\d+)$", spec)
    if explicit_match:
        cw = int(explicit_match.group(1))
        ch = int(explicit_match.group(2))
        cx = int(explicit_match.group(3))
        cy = int(explicit_match.group(4))
        box = (cx, cy, cx + cw, cy + ch)
        img = img.crop(box)
        _save_atomic(img, args.output)
        print(f"Cropped to {img.size[0]}x{img.size[1]} -> {args.output}", file=sys.stderr)
        return

    raise ValueError(f"Invalid crop spec: {spec}. Use ratio (16:9) or explicit (WxH+X+Y)")


def cmd_convert(args: argparse.Namespace) -> None:
    img = _open_image(args.input)
    _save_atomic(img, args.output)
    print(f"Converted to {Path(args.output).suffix} -> {args.output}", file=sys.stderr)


def cmd_info(args: argparse.Namespace) -> None:
    img = _open_image(args.input)
    size_bytes = os.path.getsize(args.input)
    info = {
        "width": img.size[0],
        "height": img.size[1],
        "format": img.format or Path(args.input).suffix.lstrip(".").upper(),
        "size_bytes": size_bytes,
        "mode": img.mode,
        "has_alpha": img.mode in ("RGBA", "LA", "PA"),
    }
    print(json.dumps(info))


def main() -> None:
    parser = argparse.ArgumentParser(description="Image manipulation CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    # resize
    p_resize = sub.add_parser("resize", help="Resize an image")
    p_resize.add_argument("input", help="Input image path")
    p_resize.add_argument("size", help="Target size as WxH")
    p_resize.add_argument("output", help="Output image path")
    p_resize.add_argument("--stretch", action="store_true", help="Force exact dimensions")

    # compress
    p_compress = sub.add_parser("compress", help="Compress an image")
    p_compress.add_argument("input", help="Input image path")
    p_compress.add_argument("output", help="Output image path")
    p_compress.add_argument("quality", type=int, help="Quality 1-100")

    # crop
    p_crop = sub.add_parser("crop", help="Crop an image")
    p_crop.add_argument("input", help="Input image path")
    p_crop.add_argument("output", help="Output image path")
    p_crop.add_argument("spec", help="Crop spec: ratio (16:9) or explicit (WxH+X+Y)")

    # convert
    p_convert = sub.add_parser("convert", help="Convert image format")
    p_convert.add_argument("input", help="Input image path")
    p_convert.add_argument("output", help="Output image path (format from extension)")

    # info
    p_info = sub.add_parser("info", help="Get image info as JSON")
    p_info.add_argument("input", help="Input image path")

    args = parser.parse_args()

    try:
        {"resize": cmd_resize, "compress": cmd_compress, "crop": cmd_crop,
         "convert": cmd_convert, "info": cmd_info}[args.command](args)
    except FileNotFoundError as e:
        print(f"Error: File not found: {e}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
