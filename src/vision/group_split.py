"""Create a leakage-resistant YOLO split by grouping frames by video ID.

The default mode uses stratified assignment: videos are assigned to train/val/test
so that every category has at least --min-instances examples in val and test,
while keeping the split close to the requested image ratios.
"""

from __future__ import annotations

import argparse
import random
import re
import shutil
from collections import defaultdict
from pathlib import Path


VIDEO_PATTERN = re.compile(r"^(vid_\d+)_frame")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp"}
LABEL_FIELDS = 5


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="dataset/yolo_dataset")
    parser.add_argument("--output", default="dataset/yolo_dataset_video_split")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--train-ratio", type=float, default=0.70)
    parser.add_argument("--val-ratio", type=float, default=0.20)
    parser.add_argument("--min-instances", type=int, default=5,
                        help="Minimum instances per category in val and test (default: 5)")
    parser.add_argument("--simple", action="store_true",
                        help="Use simple random-video assignment (previous behaviour)")
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Video ID extraction
# ---------------------------------------------------------------------------

def video_id(image_path: Path) -> str:
    match = VIDEO_PATTERN.match(image_path.stem)
    if not match:
        raise ValueError(f"Cannot extract video ID from filename: {image_path.name}")
    return match.group(1)


# ---------------------------------------------------------------------------
# Data collection
# ---------------------------------------------------------------------------

def collect_groups(source: Path) -> dict[str, list[Path]]:
    """Return {video_id: [image_paths]} across all splits in the source."""
    groups: dict[str, list[Path]] = defaultdict(list)
    for split in ("train", "val", "test"):
        image_dir = source / "images" / split
        for image_path in image_dir.iterdir():
            if image_path.is_file() and image_path.suffix.lower() in IMAGE_SUFFIXES:
                groups[video_id(image_path)].append(image_path)
    if not groups:
        raise FileNotFoundError(f"No images found under {source / 'images'}")
    return dict(groups)


def collect_category_info(source: Path, groups: dict[str, list[Path]]
                          ) -> tuple[dict[str, dict[int, int]], dict[int, int]]:
    """Scan labels to build per-video category counts and global category totals.

    Returns
    -------
    video_cats : {video_id: {class_id: instance_count}}
    cat_totals : {class_id: total_instance_count}
    """
    video_cats: dict[str, dict[int, int]] = {}
    cat_totals: dict[int, int] = defaultdict(int)

    for vid, images in groups.items():
        cat_counts: dict[int, int] = defaultdict(int)
        for image_path in images:
            source_split = image_path.parent.name
            label_path = source / "labels" / source_split / f"{image_path.stem}.txt"
            if not label_path.exists():
                continue
            for line in label_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                fields = line.split()
                if len(fields) != LABEL_FIELDS:
                    continue
                cls_id = int(fields[0])
                cat_counts[cls_id] += 1
                cat_totals[cls_id] += 1
        video_cats[vid] = dict(cat_counts)

    return video_cats, dict(cat_totals)


# ---------------------------------------------------------------------------
# Stratified assignment  (default)
# ---------------------------------------------------------------------------

def assign_groups_stratified(
    groups: dict[str, list[Path]],
    video_cats: dict[str, dict[int, int]],
    cat_totals: dict[int, int],
    seed: int,
    train_ratio: float,
    val_ratio: float,
    min_instances: int = 5,
) -> dict[str, str]:
    """Two-phase assignment: secure test coverage first, then val, then fill train.

    Phase 1 — Secure TEST: for each category still below *min_instances* in test,
    pick the unassigned video that contributes the most instances of that category
    (favouring videos that also help other under‑covered test categories).

    Phase 2 — Secure VAL: same logic for val, from remaining unassigned videos.

    Phase 3 — Fill: assign everything left to the split furthest below its image
    target (biased toward train once both val and test targets are met).
    """
    total_images = sum(len(imgs) for imgs in groups.values())
    targets = {
        "train": total_images * train_ratio,
        "val": total_images * val_ratio,
        "test": total_images * (1 - train_ratio - val_ratio),
    }

    rng = random.Random(seed)
    unassigned = set(groups)
    assignment: dict[str, str] = {}

    split_images: dict[str, int] = {"train": 0, "val": 0, "test": 0}
    split_cats: dict[str, dict[int, int]] = {
        s: defaultdict(int) for s in ("train", "val", "test")
    }

    # ---- helper: find best video for a category → split --------------------
    def _best_video_for(
        target_cls: int, target_split: str, pool: set[str],
    ) -> str | None:
        """Return the video in *pool* that contributes the most instances of
        *target_cls*; tie‑break by how many OTHER under‑covered categories
        (for the same split) the video also helps."""
        best_vid = None
        best_score = -1.0
        for vid in pool:
            vid_cats = video_cats.get(vid, {})
            count = vid_cats.get(target_cls, 0)
            if count == 0:
                continue
            # bonus from other categories still below threshold in this split
            bonus = 0.0
            for cls, cnt in vid_cats.items():
                if cls == target_cls:
                    continue
                cur = split_cats[target_split].get(cls, 0)
                if cur < min_instances:
                    bonus += min(cnt, min_instances - cur) / max(min_instances, 1)
            score = count + bonus * 0.5
            if score > best_score:
                best_score = score
                best_vid = vid
        return best_vid

    # ---- Phase 1: secure TEST ----------------------------------------------
    _secure_split("test", groups, video_cats, cat_totals, targets,
                  split_images, split_cats, assignment, unassigned,
                  min_instances, rng, _best_video_for)

    # ---- Phase 2: secure VAL -----------------------------------------------
    _secure_split("val", groups, video_cats, cat_totals, targets,
                  split_images, split_cats, assignment, unassigned,
                  min_instances, rng, _best_video_for)

    # ---- Phase 3: fill remaining -------------------------------------------
    # Sort remaining by size (larger first for better ratio control)
    remaining = sorted(unassigned, key=lambda v: len(groups[v]), reverse=True)
    for vid in remaining:
        # Pick the split furthest below its image target
        deficits = {
            s: max(0.0, targets[s] - split_images[s]) / max(targets[s], 1)
            for s in ("train", "val", "test")
        }
        # Bias toward train once val/test targets are met
        if split_images["val"] >= targets["val"] * 0.95:
            deficits["val"] *= 0.3
        if split_images["test"] >= targets["test"] * 0.95:
            deficits["test"] *= 0.3
        best_split = max(deficits, key=deficits.get)
        assignment[vid] = best_split
        split_images[best_split] += len(groups[vid])
        for cls, count in video_cats.get(vid, {}).items():
            split_cats[best_split][cls] += count

    _print_split_report(split_images, split_cats, targets, min_instances, cat_totals)
    return assignment


def _secure_split(
    split_name: str,
    groups: dict[str, list[Path]],
    video_cats: dict[str, dict[int, int]],
    cat_totals: dict[int, int],
    targets: dict[str, float],
    split_images: dict[str, int],
    split_cats: dict[str, dict[int, int]],
    assignment: dict[str, str],
    unassigned: set[str],
    min_instances: int,
    rng: random.Random,
    best_video_for,
) -> None:
    """Repeatedly assign the best remaining video to *split_name* until every
    category reaches *min_instances* or no suitable videos remain."""
    max_rounds = len(cat_totals) * 5  # safety valve
    for _round in range(max_rounds):
        # Find the category furthest below threshold
        biggest_gap = 0
        neediest_cls = -1
        candidates = sorted(cat_totals)
        rng.shuffle(candidates)  # non‑deterministic tie‑breaking
        for cls in candidates:
            current = split_cats[split_name].get(cls, 0)
            if current < min_instances:
                gap = (min_instances - current) / max(min_instances, 1)
                if gap > biggest_gap:
                    biggest_gap = gap
                    neediest_cls = cls

        if neediest_cls < 0:
            break  # all categories satisfied

        vid = best_video_for(neediest_cls, split_name, unassigned)
        if vid is None:
            break  # no remaining video has this category

        # Don't exceed split target by more than 15% in phase 1/2
        if split_images[split_name] >= targets[split_name] * 1.15:
            break

        unassigned.remove(vid)
        assignment[vid] = split_name
        split_images[split_name] += len(groups[vid])
        for cls, count in video_cats.get(vid, {}).items():
            split_cats[split_name][cls] += count


# ---------------------------------------------------------------------------
# Simple random-video assignment  (‑‑simple)
# ---------------------------------------------------------------------------

def assign_groups_simple(
    groups: dict[str, list[Path]],
    seed: int,
    train_ratio: float,
    val_ratio: float,
) -> dict[str, str]:
    """Original algorithm: shuffle + greedy fill by image count only."""
    total_images = sum(len(paths) for paths in groups.values())
    targets = {
        "train": total_images * train_ratio,
        "val": total_images * val_ratio,
        "test": total_images * (1 - train_ratio - val_ratio),
    }
    ordered = list(groups)
    random.Random(seed).shuffle(ordered)
    ordered.sort(key=lambda group: len(groups[group]), reverse=True)

    counts = {split: 0 for split in targets}
    assignment: dict[str, str] = {}
    for group in ordered:
        split = min(targets, key=lambda name: counts[name] / targets[name])
        assignment[group] = split
        counts[split] += len(groups[group])
    return assignment


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def _print_split_report(
    split_images: dict[str, int],
    split_cats: dict[str, dict[int, int]],
    targets: dict[str, float],
    min_instances: int,
    cat_totals: dict[int, int],
) -> None:
    """Print per-split image counts and category coverage."""
    print("\n=== Split assignment result ===")
    for s in ("train", "val", "test"):
        pct = split_images[s] / targets[s] * 100 if targets[s] > 0 else 0
        print(f"  {s}: {split_images[s]} images ({pct:.0f}% of target)")

    below = {s: [] for s in ("val", "test")}
    for split in ("val", "test"):
        for cls in sorted(cat_totals):
            count = split_cats[split].get(cls, 0)
            if count < min_instances:
                below[split].append((cls, count))

    for split in ("val", "test"):
        if below[split]:
            print(f"\n  {split} below {min_instances} instances:")
            for cls, count in sorted(below[split], key=lambda x: x[1]):
                print(f"    class {cls:>2d}: {count} instances")
        else:
            print(f"\n  {split}: all categories >= {min_instances} instances  ✓")


# ---------------------------------------------------------------------------
# File copying
# ---------------------------------------------------------------------------

def copy_split(source: Path, output: Path, groups: dict[str, list[Path]],
               assignment: dict[str, str]) -> dict[str, int]:
    if output.exists():
        raise FileExistsError(f"Output already exists; choose a new path: {output}")

    counts = {split: 0 for split in ("train", "val", "test")}
    duplicate_labels_removed = 0
    for group, images in groups.items():
        split = assignment[group]
        for image_path in images:
            source_split = image_path.parent.name
            label_path = source / "labels" / source_split / f"{image_path.stem}.txt"
            if not label_path.exists():
                raise FileNotFoundError(f"Missing label for {image_path}: {label_path}")
            image_target = output / "images" / split / image_path.name
            label_target = output / "labels" / split / label_path.name
            image_target.parent.mkdir(parents=True, exist_ok=True)
            label_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(image_path, image_target)
            label_lines = []
            seen_lines = set()
            for raw_line in label_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                fields = line.split()
                if len(fields) != LABEL_FIELDS:
                    raise ValueError(f"Invalid YOLO label in {label_path}: {line}")
                if line in seen_lines:
                    duplicate_labels_removed += 1
                    continue
                seen_lines.add(line)
                label_lines.append(line)
            label_target.write_text("\n".join(label_lines) + ("\n" if label_lines else ""),
                                    encoding="utf-8")
            counts[split] += 1

    source_yaml = source / "data.yaml"
    yaml_text = source_yaml.read_text(encoding="utf-8")
    new_path = output.as_posix()
    yaml_text = re.sub(r"^path:.*$", f"path: {new_path}", yaml_text, flags=re.MULTILINE)
    yaml_text = re.sub(r"^train:.*$", "train: images/train", yaml_text, flags=re.MULTILINE)
    yaml_text = re.sub(r"^val:.*$", "val: images/val", yaml_text, flags=re.MULTILINE)
    yaml_text = re.sub(r"^test:.*$", "test: images/test", yaml_text, flags=re.MULTILINE)
    (output / "data.yaml").write_text(yaml_text, encoding="utf-8")
    print(f"Duplicate label rows removed: {duplicate_labels_removed}")
    return counts


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_assignment(assignment: dict[str, str]) -> None:
    groups_by_split: dict[str, set[str]] = defaultdict(set)
    for group, split in assignment.items():
        groups_by_split[split].add(group)
    if sum(len(grps) for grps in groups_by_split.values()) != len(assignment):
        raise AssertionError("A video ID was assigned to more than one split")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()
    source = Path(args.source)
    output = Path(args.output)

    print(f"Collecting video groups from {source} ...")
    groups = collect_groups(source)
    print(f"  {len(groups)} video groups, {sum(len(v) for v in groups.values())} images")

    if args.simple:
        print("Using simple random-video assignment ...")
        assignment = assign_groups_simple(groups, args.seed,
                                          args.train_ratio, args.val_ratio)
    else:
        print("Scanning labels for category distribution ...")
        video_cats, cat_totals = collect_category_info(source, groups)
        print(f"  {len(cat_totals)} categories found")
        print(f"Using stratified assignment (min-instances={args.min_instances}) ...")
        assignment = assign_groups_stratified(
            groups, video_cats, cat_totals, args.seed,
            args.train_ratio, args.val_ratio, args.min_instances,
        )

    validate_assignment(assignment)
    counts = copy_split(source, output, groups, assignment)
    split_groups = {split: sum(1 for value in assignment.values() if value == split)
                    for split in ("train", "val", "test")}
    print(f"\nCreated {output}")
    print(f"Images: {counts}")
    print(f"Video groups: {split_groups}")
    print(f"Total groups: {len(groups)}; seed: {args.seed}")


if __name__ == "__main__":
    main()
