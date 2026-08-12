"""Train the underwater trash detector with a reproducible CLI."""

from __future__ import annotations

import argparse
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="dataset/yolo_dataset_video_split/data.yaml")
    parser.add_argument("--model", default="yolo11s.pt")
    parser.add_argument("--epochs", type=int, default=150)
    parser.add_argument("--patience", type=int, default=30)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--device", default="0")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--cache", default="disk")
    parser.add_argument("--name", default="underwater_v2")
    parser.add_argument("--project", default=None)
    parser.add_argument("--seed", type=int, default=42)
    return parser


def train(args: argparse.Namespace) -> None:
    from ultralytics import YOLO

    data_path = Path(args.data)
    model_path = Path(args.model)
    # Ultralytics auto-downloads recognized pretrained presets such as
    # "yolo11s.pt"; only enforce existence for explicit local paths.
    is_preset = args.model in {"yolo11n.pt", "yolo11s.pt", "yolo11m.pt",
                                "yolo11l.pt", "yolo11x.pt"}
    if not data_path.exists():
        raise FileNotFoundError(f"Dataset config not found: {data_path}")
    if not model_path.exists() and not is_preset:
        raise FileNotFoundError(f"Model weights not found: {model_path}")

    model = YOLO(str(model_path))
    model.train(
        data=str(data_path),
        epochs=args.epochs,
        patience=args.patience,
        batch=args.batch,
        imgsz=args.imgsz,
        device=args.device,
        workers=args.workers,
        cache=args.cache,
        seed=args.seed,
        name=args.name,
        project=args.project,
        pretrained=True,
        # Underwater domain: vertical orientation is rarely meaningful, so
        # flipud is a safe and effective augmentation here.
        flipud=0.5,
        # Keep mosaic for most of training but disable it for the last stretch
        # so the final epochs see realistic full-image samples.
        close_mosaic=15,
        plots=True,
    )


if __name__ == "__main__":
    train(build_parser().parse_args())

