"""抓取真实海底测深数据（GEBCO 2020，经 OpenTopoData 公开API）。

区域: 舟山群岛海域 (覆盖 A-01 朱家尖 / A-02 嵊溪 列岛两个监测点)
产出: src/frontend/public/data/zhoushan_bathymetry.json
      { meta: {lat_min, lat_max, lng_min, lng_max, nx, nz, source}, depths: [[...]] }
运行时前端读本地文件, 不再访问外网。

API: https://www.opentopodata.org/datasets/gebco2020/ (免费, 100点/请求, 1请求/秒)
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

LAT_MIN, LAT_MAX = 29.70, 30.95
LNG_MIN, LNG_MAX = 121.90, 123.15
NX, NZ = 33, 33
API = "https://api.opentopodata.org/v1/gebco2020"
OUT = Path("src/frontend/public/data/zhoushan_bathymetry.json")

def main() -> None:
    lats = [LAT_MIN + (LAT_MAX - LAT_MIN) * i / (NZ - 1) for i in range(NZ)]
    lngs = [LNG_MIN + (LNG_MAX - LNG_MIN) * j / (NX - 1) for j in range(NX)]

    points = [(la, ln) for la in lats for ln in lngs]  # 行优先: z(纬度) × x(经度)
    depths: list[float] = []
    CHUNK = 100
    for s in range(0, len(points), CHUNK):
        chunk = points[s:s + CHUNK]
        q = "|".join(f"{la:.5f},{ln:.5f}" for la, ln in chunk)
        url = f"{API}?locations={urllib.parse.quote(q)}"
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=30) as resp:
                    data = json.loads(resp.read().decode())
                if data.get("status") != "OK":
                    raise RuntimeError(data.get("error", "unknown"))
                break
            except Exception as exc:
                if attempt == 2:
                    raise SystemExit(f"API失败: {exc}")
                time.sleep(3)
        for r in data["results"]:
            d = r["elevation"]
            depths.append(0.0 if d is None else float(d))
        print(f"  {min(s+CHUNK, len(points))}/{len(points)}", flush=True)
        time.sleep(1.1)  # 免费API限流: 1请求/秒

    grid = [depths[i * NX:(i + 1) * NX] for i in range(NZ)]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "meta": {
            "source": "GEBCO 2020 (via opentopodata.org), 舟山群岛海域真实测深",
            "lat_min": LAT_MIN, "lat_max": LAT_MAX,
            "lng_min": LNG_MIN, "lng_max": LNG_MAX,
            "nx": NX, "nz": NZ,
            "depth_min": min(depths), "depth_max": max(depths),
        },
        "depths": [[round(v, 1) for v in row] for row in grid],
    }, ensure_ascii=False), encoding="utf-8")
    print(f"saved: {OUT}")
    print(f"  depth range: {min(depths):.1f}m ~ {max(depths):.1f}m")

if __name__ == "__main__":
    main()
