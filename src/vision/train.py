"""Train the underwater trash detector with a reproducible CLI."""

from __future__ import annotations

import argparse
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="dataset/yolo_dataset/data.yaml")
    parser.add_argument("--model", default="yolo11n.pt")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--device", default="0")
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--name", default="underwater_baseline_v1")
    parser.add_argument("--project", default=None)
    return parser


def train(args: argparse.Namespace) -> None:
    from ultralytics import YOLO

    data_path = Path(args.data)
    model_path = Path(args.model)
    if not data_path.exists():
        raise FileNotFoundError(f"Dataset config not found: {data_path}")
    if not model_path.exists():
        raise FileNotFoundError(f"Model weights not found: {model_path}")

    model = YOLO(str(model_path))
    model.train(
        data=str(data_path),
        epochs=args.epochs,
        batch=args.batch,
        imgsz=args.imgsz,
        device=args.device,
        workers=args.workers,
        name=args.name,
        project=args.project,
        pretrained=True,
        plots=True,
    )


if __name__ == "__main__":
    train(build_parser().parse_args())

