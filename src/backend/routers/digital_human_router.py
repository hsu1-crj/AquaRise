"""数字人配置、短期凭证和服务端签名网关。"""

import hashlib
import hmac
import json
import secrets
import time
from typing import Any

import aiohttp

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from auth import require_permission
import config
from models import User
from schemas import DigitalHumanConfig

router = APIRouter(prefix="/api/v1", tags=["digital-human"])

_TICKET_TTL_SECONDS = 300
_tickets: dict[str, tuple[int, float]] = {}
_PROXY_GATEWAY = "/api/v1/digital-human/gateway"


def _canonical_json(value: Any) -> str:
    """Match XmovAvatar's sorted-key, compact JSON signature payload."""
    # ensure_ascii=True matches the SDK's UTF-16-unit \u escaping (including emoji).
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _xmov_signature(path: str, method: str, body: Any, secret: str, timestamp: str) -> str:
    payload = _canonical_json(body).replace(" ", "")
    raw = f"{path.lower()}{method.lower()}{payload}{secret}{timestamp}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _purge_tickets() -> None:
    now = time.time()
    for ticket, (_, expires) in list(_tickets.items()):
        if expires <= now:
            _tickets.pop(ticket, None)


def _resolve_ticket(app_id: str, supplied_signature: str, method: str, body: Any, timestamp: str) -> str | None:
    _purge_tickets()
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return None
    if abs(int(time.time()) - ts) > 60:
        return None
    for ticket in _tickets:
        expected = _xmov_signature(_PROXY_GATEWAY, method, body, ticket, timestamp)
        if hmac.compare_digest(expected, supplied_signature):
            return ticket
    return None


@router.get("/digital-human/config", response_model=DigitalHumanConfig)
async def get_digital_human_config(current_user: User = Depends(require_permission("assistant"))):
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
        # SDK requests go through our signer; the upstream URL stays server-side.
        gateway_server=_PROXY_GATEWAY,
        sdk_url=config.DH_SDK_URL,
        sdk_integrity=config.DH_SDK_INTEGRITY or None,
        message=None if configured else "服务端数字人凭证未配置，将使用全息拟态/浏览器语音降级模式。",
    )


@router.post("/digital-human/credential")
async def issue_digital_human_credential(
    response: Response,
    current_user: User = Depends(require_permission("assistant")),
):
    """为当前登录用户签发一次性短期 SDK 凭证，不返回真实 appSecret。"""
    if not config.DH_APP_ID or not config.DH_APP_SECRET:
        raise HTTPException(status_code=503, detail="服务端数字人凭证未配置")
    response.headers["Cache-Control"] = "no-store"
    _purge_tickets()
    ticket = secrets.token_urlsafe(32)
    _tickets[ticket] = (current_user.id, time.time() + _TICKET_TTL_SECONDS)
    return {
        "app_id": config.DH_APP_ID,
        "credential": ticket,
        "expires_in": _TICKET_TTL_SECONDS,
        "gateway_server": _PROXY_GATEWAY,
    }


@router.api_route("/digital-human/gateway", methods=["POST", "DELETE"])
async def digital_human_gateway(request: Request):
    """Validate the short-lived browser ticket and sign the upstream Xmov request."""
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="数字人请求体不是有效 JSON") from exc
    app_id = request.headers.get("X-APP-ID", "")
    timestamp = request.headers.get("X-TIMESTAMP", "")
    supplied = request.headers.get("X-TOKEN", "")
    ticket = _resolve_ticket(app_id, supplied, request.method, body, timestamp)
    if not ticket or app_id != config.DH_APP_ID:
        raise HTTPException(status_code=401, detail="数字人短期凭证无效或已过期")

    upstream = config.DH_GATEWAY_SERVER
    upstream_path = "/" + upstream.split("/", 3)[-1] if "://" in upstream else upstream
    if not upstream_path.startswith("/"):
        upstream_path = "/" + upstream_path
    upstream_token = _xmov_signature(upstream_path, request.method, body, config.DH_APP_SECRET, timestamp)
    headers = {"X-APP-ID": config.DH_APP_ID, "X-TOKEN": upstream_token, "X-TIMESTAMP": timestamp,
               "Content-Type": "application/json"}
    timeout = aiohttp.ClientTimeout(total=20)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.request(request.method, upstream, json=body, headers=headers) as upstream_response:
                data = await upstream_response.read()
                return Response(content=data, status_code=upstream_response.status,
                                media_type=upstream_response.headers.get("Content-Type", "application/json"))
    except aiohttp.ClientError as exc:
        raise HTTPException(status_code=502, detail="数字人上游服务不可用") from exc
