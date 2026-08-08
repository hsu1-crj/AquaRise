"""
数字人交互模块（扩展功能存根）
=====================================
真实实现：数字人API平台 JS SDK 集成，后端签发短期鉴权凭证。
这里先返回占位配置，保证前端可以联调接口结构。
注意：绝不返回 appSecret，只返回公开配置 + 短期凭证。
"""

from fastapi import APIRouter, Depends

from auth import get_current_user
from models import User
from schemas import DigitalHumanConfig

router = APIRouter(prefix="/api/v1", tags=["digital-human"])


@router.get("/digital-human/config", response_model=DigitalHumanConfig)
async def get_digital_human_config(current_user: User = Depends(get_current_user)):
    """返回数字人 SDK 公开配置（存根）"""
    return DigitalHumanConfig(
        enabled=True,
        avatar_id="ocean_guardian_01",
        voice_id="zh_female_ocean",
        sdk_mode="realtime",
        api_endpoint="https://api.digital-human.example.com/v1",
        auth_token="stub-token-for-dev",
    )
