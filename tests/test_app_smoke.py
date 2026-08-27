"""全应用导入冒烟测试
=============================
背景：合并队友代码时出现过 `reports_router` 引用未导入名称导致的
`NameError: get_current_user`——模块级错误在应用启动时才爆炸，
而现有单测只导入了个别 router，漏掉了整条导入链。

本测试导入完整 FastAPI 应用（main.py → 全部 routers/services），
任何路由文件里的未定义名称、坏导入都会在此失败，而不是等到服务启动。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "backend"))


def test_full_app_imports():
    """main:app 完整导入：全部路由模块可用，无未定义名称/坏导入。"""
    import main  # noqa: F401  src/backend/main.py

    assert main.app is not None
    # 关键路由前缀全部挂载（缺一路由说明 include_router 被合并坏了）
    prefixes = {getattr(r, "path", "") for r in main.app.routes}
    for expected in (
        "/api/v1/auth/login",
        "/api/v1/detect/image",
        "/api/v1/detections",
        "/api/v1/chat",
        "/api/v1/stats/summary",
        "/api/v1/stats/marine",
        "/api/v1/reports",       # 队友的综合报告也在此路由
        "/api/v1/knowledge",
        "/api/v1/digital-human/config",
        "/api/v1/admin/overview",  # 后台管理（RBAC）
    ):
        assert any(p.startswith(expected) for p in prefixes), f"缺少路由: {expected}"
