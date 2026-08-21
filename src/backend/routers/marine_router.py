"""真实海况接口：Open-Meteo 海洋/气象 API(免费无Key) + 本地缓存。

GET /api/v1/stats/marine
  - 缓存 data/marine_now.json, TTL 30 分钟(演示期间不反复请求外网)
  - 过期时尝试抓取最新; 抓取失败时回退返回旧缓存(stale=true), 无缓存才 503
  - tools/fetch_marine.py 可离线预置缓存(答辩环境无外网也能展示)

数据源:
  - 海况(波高/浪向/周期/海表温): https://marine-api.open-meteo.com/v1/marine
  - 风(10m 风速/风向): https://api.open-meteo.com/v1/forecast (wind_speed_unit=ms)
坐标取舟山监测海域中心(与测深/岸线数据同窗口)。
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import config
from auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/stats", tags=["marine"])

CACHE_FILE = Path(config.PROJECT_ROOT) / "data" / "marine_now.json"
CACHE_TTL_SECONDS = 30 * 60
FETCH_TIMEOUT = 8
# 舟山监测海域中心(与 GEBCO 测深窗口一致)
LAT, LNG = 30.05, 122.45

MARINE_URL = (
    "https://marine-api.open-meteo.com/v1/marine"
    f"?latitude={LAT}&longitude={LNG}"
    "&current=wave_height,wave_direction,wave_period,sea_surface_temperature"
    "&timezone=Asia%2FShanghai"
)
WIND_URL = (
    "https://api.open-meteo.com/v1/forecast"
    f"?latitude={LAT}&longitude={LNG}"
    "&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms"
    "&timezone=Asia%2FShanghai"
)


class MarineConditions(BaseModel):
    """海况快照(前端 MarineInfo 契约, snake_case 与其余 stats 接口一致)"""

    fetched_at: str                        # 抓取时刻(UTC ISO, 带时区偏移) — 缓存TTL以此计算
    observed_time: str | None = None       # 数据源观测时间(Open-Meteo 本地时间串, 仅展示)
    wave_height: float | None = None       # 有效波高 m
    wave_direction: float | None = None    # 浪向(来向方位角°)
    wave_period: float | None = None       # 平均周期 s
    sea_surface_temperature: float | None = None  # 海表温 ℃
    wind_speed: float | None = None        # 10m 风速 m/s
    wind_direction: float | None = None    # 风向(来向方位角°)
    stale: bool = False                    # true=外网抓取失败, 返回的是旧缓存


def _fetch_json(url: str) -> dict:
    with urlopen(url, timeout=FETCH_TIMEOUT) as resp:  # noqa: S310 白名单固定URL
        return json.loads(resp.read().decode("utf-8"))


def _num(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return round(float(value), 2)
    return None


def fetch_conditions() -> MarineConditions:
    """抓取海况+风(风失败不阻塞海况), 返回未缓存结构。

    fetched_at 必须是带时区的 UTC ISO(抓取时刻): Open-Meteo 返回的
    time 是无偏移的本地时间串, 直接当 TTL 基准会把时差算进缓存年龄。
    """
    marine = _fetch_json(MARINE_URL)
    current = marine.get("current") or {}
    observed = current.get("time")
    conditions = MarineConditions(
        fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        observed_time=str(observed) if observed else None,
        wave_height=_num(current.get("wave_height")),
        wave_direction=_num(current.get("wave_direction")),
        wave_period=_num(current.get("wave_period")),
        sea_surface_temperature=_num(current.get("sea_surface_temperature")),
    )
    try:
        wind = _fetch_json(WIND_URL)
        w = wind.get("current") or {}
        conditions.wind_speed = _num(w.get("wind_speed_10m"))
        conditions.wind_direction = _num(w.get("wind_direction_10m"))
    except Exception as exc:  # 风接口失败不影响海况主体
        logger.warning("海况-风接口失败: %s", exc)
    return conditions


def read_cache() -> MarineConditions | None:
    try:
        raw = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        return MarineConditions.model_validate(raw)
    except Exception:
        return None


def write_cache(conditions: MarineConditions) -> None:
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(
            conditions.model_dump_json(indent=2), encoding="utf-8"
        )
    except Exception as exc:  # 缓存写失败不影响本次返回
        logger.warning("海况缓存写入失败: %s", exc)


def _cache_age_seconds(c: MarineConditions) -> float:
    try:
        fetched = datetime.fromisoformat(c.fetched_at)
        if fetched.tzinfo is None:
            fetched = fetched.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - fetched).total_seconds())
    except ValueError:
        return float("inf")

@router.get("/marine", response_model=MarineConditions)
def stats_marine(current_user=Depends(get_current_user)):
    """真实海况快照(同步def: urllib阻塞IO交由线程池, 不占事件循环)"""
    cached = read_cache()
    if cached is not None and _cache_age_seconds(cached) < CACHE_TTL_SECONDS:
        return cached
    try:
        fresh = fetch_conditions()
        write_cache(fresh)
        return fresh
    except Exception as exc:
        logger.warning("海况抓取失败, 回退缓存: %s", exc)
        if cached is not None:
            cached.stale = True
            return cached
        raise HTTPException(status_code=503, detail=f"海况数据不可用: {exc}") from exc
