"""预置真实海况缓存（舟山监测海域, Open-Meteo 海洋/气象 API, 免费无Key）。

答辩/演示前在有网环境运行一次, 产物 data/marine_now.json 由后端
/api/v1/stats/marine 在外网不可用时直接返回(stale=true), 3D 海况面板离线可用。

运行: python tools/fetch_marine.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src" / "backend"))

# marine_router 位于 routers 包内(与 main.py 同一入口)
from routers.marine_router import CACHE_FILE, fetch_conditions, read_cache, write_cache  # noqa: E402



def main() -> None:
    try:
        conditions = fetch_conditions()
        write_cache(conditions)
        print(f"saved: {CACHE_FILE}")
        print(conditions.model_dump_json(indent=2))
        return
    except Exception as exc:  # noqa: BLE001 命令行工具汇总报错
        print(f"在线抓取失败: {exc}")
    cached = read_cache()
    if cached is not None:
        print(f"保留现有缓存: {CACHE_FILE}")
        print(cached.model_dump_json(indent=2))
    else:
        raise SystemExit("无可用缓存: 请在有网环境重试")


if __name__ == "__main__":
    main()
