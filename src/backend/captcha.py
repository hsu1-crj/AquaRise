"""
验证码生成与签名校验
=====================================
验证码分两部分：

1. 生成验证码图片（Pillow 绘制字符 + 干扰线 + 噪点）
2. 把正确答案签名后放进 Cookie（HMAC-SHA256 + 时间戳），
   登录时校验签名和有效期 —— 客户端无法篡改或伪造答案。

签名不依赖第三方库，只用 Python 标准库的 hmac / hashlib。
"""

import hashlib
import os
import random
import secrets
import time
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

# 签名密钥：优先从环境变量/.env 注入；未配置时使用开发默认值，生产环境必须设置随机长字符串
SECRET_KEY = os.getenv("CAPTCHA_SECRET_KEY", "fastapi-learning-captcha-secret-change-me")

# 验证码有效期（秒），过期后即使填对也要重新获取
CAPTCHA_MAX_AGE = 300

# 易读字符集：去掉 0O1lI 等容易混淆的字符
CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

# 常见字体路径（Windows 优先，找不到就退回 PIL 内置默认字体）
FONT_CANDIDATES = [
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/msyh.ttc",
]


def generate_captcha_code(length: int = 4) -> str:
    """生成 length 位随机验证码（用 secrets 保证随机性足够）"""
    return "".join(secrets.choice(CODE_CHARS) for _ in range(length))


def _load_font(size: int):
    """加载一个可用的 TTF 字体，找不到就退回 PIL 默认字体"""
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def create_captcha_image(code: str) -> bytes:
    """把验证码画成一张带干扰线和噪点的 PNG，返回字节数据"""
    width, height = 130, 42

    # 随机浅色背景
    bg = (
        random.randint(230, 255),
        random.randint(230, 255),
        random.randint(230, 255),
    )
    img = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(img)

    # 干扰线（3~5 条）
    for _ in range(random.randint(3, 5)):
        x1 = random.randint(0, width)
        y1 = random.randint(0, height)
        x2 = random.randint(0, width)
        y2 = random.randint(0, height)
        draw.line((x1, y1, x2, y2), fill=(random.randint(150, 200),) * 3, width=1)

    # 噪点（约 40 个）
    for _ in range(40):
        draw.point(
            (random.randint(0, width - 1), random.randint(0, height - 1)),
            fill=(random.randint(120, 200),) * 3,
        )

    # 逐字符绘制：每个字符随机颜色 + 纵向小偏移
    font = _load_font(28)
    char_w = width // (len(code) + 1)
    for i, ch in enumerate(code):
        color = (
            random.randint(20, 120),
            random.randint(20, 120),
            random.randint(20, 120),
        )
        y_offset = random.randint(-3, 3)
        draw.text((char_w * (i + 0.5), height // 2 - 18 + y_offset), ch, font=font, fill=color)

    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def sign_captcha(code: str) -> str:
    """
    把验证码+时间戳签名，得到可放进 Cookie 的字符串。
    格式：code:timestamp.digest
    """
    payload = f"{code}:{int(time.time())}"
    digest = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{digest}"


def verify_captcha(cookie_value: str, submitted: str, max_age: int = CAPTCHA_MAX_AGE) -> bool:
    """
    校验用户填写的验证码：
    - 签名不匹配（被篡改或伪造）→ False
    - 超过有效期 → False
    - 内容与 cookie 里的答案一致（忽略大小写）→ True
    """
    try:
        payload, digest = cookie_value.rsplit(".", 1)
        code, timestamp = payload.rsplit(":", 1)
    except ValueError:
        return False

    # 1. 校验签名（hmac.compare_digest 可防时序攻击）
    expected = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, digest):
        return False

    # 2. 校验有效期
    if time.time() - int(timestamp) > max_age:
        return False

    # 3. 对比内容（忽略大小写，方便用户输入）
    return code.lower() == submitted.strip().lower()
