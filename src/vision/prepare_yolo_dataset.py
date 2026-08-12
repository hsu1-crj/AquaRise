"""Convert the local TrashCan COCO dataset to a validated YOLO layout.

Images are hard-linked when possible so preparing a dataset does not duplicate
several gigabytes of image data. COCO boxes are clipped to image bounds before
normalization because the upstream annotations may exceed an edge by one pixel.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
from collections import defaultdict
from pathlib import Path
from typing import Any

SPLITS = ("train", "val")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        default="dataset/dataset/dataset/instance_version",
        help="Directory containing COCO JSON files and train/val images",
    )
    parser.add_argument("--output", default="dataset/yolo_dataset")
    return parser


def _load_coco(source: Path, split: str) -> dict[str, Any]:
    path = source / f"instances_{split}_trashcan.json"
    if not path.is_file():
        raise FileNotFoundError(f"COCO annotation file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _link_or_copy(source: Path, target: Path) -> None:
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def _clip_box(
    bbox: list[float], image_width: int, image_height: int
) -> tuple[float, float, float, float] | None:
    x, y, width, height = map(float, bbox)
    x1 = min(max(x, 0.0), float(image_width))
    y1 = min(max(y, 0.0), float(image_height))
    x2 = min(max(x + width, 0.0), float(image_width))
    y2 = min(max(y + height, 0.0), float(image_height))
    if x2 <= x1 or y2 <= y1:
        return None
    return (
        (x1 + x2) / (2.0 * image_width),
        (y1 + y2) / (2.0 * image_height),
        (x2 - x1) / image_width,
        (y2 - y1) / image_height,
    )


def _category_map(datasets: list[dict[str, Any]]) -> tuple[dict[int, int], list[str]]:
    category_names: dict[int, str] = {}
    for dataset in datasets:
        current = {int(item["id"]): str(item["name"]) for item in dataset["categories"]}
        if category_names and current != category_names:
            raise ValueError("COCO category definitions differ between splits")
        category_names = current
    ordered_ids = sorted(category_names)
    return (
        {category_id: index for index, category_id in enumerate(ordered_ids)},
        [category_names[category_id] for category_id in ordered_ids],
    )


def _write_yaml(output: Path, names: list[str]) -> None:
    lines = [
        f"path: {output.resolve().as_posix()}",
        "train: images/train",
        "val: images/val",
        "",
        f"nc: {len(names)}",
        "names:",
    ]
    lines.extend(f"  {index}: {name}" for index, name in enumerate(names))
    (output / "data.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def convert(source: Path, output: Path) -> dict[str, int]:
    if output.exists():
        raise FileExistsError(f"Output already exists; choose a new path: {output}")

    datasets = [_load_coco(source, split) for split in SPLITS]
    category_ids, names = _category_map(datasets)
    counts: dict[str, int] = defaultdict(int)

    for split, dataset in zip(SPLITS, datasets, strict=True):
        images = {int(item["id"]): item for item in dataset["images"]}
        annotations: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for annotation in dataset["annotations"]:
            image_id = int(annotation["image_id"])
            if image_id not in images:
                raise ValueError(f"Annotation references unknown image ID {image_id}")
            annotations[image_id].append(annotation)

        image_output = output / "images" / split
        label_output = output / "labels" / split
        image_output.mkdir(parents=True, exist_ok=True)
        label_output.mkdir(parents=True, exist_ok=True)

        for image_id, image in images.items():
            file_name = Path(str(image["file_name"])).name
            image_source = source / split / file_name
            if not image_source.is_file():
                raise FileNotFoundError(f"Image listed by COCO is missing: {image_source}")
            _link_or_copy(image_source, image_output / file_name)

            width = int(image["width"])
            height = int(image["height"])
            label_lines: list[str] = []
            seen: set[str] = set()
            for annotation in annotations.get(image_id, []):
                normalized = _clip_box(annotation["bbox"], width, height)
                if normalized is None:
                    counts["dropped_boxes"] += 1
                    continue
                class_id = category_ids[int(annotation["category_id"])]
                line = f"{class_id} " + " ".join(f"{value:.6f}" for value in normalized)
                if line in seen:
                    counts["duplicate_boxes"] += 1
                    continue
                seen.add(line)
                label_lines.append(line)
                counts["boxes"] += 1

            (label_output / f"{Path(file_name).stem}.txt").write_text(
                "\n".join(label_lines) + ("\n" if label_lines else ""),
                encoding="utf-8",
            )
            counts[f"{split}_images"] += 1

    _write_yaml(output, names)
    counts["classes"] = len(names)
    return dict(counts)


def main() -> None:
    args = build_parser().parse_args()
    counts = convert(Path(args.source), Path(args.output))
    print(f"Created {args.output}")
    for name, count in counts.items():
        print(f"  {name}: {count}")


if __name__ == "__main__":
    main()
