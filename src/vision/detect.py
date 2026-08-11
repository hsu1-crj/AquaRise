"""Run YOLO inference on one image and optionally save an annotated image."""

from __future__ import annotations

import argparse
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="best.pt")
    parser.add_argument("--source", required=True, help="Image path")
    parser.add_argument("--output", default=None, help="Annotated output image path")
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--device", default=None)
    return parser


def detect_image(model_path: str, source: str, output: str | None = None,
                 conf: float = 0.25, device: str | None = None) -> list[dict]:
    from ultralytics import YOLO

    model = YOLO(model_path)
    results = model.predict(source=source, conf=conf, device=device, verbose=False)
    detections: list[dict] = []
    for result in results:
        if result.boxes is None:
            continue
        for box in result.boxes:
            cls_id = int(box.cls[0])
            detections.append({
                "class_id": cls_id,
                "class_name": model.names[cls_id],
                "confidence": round(float(box.conf[0]), 4),
                "xyxy": [round(float(value), 2) for value in box.xyxy[0].tolist()],
            })
        if output:
            output_path = Path(output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            result.save(filename=str(output_path))
    return detections


if __name__ == "__main__":
    cli_args = build_parser().parse_args()
    for detection in detect_image(cli_args.model, cli_args.source, cli_args.output,
                                  cli_args.conf, cli_args.device):
        print(detection)

