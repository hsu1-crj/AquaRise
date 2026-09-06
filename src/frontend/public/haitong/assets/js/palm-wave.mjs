/* =========================================================================
 * 挥掌跟踪器 —— 生命图谱物种翻页（palm swipe）的位移判定，纯数学无依赖。
 * 独立模块便于 Node 单测（tests/palm-wave.test.mjs）。
 *
 * 背景：MediaPipe 检测循环的实际帧率随机器性能浮动（84ms 调度 + WASM 推理耗时）。
 * 旧实现按“每帧滤 42%”做低通滤波，帧率低的机器上滤波在墙钟时间里收敛变慢，
 * 快挥一下掌滤波值跟不上，28px 触发阈值攒不够 → 同样的动作有人灵敏有人迟钝。
 *
 * 本模块的五项修正：
 * 1. 滤波系数按实测帧间隔做指数时间补偿（refFrameMs≈90ms 时≈0.42/帧），
 *    任意检测帧率下墙钟时间的收敛速度一致 → 慢机器与快机器手感一致；
 * 2. 双通道触发：位移过阈值（原口径 28px），或“挥得够快”（滤波后瞬时速度
 *    过 speedPxS 且已离开基线）——快挥在低帧率下样本稀疏，位移没攒够手已挥完；
 * 3. 阈值按手宽自适应（handRelTravel）：同一物理挥幅与手在画面中的宽度成同比例，
 *    固定像素阈值在不同相机视场/距离/取景裁切下手感不同；按手宽的比例阈值
 *    对“手离相机远近”与“相机视场宽窄”都不敏感（二者是同一角度缩放）。
 *    典型手宽≈47px(320 坐标系) 时阈值≈28px，与旧口径对齐；上下限 22~40px；
 * 4. 触发后进入“未武装”状态，掌心回到基线附近（|位移|<pendingPx）才重新武装，
 *    修复手挥完停在半空、位移常驻超阈值导致冷却一过就连翻页的问题；
 * 5. 冷却（420ms 动作间隔）仍由页面统一管理，模块只管位移语义。
 *
 * 坐标系：掌心 x 使用 320 宽度检测图的原始摄像头坐标（landmarksToDetection 映射后）。
 * 预览水平镜像换算：屏幕行程 = -(x - 起点x)。原始 x 增大 = 用户向左挥 =
 * direction +1（下一物种）；x 减小 = 向右挥 = -1（上一物种）。
 * ========================================================================= */

export const PALM_WAVE_DEFAULTS = Object.freeze({
  travelPx: 28,   // 触发翻页的位移阈值（未提供手宽时的固定口径）
  pendingPx: 18,  // 方向提示阈值，也是触发后重新武装的回位半径
  windowMs: 1400, // 一次挥动的最长窗口，超时从当前位置重新起算
  minWaveMs: 90,  // 最短挥动时长，抑制单帧跳变
  refFrameMs: 90, // 参考帧间隔（≈11fps），滤波时间补偿的基准
  filterAlpha: 0.42, // 每参考帧的低通滤波比例
  // 灵敏度口径（2026-09 二次调优，依据现场诊断“挥掌32/40px·124px/s 仍不触发”）：
  // 速度线 260→200→120 —— 滤波值相位滞后使“滤波速度”仅约为真实速度的一半，
  // 260 旧线要求真实挥速 >550px/s、200 仍需 >420px/s，中等力度的挥掌（实测滤波后
  // 124px/s）被漏检；120 与抖动（滤波后 <60px/s）仍有 2 倍安全边际。
  speedPxS: 120,  // 速度触发线（滤波后 px/s）；抖动约 20-60px/s，刻意挥掌 >300px/s
  // 手宽比例 0.6→0.5、下限 22→20：同样物理挥幅在“手离相机稍远/取景偏广角”时
  // 采样行程偏短，比例阈值同步下调让中远距离挥掌不必挥满半屏才响应。
  handRelTravel: 0.5, // 阈值 = 手宽 × 此比例（角度缩放不变量）
  travelMinPx: 20,    // 手宽自适应阈值下限（防误触）
  // 封顶 40→30：实测大手近距（手宽 ≥80px）时阈值顶到 40px，正常挥幅只有 ~32px
  // 永远差一步；封顶 30 后同一挥幅可触发。误触由“触发后锁定+回位重新武装”
  // 与 minWaveMs 双重抑制，单次误翻可立刻反向挥回。
  travelMaxPx: 30     // 手宽自适应阈值上限（防迟钝）
});

/**
 * 创建挥掌跟踪器实例。
 * @param {Partial<typeof PALM_WAVE_DEFAULTS>} options 覆盖默认参数
 */
export function createPalmWaveTracker(options = {}) {
  const cfg = { ...PALM_WAVE_DEFAULTS, ...options };
  let startX = null, startAt = 0;
  let lastX = null, lastAt = 0;
  let pending = 0;
  let armed = true; // 触发后锁定，回位后重新武装（防止一次挥动连翻多页）
  let lastSpeed = 0;
  let lastThreshold = cfg.travelPx;

  /** 低通滤波掌心位置；alpha 按真实帧间隔指数补偿，与检测帧率无关。 */
  const filterX = (rawX, now) => {
    if (lastX === null || lastAt === 0) {
      lastX = rawX;
      lastAt = now;
      return rawX;
    }
    const dt = Math.max(1, now - lastAt);
    const alpha = Math.min(1, 1 - Math.pow(1 - cfg.filterAlpha, dt / cfg.refFrameMs));
    lastX = lastX + (rawX - lastX) * alpha;
    lastAt = now;
    return lastX;
  };

  /** 本帧生效的位移阈值：给了手宽就按比例算（带上下限），否则用固定口径。 */
  const thresholdFor = (handW) => {
    if (!handW || handW <= 0) return cfg.travelPx;
    return Math.min(Math.max(handW * cfg.handRelTravel, cfg.travelMinPx), cfg.travelMaxPx);
  };

  return {
    /**
     * 喂入一帧掌心 x（320 坐标系）与时间戳，返回判定结果。
     * @param {number} rawX 掌心 x
     * @param {number} now performance.now() 时间戳
     * @param {number} [handW] 本帧手部检测框宽度（320 坐标系），用于阈值自适应
     * @returns {{fired: boolean, direction: 1|-1, pending: 0|1|-1, travel: number,
     *           filteredX: number, speed: number, threshold: number}}
     *         fired=true 仅在本次挥动中返回一次，直到掌心回到基线附近重新武装。
     */
    update(rawX, now, handW) {
      const prevX = lastX, prevAt = lastAt;
      const x = filterX(rawX, now);
      lastThreshold = thresholdFor(handW);
      // 基线重置仅在已武装时生效：锁定期间重置会让“手回程”被当成新挥动再次触发。
      // （窗口超时是为了消化慢漂移；锁定状态由回位条件负责解锁，二者不能叠加。）
      if (armed && (startX === null || now - startAt > cfg.windowMs)) {
        startX = x;
        startAt = now;
        pending = 0;
      }
      // 预览水平镜像：屏幕行程 = -(滤波x - 起点x)；原始 x 增大（向左挥）为负。
      let travel = -(x - startX);
      if (!armed && Math.abs(travel) < cfg.pendingPx) {
        // 手已回到基线附近（挥完回收或自然停稳），重新武装并从当前位起算。
        armed = true;
        startX = x;
        startAt = now;
        travel = 0;
      }
      const direction = travel < 0 ? 1 : -1;
      // 瞬时速度：滤波值随真实帧间隔的位移（px/s），与检测帧率无关。
      lastSpeed = prevX === null || prevAt === 0
        ? 0
        : Math.abs(x - prevX) / Math.max(1, now - prevAt) * 1000;
      const fired = armed
        && now - startAt > cfg.minWaveMs
        && (Math.abs(travel) > lastThreshold
          || (lastSpeed > cfg.speedPxS && Math.abs(travel) > cfg.pendingPx));
      if (fired) armed = false;
      pending = Math.abs(travel) > cfg.pendingPx ? direction : 0;
      return { fired, direction, pending, travel, filteredX: x, speed: lastSpeed, threshold: lastThreshold };
    },

    /** 诊断 HUD 用：当前跟踪器内部状态。 */
    state() {
      return {
        travel: startX === null || lastX === null ? 0 : -(lastX - startX),
        armed,
        speed: lastSpeed,
        threshold: lastThreshold,
        startX,
        filteredX: lastX
      };
    },

    /** 丢弃全部状态（握拳回地球 / 关闭摄像头时调用）。 */
    reset() {
      startX = null;
      startAt = 0;
      lastX = null;
      lastAt = 0;
      pending = 0;
      armed = true;
      lastSpeed = 0;
      lastThreshold = cfg.travelPx;
    }
  };
}
