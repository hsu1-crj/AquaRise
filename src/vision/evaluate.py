"""Evaluate a trained detector on the held-out validation or test split.

Example:
    python src/vision/evaluate.py --model runs/detect/underwater_v2/weights/best.pt --split test
"""

from __future__ import annotations

import argparse
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model", default="runs/detect/underwater_v2/weights/best.pt",
    )
    parser.add_argument(
        "--data", default="dataset/yolo_dataset_video_split/data.yaml",
    )
    parser.add_argument("--split", default="test", choices=("val", "test"))
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default="0")
    parser.add_argument("--workers", type=int, default=2)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    from ultralytics import YOLO

    model_path = Path(args.model)
    data_path = Path(args.data)
    if not model_path.is_file():
        raise FileNotFoundError(f"Model not found: {model_path}")
    if not data_path.is_file():
        raise FileNotFoundError(f"Dataset config not found: {data_path}")

    model = YOLO(str(model_path))
    results = model.val(
        data=str(data_path),
        split=args.split,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        workers=args.workers,
        plots=True,
        project="runs/eval",
        name=f"{model_path.parent.parent.name}_{args.split}",
        exist_ok=True,
    )
    print("\n=== Evaluation results ===")
    print(f"  split:      {args.split}")
    print(f"  model:      {args.model}")
    print(f"  precision:  {results.results_dict['metrics/precision(B)']:.4f}")
    print(f"  recall:     {results.results_dict['metrics/recall(B)']:.4f}")
    print(f"  mAP50:      {results.results_dict['metrics/mAP50(B)']:.4f}")
    print(f"  mAP50-95:   {results.results_dict['metrics/mAP50-95(B)']:.4f}")


if __name__ == "__main__":
    main()
