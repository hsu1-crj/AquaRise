"""真实海况接口：Open-Meteo 海洋/气象 API(免费无Key) + 本地缓存。

GET /api/v1/stats/marine?lat=&lng=
  - 不带坐标: 默认舟山监测海域中心(与测深/岸线数据同窗口)
  - 带坐标: 按站点经纬度取数, 每个坐标独立缓存(TTL 30 分钟)
  - 抓取失败时回退该坐标的旧缓存(stale=true), 无缓存才 503
  - tools/fetch_marine.py 可离线预置缓存(答辩环境无外网也能展示)

数据源:
  - 海况(波高/浪向/周期/海表温): https://marine-api.open-meteo.com/v1/marine
  - 风(10m 风速/风向): https://api.open-meteo.com/v1/forecast (wind_speed_unit=ms)
不传坐标时默认取舟山监测海域中心(与测深/岸线数据同窗口)。
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
# 舟山监测海域中心(与 GEBCO 测深窗口一致), 作为不传坐标时的默认
LAT, LNG = 30.05, 122.45


def _cache_file(lat: float, lng: float) -> Path:
    """每个坐标独立缓存文件; 默认舟山坐标沿用旧文件名(兼容 fetch_marine.py 预置)"""
    if abs(lat - LAT) < 1e-6 and abs(lng - LNG) < 1e-6:
        return CACHE_FILE
    safe = f"{lat:.2f}_{lng:.2f}".replace("-", "m").replace(".", "p")
    return CACHE_FILE.with_name(f"marine_{safe}.json")


def _marine_url(lat: float, lng: float) -> str:
    return (
        "https://marine-api.open-meteo.com/v1/marine"
        f"?latitude={lat}&longitude={lng}"
        "&current=wave_height,wave_direction,wave_period,sea_surface_temperature"
        "&timezone=Asia%2FShanghai"
    )


def _wind_url(lat: float, lng: float) -> str:
    return (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lng}"
        "&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms"
        "&timezone=Asia%2FShanghai"
    )


class MarineConditions(BaseModel):
    """海况快照(前端 MarineInfo 契约, snake_case 与其余 stats 接口一致)"""

    fetched_at: str                      # UTC ISO(抓取时刻, 作TTL基准)
    observed_time: str | None = None     # 数据源观测时间(本地时间, 展示用)
    latitude: float | None = None        # 实际取数坐标(不带坐标请求时为舟山默认)
    longitude: float | None = None
    wave_height: float | None = None
    wave_direction: float | None = None
    wave_period: float | None = None
    sea_surface_temperature: float | None = None
    wind_speed: float | None = None
    wind_direction: float | None = None
    stale: bool = False                    # true=外网抓取失败, 返回的是旧缓存


def _fetch_json(url: str) -> dict:
    with urlopen(url, timeout=FETCH_TIMEOUT) as resp:  # noqa: S310 白名单固定URL
        return json.loads(resp.read().decode("utf-8"))


def _num(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return round(float(value), 2)
    return None


def fetch_conditions(lat: float = LAT, lng: float = LNG) -> MarineConditions:
    """抓取指定坐标的海况+风(风失败不阻塞海况), 返回未缓存结构。

    fetched_at 必须是带时区的 UTC ISO(抓取时刻): Open-Meteo 返回的
    time 是无偏移的本地时间串, 直接当 TTL 基准会把时差算进缓存年龄。
    """
    marine = _fetch_json(_marine_url(lat, lng))
    current = marine.get("current") or {}
    observed = current.get("time")
    conditions = MarineConditions(
        fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        observed_time=str(observed) if observed else None,
        latitude=round(lat, 4),
        longitude=round(lng, 4),
        wave_height=_num(current.get("wave_height")),
        wave_direction=_num(current.get("wave_direction")),
        wave_period=_num(current.get("wave_period")),
        sea_surface_temperature=_num(current.get("sea_surface_temperature")),
    )
    try:
        wind = _fetch_json(_wind_url(lat, lng))
        w = wind.get("current") or {}
        conditions.wind_speed = _num(w.get("wind_speed_10m"))
        conditions.wind_direction = _num(w.get("wind_direction_10m"))
    except Exception as exc:  # 风接口失败不影响海况主体
        logger.warning("海况-风接口失败: %s", exc)
    return conditions


def read_cache(lat: float = LAT, lng: float = LNG) -> MarineConditions | None:
    try:
        raw = json.loads(_cache_file(lat, lng).read_text(encoding="utf-8"))
        return MarineConditions.model_validate(raw)
    except Exception:
        return None


def write_cache(conditions: MarineConditions, lat: float = LAT, lng: float = LNG) -> None:
    try:
        target = _cache_file(lat, lng)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
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
def stats_marine(lat: float | None = None, lng: float | None = None, current_user=Depends(get_current_user)):
    """真实海况快照, 按站点坐标取数(同步def: urllib阻塞IO交由线程池, 不占事件循环)"""
    # 坐标成对出现; 不传则用舟山默认窗口
    if (lat is None) != (lng is None):
        raise HTTPException(status_code=422, detail="lat 与 lng 必须同时提供")
    q_lat = LAT if lat is None else float(lat)
    q_lng = LNG if lng is None else float(lng)
    if not (-90 <= q_lat <= 90 and -180 <= q_lng <= 180):
        raise HTTPException(status_code=422, detail="坐标超出合法范围")
    cached = read_cache(q_lat, q_lng)
    if cached is not None and _cache_age_seconds(cached) < CACHE_TTL_SECONDS:
        return cached
    try:
        fresh = fetch_conditions(q_lat, q_lng)
        write_cache(fresh, q_lat, q_lng)
        return fresh
    except Exception as exc:
        logger.warning("海况抓取失败, 回退缓存: %s", exc)
        if cached is not None:
            cached.stale = True
            return cached
        raise HTTPException(status_code=503, detail=f"海况数据不可用: {exc}") from exc
