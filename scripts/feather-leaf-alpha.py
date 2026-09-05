#!/usr/bin/env python3

import argparse
import logging
import re
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageFilter
except ImportError as exc:
    raise SystemExit(
        "Pillow is required. Install it with: python -m pip install Pillow"
    ) from exc

DEFAULT_ASSETS_DIR = Path("public/Assets")
DEFAULT_RADIUS = 18.0
DEFAULT_THRESHOLD = 16
OUTPUT_SUFFIX = "-feathered"
LEAF_FILE_PATTERN = re.compile(
    r"^leaf-(green|yellow|whites?)(?:[-_](\d+))?\.png$",
    re.IGNORECASE,
)
ZONE_ALIASES = {
    "green": "green",
    "yellow": "yellow",
    "white": "white",
    "whites": "white",
}

LOGGER = logging.getLogger("leaf-alpha")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Feather leaf PNG alpha while preserving RGB pixels."
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        type=Path,
        help="PNG files to process. If omitted, leaf variants are auto-detected.",
    )
    parser.add_argument(
        "--assets-dir",
        type=Path,
        default=DEFAULT_ASSETS_DIR,
        help=f"Directory used for automatic discovery. Default: {DEFAULT_ASSETS_DIR}.",
    )
    parser.add_argument(
        "--radius",
        type=float,
        default=DEFAULT_RADIUS,
        help=f"Alpha feather radius in pixels. Default: {DEFAULT_RADIUS:g}.",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=DEFAULT_THRESHOLD,
        help=f"Alpha value considered inside the leaf. Default: {DEFAULT_THRESHOLD}.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace source files instead of creating *-feathered.png files.",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.radius <= 0:
        raise ValueError("--radius must be greater than zero")
    if not 0 <= args.threshold <= 255:
        raise ValueError("--threshold must be between 0 and 255")


def select_leaf_variants(entries: list[tuple[Path, int | None]]) -> list[Path]:
    legacy = sorted(
        (path for path, variant in entries if variant is None),
        key=lambda path: path.name,
    )
    numbered = [(path, variant) for path, variant in entries if variant is not None]
    has_explicit_first_variant = any(variant == 1 for _, variant in numbered)
    selected = list(numbered)

    if not has_explicit_first_variant and legacy:
        selected.append((legacy[0], 1))

    if not selected:
        return legacy
    return [
        path
        for path, _ in sorted(selected, key=lambda item: (item[1], item[0].name))
    ]


def discover_leaf_files(assets_dir: Path) -> list[Path]:
    if not assets_dir.is_dir():
        raise FileNotFoundError(assets_dir)

    by_zone: dict[str, list[tuple[Path, int | None]]] = {}
    for path in assets_dir.iterdir():
        if not path.is_file() or OUTPUT_SUFFIX in path.stem:
            continue
        match = LEAF_FILE_PATTERN.fullmatch(path.name)
        if not match:
            continue
        zone = ZONE_ALIASES[match.group(1).lower()]
        variant = int(match.group(2)) if match.group(2) else None
        by_zone.setdefault(zone, []).append((path, variant))

    selected: list[Path] = []
    for zone in sorted(by_zone):
        selected.extend(select_leaf_variants(by_zone[zone]))
    return selected


def output_path(input_path: Path, overwrite: bool) -> Path:
    if overwrite:
        return input_path
    return input_path.with_name(f"{input_path.stem}{OUTPUT_SUFFIX}{input_path.suffix}")


def feather_alpha(input_path: Path, target_path: Path, radius: float, threshold: int) -> None:
    if not input_path.is_file():
        raise FileNotFoundError(input_path)

    with Image.open(input_path) as source:
        image = source.convert("RGBA")

    original_alpha = image.getchannel("A")
    silhouette = original_alpha.point(lambda value: 255 if value > threshold else 0)
    softened_silhouette = silhouette.filter(ImageFilter.GaussianBlur(radius=radius))
    feathered_alpha = ImageChops.multiply(original_alpha, softened_silhouette)
    image.putalpha(feathered_alpha)

    target_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(target_path, format="PNG", optimize=True)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = parse_args()

    try:
        validate_args(args)
        inputs = args.inputs or discover_leaf_files(args.assets_dir)
    except (ValueError, FileNotFoundError) as exc:
        LOGGER.error("%s", exc)
        return 2

    if not inputs:
        LOGGER.error("No leaf PNGs found in %s", args.assets_dir)
        return 1

    LOGGER.info("Discovered %d leaf texture(s)", len(inputs))
    failures = 0
    for input_path in inputs:
        target_path = output_path(input_path, args.overwrite)
        try:
            feather_alpha(input_path, target_path, args.radius, args.threshold)
            LOGGER.info("%s -> %s", input_path, target_path)
        except (FileNotFoundError, OSError) as exc:
            failures += 1
            LOGGER.error("Failed to process %s: %s", input_path, exc)

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
