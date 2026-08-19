"""
数字人公开运行配置。
返回真实环境状态和可公开参数，不返回 appSecret。
"""

from fastapi import APIRouter, Depends

from auth import get_current_user
import config
from models import User
from schemas import DigitalHumanConfig

router = APIRouter(prefix="/api/v1", tags=["digital-human"])


@router.get("/digital-human/config", response_model=DigitalHumanConfig)
async def get_digital_human_config(current_user: User = Depends(get_current_user)):
    """返回数字人 SDK 公开配置与服务端配置状态。"""
    configured = bool(config.DH_APP_ID and config.DH_APP_SECRET)
    return DigitalHumanConfig(
        enabled=configured,
        configured=configured,
        provider=config.DH_PROVIDER,
        app_id=config.DH_APP_ID or None,
        avatar_id=config.DH_AVATAR_ID,
        voice_id=config.DH_VOICE_ID,
        sdk_mode="realtime",
        gateway_server=config.DH_GATEWAY_SERVER,
        sdk_url=config.DH_SDK_URL,
        sdk_integrity=config.DH_SDK_INTEGRITY or None,
        message=None if configured else "服务端数字人凭证未配置，前端可使用本地开发配置或降级模式。",
    )
