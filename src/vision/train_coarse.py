"""Train the underwater trash detector — coarse 5-class recipe.

Evidence-based configuration (choices traced to experiments in this repo):
  - SGD + cos_lr: proven TrashCan recipe (C1, B1-Final, crsprunger)
  - imgsz=640: C1 used 480 and small-target classes (trash_easy/heavy) had
    AP < 0.16.  640 is the standard YOLO training size and gives the network
    a larger pixel canvas, though the source images (480×270/360) are only
    upscaled — whether this helps is to be confirmed by the run itself.
  - copy_paste=0.1: crsprunger-validated for underwater occlusion robustness
  - mosaic + close_mosaic=15: standard; turn off mosaic last 15 epochs
  - patience=30: C1 plateaued by epoch ~52; 100 epochs + patience=30 stops early

C1 reference run (imgsz=480, yolo11s, 60 ep): val mAP@50=0.283, best at ep52.
This script's defaults are C1 + imgsz 640 + longer schedule.
"""

from __future__ import annotations

import argparse
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", default="dataset/yolo_dataset_coarse/data.yaml")
    p.add_argument("--model", default="yolo11s.pt")
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--batch", type=int, default=16)
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--device", default="0")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--cache", default="disk")
    p.add_argument("--freeze", type=int, default=0,
                   help="Freeze first N layers for entire run (0=none, 10=backbone).")
    p.add_argument("--seed", type=int, default=42,
                   help="Random seed (B0 random-frame baseline used seed=0).")
    p.add_argument("--lr0", type=float, default=0.01,
                   help="Initial learning rate; use a lower value for checkpoint fine-tuning.")
    p.add_argument("--patience", type=int, default=30)
    p.add_argument("--name", default="coarse_c3")
    p.add_argument("--smoke", action="store_true", help="3-epoch pipeline test")
    return p


def train(args: argparse.Namespace) -> None:
    from ultralytics import YOLO

    data_path = Path(args.data)
    if not data_path.exists():
        raise FileNotFoundError(f"Dataset config not found: {data_path}")

    epochs = 3 if args.smoke else args.epochs
    name = args.name + "_smoke" if args.smoke else args.name

    model = YOLO(args.model)
    train_kwargs = dict(
        data=str(data_path),
        epochs=epochs,
        batch=args.batch,
        imgsz=args.imgsz,
        device=args.device,
        workers=args.workers,
        cache=args.cache,
        name=name,
        project=None,
        pretrained=True,
        optimizer="SGD",
        lr0=args.lr0,
        lrf=0.01,
        cos_lr=True,
        momentum=0.937,
        weight_decay=0.0005,
        warmup_epochs=3.0,
        mosaic=1.0,
        close_mosaic=15,
        copy_paste=0.1,
        fliplr=0.5,
        hsv_h=0.015,
        hsv_s=0.7,
        hsv_v=0.4,
        scale=0.5,
        translate=0.1,
        patience=args.patience,
        seed=args.seed,
        plots=True,
        amp=True,
    )
    if args.freeze > 0:
        train_kwargs["freeze"] = args.freeze
    model.train(**train_kwargs)


if __name__ == "__main__":
    train(build_parser().parse_args())
