"""海况接口(/api/v1/stats/marine)单测：缓存回退与降级路径。

不访问外网、不依赖 MySQL：路由单独挂到轻量 app 上,
auth 依赖注入覆盖, fetch_conditions 按用例替换。
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "backend"))

from routers import marine_router  # noqa: E402
from auth import get_current_user  # noqa: E402


class _FakeUser:
    id = 1
    username = "tester"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """隔离缓存的测试客户端(每用例独立缓存文件)"""
    cache = tmp_path / "marine_now.json"
    monkeypatch.setattr(marine_router, "CACHE_FILE", cache)
    app = FastAPI()
    app.include_router(marine_router.router)
    app.dependency_overrides[get_current_user] = lambda: _FakeUser()
    return TestClient(app)


def _write_cache(fetched_at: str, **over):
    conditions = marine_router.MarineConditions(
        fetched_at=fetched_at,
        wave_height=1.3, wave_direction=140.0, wave_period=5.0,
        sea_surface_temperature=26.0, wind_speed=5.5, wind_direction=130.0,
    )
    for key, value in over.items():
        setattr(conditions, key, value)
    marine_router.write_cache(conditions)
    return conditions


def test_fresh_cache_returned_without_fetch(client, monkeypatch):
    """缓存未过期 → 直接返回, 不触发外网抓取"""
    now = datetime.now(timezone.utc)
    _write_cache(now.isoformat(timespec="seconds"))
    monkeypatch.setattr(
        marine_router, "fetch_conditions",
        lambda *a, **k: pytest.fail("新鲜缓存不应触发外网抓取"),
    )
    resp = client.get("/api/v1/stats/marine")
    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is False
    assert body["wave_height"] == 1.3


def test_production_format_cache_hit_within_ttl(client, monkeypatch):
    """真实抓取产出的缓存格式(UTC ISO fetched_at + 本地时间 observed_time)
    写入后, TTL 窗口内第二次请求必须命中缓存、不再抓取。"""
    # 第一次: 模拟生产 fetch_conditions 的输出格式
    def _production_fetch(*args, **kwargs):
        return marine_router.MarineConditions(
            fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            observed_time="2026-08-19T14:00",  # Open-Meteo 本地时间串(无偏移)
            wave_height=1.1, wave_direction=120.0, wave_period=4.5,
            sea_surface_temperature=27.0, wind_speed=4.0, wind_direction=100.0,
        )

    monkeypatch.setattr(marine_router, "fetch_conditions", _production_fetch)
    first = client.get("/api/v1/stats/marine")
    assert first.status_code == 200
    assert first.json()["fetched_at"].endswith("+00:00")
    # 第二次: 若再触发抓取则直接失败
    monkeypatch.setattr(
        marine_router, "fetch_conditions",
        lambda *a, **k: pytest.fail("TTL 内不应重复抓取"),
    )
    second = client.get("/api/v1/stats/marine")
    assert second.status_code == 200
    assert second.json() == first.json()


def test_fetch_success_writes_cache(client, monkeypatch):
    """无缓存 → 抓取成功返回并落盘"""
    fetched = marine_router.MarineConditions(
        fetched_at="2026-08-19T02:00:00+00:00",
        wave_height=0.9, wave_direction=100.0, wave_period=4.0,
        sea_surface_temperature=27.5, wind_speed=3.2, wind_direction=88.0,
    )
    monkeypatch.setattr(marine_router, "fetch_conditions", lambda *a, **k: fetched)
    resp = client.get("/api/v1/stats/marine")
    assert resp.status_code == 200
    assert resp.json()["wave_height"] == 0.9
    assert marine_router.read_cache() is not None


def test_fetch_fail_falls_back_to_stale_cache(client, monkeypatch):
    """抓取失败 + 有旧缓存 → 返回旧数据并标记 stale=true"""

    def _boom(*args, **kwargs):
        raise OSError("外网不可达")

    monkeypatch.setattr(marine_router, "fetch_conditions", _boom)
    old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(timespec="seconds")
    _write_cache(old)
    resp = client.get("/api/v1/stats/marine")
    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert body["fetched_at"] == old


def test_no_cache_and_fetch_fail_returns_503(client, monkeypatch):
    """抓取失败且无任何缓存 → 明确 503(前端隐藏面板)"""

    def _boom(*args, **kwargs):
        raise OSError("外网不可达")

    monkeypatch.setattr(marine_router, "fetch_conditions", _boom)
    resp = client.get("/api/v1/stats/marine")
    assert resp.status_code == 503


def test_cache_roundtrip(tmp_path, monkeypatch):
    """缓存读写roundtrip字段完整(演示脚本与接口共用同一文件格式)"""
    cache = tmp_path / "marine_now.json"
    monkeypatch.setattr(marine_router, "CACHE_FILE", cache)
    conditions = marine_router.MarineConditions(
        fetched_at="2026-08-19T00:00:00+00:00", wave_height=2.1,
    )
    marine_router.write_cache(conditions)
    loaded = marine_router.read_cache()
    assert loaded is not None
    assert loaded.wave_height == 2.1
    assert loaded.wind_speed is None
    assert loaded.observed_time is None
