"""Process a video frame by frame and write an annotated output video."""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
from ultralytics import YOLO


def process_video(model_path: str, source: str, output: str, conf: float = 0.25,
                  device: str | None = None) -> int:
    model = YOLO(model_path)
    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        raise OSError(f"Cannot open video: {source}")

    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(output_path), cv2.VideoWriter_fourcc(*"mp4v"),
                             fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise OSError(f"Cannot create video: {output}")

    frame_count = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            result = model.predict(frame, conf=conf, device=device, verbose=False)[0]
            writer.write(result.plot())
            frame_count += 1
    finally:
        capture.release()
        writer.release()
    return frame_count


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="best.pt")
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--device", default=None)
    return parser


if __name__ == "__main__":
    args = build_parser().parse_args()
    print(process_video(args.model, args.source, args.output, args.conf, args.device))

