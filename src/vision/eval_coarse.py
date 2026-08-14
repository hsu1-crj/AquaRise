# Fix eval_coarse.py per-class mapping bug
"""Evaluate a trained coarse model on val/test with CORRECT per-class mapping.

Previous version used enumerate(metrics.box.maps) + names[i], which could
mismatch when Ultralytics internally reorders classes. This version uses
metrics.box.ap_class_index to map AP values back to true class IDs.

Usage:
    python src/vision/eval_coarse.py --model runs/detect/pooled_final/weights/best.pt
    python src/vision/eval_coarse.py --model ... --tta
"""

from __future__ import annotations

import argparse
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", required=True, help="Path to best.pt")
    p.add_argument("--data", default="dataset/yolo_pooled/data.yaml")
    p.add_argument("--split", default="test", choices=["val", "test"])
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--batch", type=int, default=16)
    p.add_argument("--device", default="0")
    p.add_argument("--workers", type=int, default=0)
    p.add_argument("--tta", action="store_true", help="Enable test-time augmentation")
    p.add_argument("--name", default=None, help="Override run name")
    return p


def evaluate(args: argparse.Namespace) -> None:
    from ultralytics import YOLO

    model_path = Path(args.model)
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")

    data_path = Path(args.data)
    if not data_path.exists():
        raise FileNotFoundError(f"Dataset config not found: {data_path}")

    model = YOLO(str(model_path))

    run_name = args.name or f"eval_{args.split}{'_tta' if args.tta else ''}"

    metrics = model.val(
        data=str(data_path),
        split=args.split,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        workers=args.workers,
        augment=args.tta,
        name=run_name,
        plots=True,
    )

    # CORRECT per-class mapping using ap_class_index
    ap_class_index = metrics.box.ap_class_index
    maps = metrics.box.maps       # AP@50:95 per class (indexed by position in ap_class_index)
    ap50 = metrics.box.ap50       # AP@50 per class

    print("\n" + "=" * 60)
    print(f"  Evaluation: {run_name}")
    print(f"  Split: {args.split}  |  TTA: {args.tta}")
    print("=" * 60)
    print(f"  Precision:     {metrics.box.mp:.4f}")
    print(f"  Recall:        {metrics.box.mr:.4f}")
    print(f"  mAP@50:        {metrics.box.map50:.4f}")
    print(f"  mAP@50:95:     {metrics.box.map:.4f}")

    print(f"\n  Per-class AP (via ap_class_index, {len(ap_class_index)} classes):")
    for idx, cls_id in enumerate(ap_class_index):
        cls_id = int(cls_id)
        ap50_val = float(ap50[idx])
        ap95_val = float(maps[idx])
        name = model.names.get(cls_id, f"cls_{cls_id}")
        tag = "OK" if ap95_val > 0.10 else ("weak" if ap95_val > 0.03 else "FAIL")
        print(f"    {cls_id} {name:20s}  AP50={ap50_val:.4f}  AP50:95={ap95_val:.4f}  [{tag}]")
    print("=" * 60)


if __name__ == "__main__":
    evaluate(build_parser().parse_args())
