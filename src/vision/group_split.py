"""Create a leakage-resistant YOLO split by grouping frames by video ID."""

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="dataset/yolo_dataset")
    parser.add_argument("--output", default="dataset/yolo_dataset_video_split")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--train-ratio", type=float, default=0.70)
    parser.add_argument("--val-ratio", type=float, default=0.20)
    return parser.parse_args()


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


def assign_groups(groups: dict[str, list[Path]], seed: int,
                  train_ratio: float, val_ratio: float) -> dict[str, str]:
    if train_ratio <= 0 or val_ratio <= 0 or train_ratio + val_ratio >= 1:
        raise ValueError("train-ratio and val-ratio must be positive and sum to less than 1")

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
    yaml_text = re.sub(r"^path:.*$", "path: dataset/yolo_dataset_video_split", yaml_text, flags=re.MULTILINE)
    yaml_text = re.sub(r"^train:.*$", "train: images/train", yaml_text, flags=re.MULTILINE)
    yaml_text = re.sub(r"^val:.*$", "val: images/val", yaml_text, flags=re.MULTILINE)
    yaml_text = re.sub(r"^test:.*$", "test: images/test", yaml_text, flags=re.MULTILINE)
    (output / "data.yaml").write_text(yaml_text, encoding="utf-8")
    print(f"Duplicate label rows removed: {duplicate_labels_removed}")
    return counts


def validate_assignment(assignment: dict[str, str]) -> None:
    groups_by_split: dict[str, set[str]] = defaultdict(set)
    for group, split in assignment.items():
        groups_by_split[split].add(group)
    if sum(len(groups) for groups in groups_by_split.values()) != len(assignment):
        raise AssertionError("A video ID was assigned to more than one split")


def main() -> None:
    args = parse_args()
    source = Path(args.source)
    output = Path(args.output)
    groups = collect_groups(source)
    assignment = assign_groups(groups, args.seed, args.train_ratio, args.val_ratio)
    validate_assignment(assignment)
    counts = copy_split(source, output, groups, assignment)
    split_groups = {split: sum(1 for value in assignment.values() if value == split)
                    for split in ("train", "val", "test")}
    print(f"Created {output}")
    print(f"Images: {counts}; video groups: {split_groups}")
    print(f"Total groups: {len(groups)}; seed: {args.seed}")


if __name__ == "__main__":
    main()
