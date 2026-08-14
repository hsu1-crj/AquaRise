"""Plot V1/V2/V3 training comparison (loss + mAP curves).

Generates a 2x2 figure comparing box_loss, cls_loss, mAP@50, mAP@50:95
across the three resolution-progression versions. This is the key
'training process' visual for the demo.
"""

import csv
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def main() -> None:
    versions = [
        ("V1 (imgsz=320)", "runs/detect/v1_yolo11n_320/results.csv", "#1976D2"),
        ("V2 (imgsz=480)", "runs/detect/v2_yolo11n_480/results.csv", "#F57C00"),
        ("V3 (imgsz=640)", "runs/detect/rf_r1_yolo11n/results.csv", "#388E3C"),
    ]

    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    fig.suptitle(
        "Training Process Comparison (V1->V2->V3, Resolution Progression)",
        fontsize=15,
        fontweight="bold",
    )

    for name, path, color in versions:
        if not Path(path).exists():
            print(f"skip (missing): {path}")
            continue
        rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
        ep = [int(float(r["epoch"])) + 1 for r in rows]
        axes[0, 0].plot(ep, [float(r["train/box_loss"]) for r in rows], label=name, color=color, lw=1.8)
        axes[0, 1].plot(ep, [float(r["train/cls_loss"]) for r in rows], label=name, color=color, lw=1.8)
        axes[1, 0].plot(ep, [float(r["metrics/mAP50(B)"]) for r in rows], label=name, color=color, lw=1.8)
        axes[1, 1].plot(ep, [float(r["metrics/mAP50-95(B)"]) for r in rows], label=name, color=color, lw=1.8)

    titles = [
        "Box Loss (lower = better)",
        "Classification Loss (lower = better)",
        "Validation mAP@50 (higher = better)",
        "Validation mAP@50:95 (higher = better)",
    ]
    ylabs = ["Loss", "Loss", "mAP@50", "mAP@50:95"]
    for ax, t, yl in zip(axes.flat, titles, ylabs):
        ax.set_title(t, fontsize=12)
        ax.set_xlabel("Epoch", fontsize=11)
        ax.set_ylabel(yl, fontsize=11)
        ax.legend(fontsize=10)
        ax.grid(True, alpha=0.3)

    plt.tight_layout(rect=[0, 0, 1, 0.95])
    out = "runs/training_comparison_V1V2V3.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    print(f"saved: {out}")
    plt.close()


if __name__ == "__main__":
    main()
