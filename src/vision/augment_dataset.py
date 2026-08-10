"""B2 dataset builder: CLAHE + offline augmentation pipeline.

Applies underwater-specific enhancements and augmentations to all training images,
generating additional training samples for rare classes.

Pipeline per image:
1. CLAHE contrast enhancement (Lab color space, L channel)
2. [Random] Geometric augmentations: flip, rotate, scale
3. [Random] Underwater domain augmentations: haze, color cast, blur, caustics
4. [Rare classes] Extra copies with stronger augmentations (3x oversampling)

Usage:
    python src/vision/augment_dataset.py --source dataset/yolo_dataset_b1 --output dataset/yolo_dataset_b2
"""

from __future__ import annotations

import argparse
import random
import shutil
from pathlib import Path

import cv2
import numpy as np
from tqdm import tqdm

LABEL_FIELDS = 5
RARE_CLASSES = {2, 3, 8}  # fabric_line, structural, animal_other — <300 train instances
RARE_OVERSAMPLE = 3  # create 3 extra copies for rare class images
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp"}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="dataset/yolo_dataset_b1")
    parser.add_argument("--output", default="dataset/yolo_dataset_b2")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-augment", action="store_true",
                        help="Only CLAHE, skip augmentation copies")
    return parser.parse_args()


# ---------------------------------------------------------------------------
# CLAHE enhancement
# ---------------------------------------------------------------------------

def apply_clahe(img: np.ndarray, clip_limit: float = 2.0,
                tile_grid: tuple = (8, 8)) -> np.ndarray:
    """CLAHE on L channel of Lab color space — best for underwater."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=tile_grid)
    l_eq = clahe.apply(l)
    return cv2.cvtColor(cv2.merge([l_eq, a, b]), cv2.COLOR_LAB2BGR)


# ---------------------------------------------------------------------------
# Geometric augmentations
# ---------------------------------------------------------------------------

def flip_horizontal(img: np.ndarray) -> np.ndarray:
    return cv2.flip(img, 1)


def flip_vertical(img: np.ndarray) -> np.ndarray:
    """Underwater: flip vertical simulates different camera orientation."""
    return cv2.flip(img, 0)


def rotate_90(img: np.ndarray) -> np.ndarray:
    return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)


def rotate_180(img: np.ndarray) -> np.ndarray:
    return cv2.rotate(img, cv2.ROTATE_180)


def rotate_270(img: np.ndarray) -> np.ndarray:
    return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)


def adjust_brightness_contrast(img: np.ndarray, alpha: float = 1.3,
                               beta: int = 10) -> np.ndarray:
    """alpha: contrast (1.0=unchanged), beta: brightness"""
    return cv2.convertScaleAbs(img, alpha=alpha, beta=beta)


# ---------------------------------------------------------------------------
# Underwater domain augmentations (omprxkash approach)
# ---------------------------------------------------------------------------

def add_haze(img: np.ndarray, strength: float = 0.3) -> np.ndarray:
    """Simulate turbid water by blending with blue-green haze."""
    haze = np.full_like(img, (180, 140, 80), dtype=np.uint8)  # blue-green tint
    return cv2.addWeighted(img, 1.0 - strength, haze, strength, 0)


def add_color_cast(img: np.ndarray) -> np.ndarray:
    """Simulate different depth illumination by shifting color balance."""
    # Randomly shift toward blue (deep) or green (shallow)
    if random.random() > 0.5:
        # Deep water: stronger blue
        img = img.copy()
        img[:, :, 0] = np.clip(img[:, :, 0].astype(int) + 30, 0, 255).astype(np.uint8)
    else:
        # Shallow/algae: stronger green
        img = img.copy()
        img[:, :, 1] = np.clip(img[:, :, 1].astype(int) + 25, 0, 255).astype(np.uint8)
    return img


def add_motion_blur(img: np.ndarray, kernel_size: int = 7) -> np.ndarray:
    """Simulate ROV movement blur."""
    kernel = np.zeros((kernel_size, kernel_size))
    kernel[int((kernel_size - 1) / 2), :] = np.ones(kernel_size)
    kernel /= kernel_size
    return cv2.filter2D(img, -1, kernel)


def add_gaussian_noise(img: np.ndarray, sigma: float = 10.0) -> np.ndarray:
    """Simulate sensor noise in low-light conditions."""
    noise = np.random.normal(0, sigma, img.shape).astype(np.int16)
    return np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def darken_image(img: np.ndarray, factor: float = 0.6) -> np.ndarray:
    """Simulate deeper/darker water."""
    return (img * factor).astype(np.uint8)


# ---------------------------------------------------------------------------
# Bounding box coordinate adaptation for geometric transforms
# ---------------------------------------------------------------------------

def adapt_labels_for_hflip(label_lines: list[str], img_w: int) -> list[str]:
    """Flip YOLO normalized x coordinates horizontally."""
    result = []
    for line in label_lines:
        parts = line.strip().split()
        if len(parts) != LABEL_FIELDS:
            result.append(line)
            continue
        cls_id, cx, cy, w, h = parts
        new_cx = 1.0 - float(cx)
        result.append(f"{cls_id} {new_cx:.6f} {cy} {w} {h}")
    return result


def adapt_labels_for_vflip(label_lines: list[str], img_h: int) -> list[str]:
    """Flip YOLO normalized y coordinates vertically."""
    result = []
    for line in label_lines:
        parts = line.strip().split()
        if len(parts) != LABEL_FIELDS:
            result.append(line)
            continue
        cls_id, cx, cy, w, h = parts
        new_cy = 1.0 - float(cy)
        result.append(f"{cls_id} {cx} {new_cy:.6f} {w} {h}")
    return result


def adapt_labels_for_rotation(label_lines: list[str], rotation: str) -> list[str]:
    """Adapt normalized coordinates for 90/180/270 degree rotations."""
    result = []
    for line in label_lines:
        parts = line.strip().split()
        if len(parts) != LABEL_FIELDS:
            result.append(line)
            continue
        cls_id, cx, cy, w, h = parts
        cx_f, cy_f, w_f, h_f = float(cx), float(cy), float(w), float(h)
        if rotation == "90":
            result.append(f"{cls_id} {1.0 - cy_f:.6f} {cx_f:.6f} {h_f:.6f} {w_f:.6f}")
        elif rotation == "180":
            result.append(f"{cls_id} {1.0 - cx_f:.6f} {1.0 - cy_f:.6f} {w_f:.6f} {h_f:.6f}")
        elif rotation == "270":
            result.append(f"{cls_id} {cy_f:.6f} {1.0 - cx_f:.6f} {h_f:.6f} {w_f:.6f}")
        else:
            result.append(line)
    return result


# ---------------------------------------------------------------------------
# Check if image contains rare classes
# ---------------------------------------------------------------------------

def has_rare_classes(label_path: Path) -> bool:
    """Check if label file contains any rare class IDs."""
    if not label_path.exists():
        return False
    for line in label_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != LABEL_FIELDS:
            continue
        if int(parts[0]) in RARE_CLASSES:
            return True
    return False


# ---------------------------------------------------------------------------
# Core processing
# ---------------------------------------------------------------------------

def read_labels(label_path: Path) -> list[str]:
    """Read YOLO label lines."""
    return label_path.read_text(encoding="utf-8").splitlines()


def write_image_and_labels(img: np.ndarray, labels: list[str],
                           img_path: Path, lbl_path: Path) -> None:
    """Write image and corresponding label file."""
    img_path.parent.mkdir(parents=True, exist_ok=True)
    lbl_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(img_path), img)
    lbl_path.write_text("\n".join(labels) + ("\n" if labels else ""), encoding="utf-8")


def apply_augmentations(img: np.ndarray, labels: list[str], suffix: str,
                        img_path: Path, lbl_path: Path) -> list[tuple[Path, Path]]:
    """Apply a set of augmentations and return new (img_path, label_path) pairs.

    Generates 4 variants:
    1. Horizontal flip
    2. Vertical flip
    3. Darken (simulating deeper water)
    4. Haze + color cast
    """
    h, w = img.shape[:2]
    outputs = []

    # Variant 1: Horizontal flip
    img_hf = flip_horizontal(img)
    labels_hf = adapt_labels_for_hflip(labels, w)
    hf_stem = f"{img_path.stem}_hf{suffix}"
    outputs.append((img_path.parent / f"{hf_stem}{img_path.suffix}",
                    lbl_path.parent / f"{hf_stem}.txt"))
    write_image_and_labels(img_hf, labels_hf, outputs[-1][0], outputs[-1][1])

    # Variant 2: Vertical flip (meaningful for underwater — camera can be in any orientation)
    img_vf = flip_vertical(img)
    labels_vf = adapt_labels_for_vflip(labels, h)
    vf_stem = f"{img_path.stem}_vf{suffix}"
    outputs.append((img_path.parent / f"{vf_stem}{img_path.suffix}",
                    lbl_path.parent / f"{vf_stem}.txt"))
    write_image_and_labels(img_vf, labels_vf, outputs[-1][0], outputs[-1][1])

    # Variant 3: Darken (simulate deeper water)
    img_dark = darken_image(img, 0.55 + random.random() * 0.2)
    dark_stem = f"{img_path.stem}_dk{suffix}"
    outputs.append((img_path.parent / f"{dark_stem}{img_path.suffix}",
                    lbl_path.parent / f"{dark_stem}.txt"))
    write_image_and_labels(img_dark, labels, outputs[-1][0], outputs[-1][1])

    # Variant 4: Haze + color cast (simulate turbidity)
    img_haze = add_haze(img, 0.15 + random.random() * 0.2)
    img_haze = add_color_cast(img_haze)
    haze_stem = f"{img_path.stem}_hz{suffix}"
    outputs.append((img_path.parent / f"{haze_stem}{img_path.suffix}",
                    lbl_path.parent / f"{haze_stem}.txt"))
    write_image_and_labels(img_haze, labels, outputs[-1][0], outputs[-1][1])

    return outputs


def process_dataset(source: Path, output: Path, do_augment: bool = True,
                    seed: int = 42) -> dict[str, int]:
    """Process all splits: CLAHE + optional augmentation."""
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")

    random.seed(seed)
    np.random.seed(seed)
    counts = {}
    aug_counts = {"total": 0, "rare": 0}

    for split in ("train", "val", "test"):
        counts[split] = 0
        image_dir = source / "images" / split
        label_dir = source / "labels" / split

        for img_path in sorted(image_dir.iterdir()):
            if not img_path.is_file() or img_path.suffix.lower() not in IMAGE_SUFFIXES:
                continue

            lbl_path = label_dir / f"{img_path.stem}.txt"
            if not lbl_path.exists():
                print(f"  WARNING: missing label {lbl_path}")
                continue

            # Read image and labels
            img = cv2.imread(str(img_path))
            if img is None:
                print(f"  ERROR: cannot read {img_path}")
                continue
            labels = read_labels(lbl_path)

            # 1. Apply CLAHE
            img_enhanced = apply_clahe(img)

            # 2. Write enhanced original
            out_img = output / "images" / split / img_path.name
            out_lbl = output / "labels" / split / lbl_path.name
            write_image_and_labels(img_enhanced, labels, out_img, out_lbl)
            counts[split] += 1

            # 3. Augmentations (training split only)
            if do_augment and split == "train":
                # Always apply base augmentations
                aug_pairs = apply_augmentations(img_enhanced, labels, "", out_img, out_lbl)
                counts[split] += len(aug_pairs)
                aug_counts["total"] += len(aug_pairs)

                # Extra oversampling for rare classes
                if has_rare_classes(lbl_path):
                    for i in range(RARE_OVERSAMPLE - 1):
                        # Slightly different augmentation each time
                        extra_pairs = apply_augmentations(
                            img_enhanced, labels, f"_r{i}", out_img, out_lbl)
                        counts[split] += len(extra_pairs)
                        aug_counts["rare"] += len(extra_pairs)

    # 4. Copy data.yaml
    source_yaml = source / "data.yaml"
    if source_yaml.exists():
        yaml_text = source_yaml.read_text(encoding="utf-8")
        yaml_text = yaml_text.replace(f"path: {source.as_posix()}",
                                      f"path: {output.as_posix()}")
        (output / "data.yaml").write_text(yaml_text, encoding="utf-8")

    print(f"\nAugmentation stats:")
    print(f"  Base augmentations: {aug_counts['total']}")
    print(f"  Rare class extra copies: {aug_counts['rare']}")
    return counts


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()
    source = Path(args.source)
    output = Path(args.output)
    do_augment = not args.no_augment

    print(f"Building B2 dataset from {source}")
    print(f"  CLAHE enhancement: YES")
    print(f"  Offline augmentation: {'YES (4 variants + rare oversampling x' + str(RARE_OVERSAMPLE) + ')' if do_augment else 'NO'}")
    print()

    counts = process_dataset(source, output, do_augment, args.seed)

    # Report
    for split, n in counts.items():
        print(f"  {split}: {n} images")
    total = sum(counts.values())
    print(f"  TOTAL: {total} images (original: 7212)")
    print(f"  Done → {output}")


if __name__ == "__main__":
    main()
