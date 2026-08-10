"""Build B1 dataset: text-overlay removal + class regrouping + stratified video split.

Pipeline:
1. Copy images from source, cropping top text-overlay region
2. Regroup labels: 22 classes → 9 classes
3. Stratified video-ID-based train/val/test split
"""

from __future__ import annotations

import argparse
import random
import re
import shutil
from collections import defaultdict
from pathlib import Path

import cv2

VIDEO_PATTERN = re.compile(r"^(vid_\d+)_frame")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp"}
LABEL_FIELDS = 5

# ---------------------------------------------------------------------------
# Class regrouping: 22 → 9
# ---------------------------------------------------------------------------
# Original → new mapping (0-based)
REGROUP_MAP: dict[int, int] = {
    # rov (0) → 0  rov
    0: 0,
    # trash_rigid: bottle(10)+can(13)+cup(14)+container(15) → 1
    10: 1, 13: 1, 14: 1, 15: 1,
    # trash_fabric_line: clothing(8)+tarp(19)+rope(20)+net(21) → 2
    8: 2, 19: 2, 20: 2, 21: 2,
    # trash_structural: pipe(9)+branch(17)+wreckage(18) → 3
    9: 3, 17: 3, 18: 3,
    # trash_bag_wrapper: bag(11)+snack_wrapper(12) → 4
    11: 4, 12: 4,
    # trash_unknown_instance(16) → 5
    16: 5,
    # animal_fish_eel: fish(2)+eel(6) → 6
    2: 6, 6: 6,
    # animal_shellfish: starfish(3)+shells(4)+crab(5) → 7
    3: 7, 4: 7, 5: 7,
    # animal_other: plant(1)+etc(7) → 8
    1: 8, 7: 8,
}

NEW_NAMES: dict[int, str] = {
    0: "rov",
    1: "trash_rigid",
    2: "trash_fabric_line",
    3: "trash_structural",
    4: "trash_bag_wrapper",
    5: "trash_unknown_instance",
    6: "animal_fish_eel",
    7: "animal_shellfish",
    8: "animal_other",
}

NC = 9
TEXT_CROP_TOP = 45  # pixels to crop from top to remove overlay text


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="dataset/yolo_dataset")
    parser.add_argument("--output", default="dataset/yolo_dataset_b1")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--train-ratio", type=float, default=0.70)
    parser.add_argument("--val-ratio", type=float, default=0.20)
    parser.add_argument("--min-instances", type=int, default=5)
    parser.add_argument("--crop-top", type=int, default=45,
                        help="Pixels to crop from top (0 to disable)")
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Data collection
# ---------------------------------------------------------------------------

def video_id(image_path: Path) -> str:
    match = VIDEO_PATTERN.match(image_path.stem)
    if not match:
        raise ValueError(f"Cannot extract video ID from filename: {image_path.name}")
    return match.group(1)


def collect_groups(source: Path) -> dict[str, list[Path]]:
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
                old_cls = int(fields[0])
                new_cls = REGROUP_MAP.get(old_cls, -1)
                if new_cls < 0:
                    continue  # skip unmapped classes (shouldn't happen)
                cat_counts[new_cls] += 1
                cat_totals[new_cls] += 1
        video_cats[vid] = dict(cat_counts)
    return video_cats, dict(cat_totals)


# ---------------------------------------------------------------------------
# Stratified assignment (same algorithm as A4)
# ---------------------------------------------------------------------------

def assign_groups_stratified(
    groups, video_cats, cat_totals, seed, train_ratio, val_ratio, min_instances=5,
):
    total_images = sum(len(imgs) for imgs in groups.values())
    targets = {
        "train": total_images * train_ratio,
        "val": total_images * val_ratio,
        "test": total_images * (1 - train_ratio - val_ratio),
    }
    rng = random.Random(seed)
    unassigned = set(groups)
    assignment: dict[str, str] = {}
    split_images = {"train": 0, "val": 0, "test": 0}
    split_cats = {s: defaultdict(int) for s in ("train", "val", "test")}

    def _best_video_for(target_cls, target_split, pool):
        best_vid, best_score = None, -1.0
        for vid in pool:
            vid_cats = video_cats.get(vid, {})
            count = vid_cats.get(target_cls, 0)
            if count == 0:
                continue
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

    def _secure_split(split_name):
        for _round in range(len(cat_totals) * 5):
            biggest_gap, neediest = 0, -1
            candidates = sorted(cat_totals)
            rng.shuffle(candidates)
            for cls in candidates:
                current = split_cats[split_name].get(cls, 0)
                if current < min_instances:
                    gap = (min_instances - current) / max(min_instances, 1)
                    if gap > biggest_gap:
                        biggest_gap = gap
                        neediest = cls
            if neediest < 0:
                break
            vid = _best_video_for(neediest, split_name, unassigned)
            if vid is None:
                break
            if split_images[split_name] >= targets[split_name] * 1.15:
                break
            unassigned.remove(vid)
            assignment[vid] = split_name
            split_images[split_name] += len(groups[vid])
            for cls, count in video_cats.get(vid, {}).items():
                split_cats[split_name][cls] += count

    _secure_split("test")
    _secure_split("val")

    remaining = sorted(unassigned, key=lambda v: len(groups[v]), reverse=True)
    for vid in remaining:
        deficits = {
            s: max(0.0, targets[s] - split_images[s]) / max(targets[s], 1)
            for s in ("train", "val", "test")
        }
        if split_images["val"] >= targets["val"] * 0.95:
            deficits["val"] *= 0.3
        if split_images["test"] >= targets["test"] * 0.95:
            deficits["test"] *= 0.3
        best = max(deficits, key=deficits.get)
        assignment[vid] = best
        split_images[best] += len(groups[vid])
        for cls, count in video_cats.get(vid, {}).items():
            split_cats[best][cls] += count

    # Report
    print("\n=== B1 Split assignment ===")
    for s in ("train", "val", "test"):
        pct = split_images[s] / targets[s] * 100 if targets[s] > 0 else 0
        print(f"  {s}: {split_images[s]} images ({pct:.0f}% of target)")
    for split in ("val", "test"):
        below = [(c, split_cats[split].get(c, 0)) for c in sorted(cat_totals)
                 if split_cats[split].get(c, 0) < min_instances]
        if below:
            print(f"\n  {split} below {min_instances} instances:")
            for cls, cnt in sorted(below, key=lambda x: x[1]):
                print(f"    {NEW_NAMES.get(cls, f'class_{cls}')}: {cnt}")
        else:
            print(f"\n  {split}: all {NC} classes >= {min_instances} instances  ✓")

    return assignment


# ---------------------------------------------------------------------------
# File copying with text removal and label regrouping
# ---------------------------------------------------------------------------

def copy_b1(source: Path, output: Path, groups: dict[str, list[Path]],
            assignment: dict[str, str], crop_top: int) -> dict[str, int]:
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")

    counts = {split: 0 for split in ("train", "val", "test")}
    duplicate_labels_removed = 0
    crops_done = 0

    for group, images in groups.items():
        split = assignment[group]
        for image_path in images:
            source_split = image_path.parent.name
            label_path = source / "labels" / source_split / f"{image_path.stem}.txt"
            if not label_path.exists():
                raise FileNotFoundError(f"Missing label: {label_path}")

            # --- Read image (needed for height) ---
            img = cv2.imread(str(image_path))
            if img is None:
                raise ValueError(f"Cannot read image: {image_path}")
            orig_h, orig_w = img.shape[:2]

            # --- Crop image ---
            if crop_top > 0 and orig_h > crop_top:
                img = img[crop_top:orig_h, :, :]
                crops_done += 1

            image_target = output / "images" / split / image_path.name
            image_target.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(image_target), img)

            new_h = orig_h - crop_top if (crop_top > 0 and orig_h > crop_top) else orig_h

            # --- Regroup & deduplicate labels ---
            label_lines = []
            seen_lines = set()
            for raw_line in label_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                fields = line.split()
                if len(fields) != LABEL_FIELDS:
                    raise ValueError(f"Invalid YOLO label in {label_path}: {line}")
                old_cls = int(fields[0])
                new_cls = REGROUP_MAP.get(old_cls, -1)
                if new_cls < 0:
                    continue
                cx = float(fields[1])
                cy = float(fields[2])
                w = float(fields[3])
                h = float(fields[4])

                # Adjust for top crop: shift y and scale
                if crop_top > 0 and orig_h > crop_top:
                    abs_cy = cy * orig_h
                    abs_h = h * orig_h
                    new_abs_cy = abs_cy - crop_top
                    new_cy = new_abs_cy / new_h
                    new_norm_h = abs_h / new_h
                    # Drop boxes that are mostly out of frame
                    if new_abs_cy + abs_h / 2 < 0:
                        continue
                    if new_cy > 1.0:
                        new_cy = min(new_cy, 1.0)
                    if new_norm_h > 1.0:
                        new_norm_h = 1.0
                else:
                    new_cy, new_norm_h = cy, h

                new_line = f"{new_cls} {cx:.6f} {new_cy:.6f} {w:.6f} {new_norm_h:.6f}"
                if new_line in seen_lines:
                    duplicate_labels_removed += 1
                    continue
                seen_lines.add(new_line)
                label_lines.append(new_line)

            label_target = output / "labels" / split / label_path.name
            label_target.parent.mkdir(parents=True, exist_ok=True)
            label_target.write_text(
                "\n".join(label_lines) + ("\n" if label_lines else ""),
                encoding="utf-8")
            counts[split] += 1

    # --- Write data.yaml ---
    _write_data_yaml(output)
    print(f"Images cropped (top {crop_top}px): {crops_done}")
    print(f"Duplicate label rows removed: {duplicate_labels_removed}")
    return counts


def _write_data_yaml(output: Path) -> None:
    lines = [
        f"# B1 dataset: class-regrouped + text-cropped + video-stratified",
        f"# Original: TrashCan 1.0 Instance Version (22 classes → {NC} classes)",
        f"",
        f"path: {output.as_posix()}",
        f"train: images/train",
        f"val: images/val",
        f"test: images/test",
        f"",
        f"nc: {NC}",
        f"",
        f"names:",
    ]
    for cls_id in range(NC):
        lines.append(f"  {cls_id}: {NEW_NAMES[cls_id]}")
    (output / "data.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")


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

    print(f"Scanning labels for regrouped category distribution ...")
    video_cats, cat_totals = collect_category_info(source, groups)
    print(f"  {len(cat_totals)} regrouped categories ({NC} expected)")
    for cls_id in range(NC):
        print(f"    {NEW_NAMES[cls_id]:>25s}: {cat_totals.get(cls_id, 0):>5d} instances")

    print(f"\nStratified assignment (min-instances={args.min_instances}) ...")
    assignment = assign_groups_stratified(
        groups, video_cats, cat_totals, args.seed,
        args.train_ratio, args.val_ratio, args.min_instances,
    )

    print(f"\nCopying files (crop_top={args.crop_top}, regroup 22→{NC} classes) ...")
    counts = copy_b1(source, output, groups, assignment, args.crop_top)

    split_groups = {s: sum(1 for v in assignment.values() if v == s)
                    for s in ("train", "val", "test")}
    print(f"\nCreated {output}")
    print(f"Images: {counts}")
    print(f"Video groups: {split_groups}")
    print(f"Classes: {NC} (down from 22)")
    print(f"Done.")


if __name__ == "__main__":
    main()
