/* =========================================================================
 * 手部关键点 → 手势词汇分类器（MediaPipe Hands 21 关键点，纯数学无依赖）
 * 独立模块便于 Node 单测（tests/hand-gestures.test.mjs）。
 * 输入：MediaPipe HandLandmarker 的归一化关键点数组 lm[21]（x,y ∈ [0,1]，z 忽略）
 * 输出：{ name, score }。公开动作有 pinch|palm|peace|fist|call|like|ok；
 * one/three/four/point/middle_finger/grip 仅作为内部分类结果保留，不得直接绑定公开功能。
 * ========================================================================= */

// 关键点索引（MediaPipe Hands 规范）
export const HAND_LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  IDX_MCP: 5, IDX_PIP: 6, IDX_DIP: 7, IDX_TIP: 8,
  MID_MCP: 9, MID_PIP: 10, MID_DIP: 11, MID_TIP: 12,
  RNG_MCP: 13, RNG_PIP: 14, RNG_DIP: 15, RNG_TIP: 16,
  PKY_MCP: 17, PKY_PIP: 18, PKY_DIP: 19, PKY_TIP: 20
};

// 可调阈值：真实摄像头调参时可在控制台改 window.__HAND.rules（引用同一对象）
export const HAND_RULES = {
  fingerRatio: 1.02,  // 摄像头角度会压缩指尖-腕距，允许自然弯曲的张掌被识别
  thumbRatio: 1.08,   // 竖直拇指判定；张开掌另由 thumbOut 兜底
  thumbFar: 0.58,     // 侧向张掌的拇指通常被透视压缩，使用更宽松的外展阈值
  pinchRatio: 0.30,   // 拇指尖-食指尖 < 掌宽 × 该值 → pinch 捏合
  fistCurl: 0.86      // 四指平均卷曲比 < 该值 → 紧握拳；≥ → 松弛抓握 grip
};

// 两点欧氏距离（历史上叫 dist2，实为距离而非平方，已更名避免误用）
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 从 21 个归一化关键点分类手势。
 * 返回 { name, score, metrics }，metrics 含全部中间指标供调试。
 */
export function classifyHandGesture(lm) {
  if (!Array.isArray(lm) || lm.length < 21) return { name: "unknown", score: 0, metrics: null };
  // 坏帧防御：坐标含 NaN/Infinity 时所有比较为 false 会把坏帧误判成 grip，
  // 这里直接判定 unknown 交给上层投票机制丢弃。
  for (let i = 0; i < 21; i++) {
    const pt = lm[i];
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      return { name: "unknown", score: 0, metrics: null };
    }
  }
  const L = HAND_LM;
  const d = (a, b) => dist(lm[a], lm[b]);
  const wrist = L.WRIST;
  const handSize = Math.max(1e-6, d(L.WRIST, L.MID_MCP));

  // 手指伸直判定：指尖比指根离腕部更远，且指尖越过 PIP
  const ext = (mcp, pip, tip) => {
    const dt = d(tip, wrist), dm = d(mcp, wrist), dp = d(pip, wrist);
    return dt > dm * HAND_RULES.fingerRatio && dt > dp * 1.02;
  };

  const e = {
    index: ext(L.IDX_MCP, L.IDX_PIP, L.IDX_TIP),
    middle: ext(L.MID_MCP, L.MID_PIP, L.MID_TIP),
    ring: ext(L.RNG_MCP, L.RNG_PIP, L.RNG_TIP),
    pinky: ext(L.PKY_MCP, L.PKY_PIP, L.PKY_TIP),
    thumb: d(L.THUMB_TIP, wrist) > d(L.THUMB_IP, wrist) * HAND_RULES.thumbRatio
  };
  const n4 = (e.index ? 1 : 0) + (e.middle ? 1 : 0) + (e.ring ? 1 : 0) + (e.pinky ? 1 : 0);
  const pinch = d(L.THUMB_TIP, L.IDX_TIP) < HAND_RULES.pinchRatio * handSize;
  // 横出/侧伸的拇指通常没有足够的 IP-腕距比，但它会同时远离食指根和腕部。
  // 第二个条件避免“拇指收在掌心”的 four 姿态被误判为 palm。
  const thumbOut = d(L.THUMB_TIP, L.IDX_MCP) > HAND_RULES.thumbFar * handSize
    && d(L.THUMB_TIP, wrist) > handSize * 0.70;
  // 点赞不再只依赖拇指的横向距离。摄像头轻微旋转时，thumbOut 会抖动，
  // 这里同时检查拇指尖是否高于 IP/MCP，并要求它远离腕部，排除横握拇指。
  const thumbUp = e.thumb
    && lm[L.THUMB_TIP].y < lm[L.THUMB_IP].y - 0.040
    && lm[L.THUMB_TIP].y < lm[L.THUMB_MCP].y - 0.055
    && d(L.THUMB_TIP, wrist) > handSize * 0.78;
  const curlRatio = ([L.IDX_MCP, L.MID_MCP, L.RNG_MCP, L.PKY_MCP]
    .reduce((s, mcp) => s + d(mcp + 3, wrist) / Math.max(1e-6, d(mcp, wrist)), 0)) / 4;

  const metrics = {
    handSize: +handSize.toFixed(4),
    e: { index: e.index, middle: e.middle, ring: e.ring, pinky: e.pinky, thumb: e.thumb },
    n4,
    pinchRatio: +(d(L.THUMB_TIP, L.IDX_TIP) / handSize).toFixed(3),
    thumbOutRatio: +(d(L.THUMB_TIP, L.IDX_MCP) / handSize).toFixed(3),
    thumbAwayRatio: +(d(L.THUMB_TIP, wrist) / handSize).toFixed(3),
    thumbUp,
    curlRatio: +curlRatio.toFixed(3)
  };

  let name = "unknown";
  // 握拳时拇指经常压在食指上，几何上也会满足 pinch 的距离条件。
  // 先用四指卷曲度锁定 fist，再处理 pinch，避免 planet 模式把拳头当成旋转手势。
  const fistLike = n4 === 0 && curlRatio < HAND_RULES.fistCurl;
  if (fistLike) {
    name = "fist";
  } else if (pinch) {
    // 拇指与食指捏合成圈：中/无名/小指伸直是经典 OK 手势；其余卷曲才是 pinch 夹取。
    // OK 与 pinch 共享“拇指尖-食指尖近”指标，用三指伸直度区分，避免 OK 误触发地球旋转。
    name = e.middle && e.ring && e.pinky ? "ok" : "pinch";
  } else if (n4 === 4) {
    // 四指全伸：竖直或横出的拇指都属于 palm；只有拇指收在掌心才是 four。
    name = e.thumb || thumbOut ? "palm" : "four";
  } else if (n4 >= 3 && (e.thumb || thumbOut)) {
    // 真实视频中常有一根指尖被遮挡或轻微弯曲，仍按张开手掌处理。
    name = "palm";
  } else if (n4 === 3 && e.index && e.middle && e.ring) {
    name = "three";
  } else if (n4 === 2 && e.index && e.middle) {
    name = "peace";
  } else if (n4 === 1 && e.pinky && e.thumb) {
    name = "call";
  } else if (n4 === 1 && e.middle) {
    name = "middle_finger";
  } else if (n4 === 1 && e.index) {
    // 仅食指：拇指竖起 → point（指向）；拇指收拢 → one
    name = e.thumb ? "point" : "one";
  } else if (n4 === 0) {
    // 四指全收：拇指竖起且远离手指 → like；拇指横握 → grip；拇指收拢按紧度分 fist/grip
    if (thumbUp || (e.thumb && thumbOut)) {
      name = "like";
    } else if (e.thumb) {
      name = "grip";
    } else {
      name = curlRatio < HAND_RULES.fistCurl ? "fist" : "grip";
    }
  }
  // 距规则越清晰置信度越高；边缘情况交给前端 620ms/3 帧投票防抖
  const score = name === "unknown" ? 0.5 : 0.9;
  return { name, score, metrics };
}
