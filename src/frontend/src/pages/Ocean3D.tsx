/**
 * 海洋 3D 态势页（F2 MVP）—— 双模式:
 *  监测模式(科研/部门): 真实分站点数据柱 + 拉格朗日扩散推演(F3内核浏览器版)
 *  科普模式(志愿者/公众): 点击海面投放垃圾 → 漂移沉降 → 弹出具体危害链警示卡
 */
import { useEffect, useRef, useState } from 'react';
import { Wind, Crosshair, Info, Pause, Play, Radar, Sprout, Trash2, Waves, X } from 'lucide-react';
import { api } from '../services/api';
import type { SiteStat } from '../types';
import { OceanWorld } from '../three/oceanWorld';
import type { SiteVisual } from '../three/oceanWorld';
import { simulate } from '../three/diffusion';
import type { DiffusionResult } from '../three/diffusion';
import { GARBAGE_IMPACTS, impactByKey } from '../three/impactData';
import type { GarbageImpact } from '../three/impactData';

type Mode = 'monitor' | 'volunteer';

const LEVEL_COLOR = (index: number | null): string =>
  index == null ? '#2a7f9e' : index >= 7 ? '#ff5f6e' : index >= 5 ? '#ffbd66' : '#27dafa';
const LEVEL_TEXT = (index: number | null): string =>
  index == null ? '暂无数据' : index >= 7 ? '严重' : index >= 5 ? '中等' : '良好';

export function Ocean3DPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<OceanWorld | null>(null);
  const modeRef = useRef<Mode>('monitor');
  const garbageKeyRef = useRef('bag');
  const playTimerRef = useRef<number | null>(null);

  const [mode, setMode] = useState<Mode>('monitor');
  const [sites, setSites] = useState<SiteStat[]>([]);
  const [siteDetail, setSiteDetail] = useState<SiteVisual | null>(null);
  const [impact, setImpact] = useState<GarbageImpact | null>(null);
  const [dropCount, setDropCount] = useState(0);
  const [garbageKey, setGarbageKey] = useState('bag');

  // 扩散推演参数与播放状态
  const [originId, setOriginId] = useState<number | null>(null);
  const [windDeg, setWindDeg] = useState(135);
  const [windSpeed, setWindSpeed] = useState(6);
  const [diffK, setDiffK] = useState(100);
  const [durationH, setDurationH] = useState(72);
  const [playing, setPlaying] = useState(false);
  const [tFrac, setTFrac] = useState(0);
  const simRef = useRef<DiffusionResult | null>(null);

  // 世界初始化（一次）
  useEffect(() => {
    if (!containerRef.current) return;
    const world = new OceanWorld(containerRef.current, {
      onSiteClick: (site) => { setSiteDetail(site); },
      onWaterClick: (point) => {
        if (modeRef.current !== 'volunteer') return;
        const info = impactByKey(garbageKeyRef.current);
        world.dropGarbage(point, garbageKeyRef.current, info?.color ?? '#ff6f91');
        setDropCount((c) => c + 1);
      },
      onGarbageImpact: (key) => { setImpact(impactByKey(key) ?? null); },
    });
    worldRef.current = world;
    // 调试/测试暴露口（仅浏览器控制台使用，不参与业务逻辑）
    (window as unknown as Record<string, unknown>).__oceanWorld = world;
    api.getSiteStats().then((list) => {
      setSites(list);
      try { world.setSites(list); } catch (err) { (window as unknown as Record<string, unknown>).__ocean3dError = String(err); }
    })
      .catch(() => { /* 站点加载失败时场景仍可浏览（无数据柱） */ });
    return () => {
      if (playTimerRef.current) window.clearInterval(playTimerRef.current);
      world.dispose();
      worldRef.current = null;
    };
  }, []);

  // 模式切换同步（点击行为 + 状态清理）
  useEffect(() => {
    modeRef.current = mode;
    worldRef.current?.setClickMode(mode === 'volunteer' ? 'water' : 'site');
    setImpact(null);
    setSiteDetail(null);
  }, [mode]);
  useEffect(() => { garbageKeyRef.current = garbageKey; }, [garbageKey]);

  const stopPlay = () => {
    if (playTimerRef.current) { window.clearInterval(playTimerRef.current); playTimerRef.current = null; }
    setPlaying(false);
  };

  /** 生成并开始播放扩散推演 */
  const runSim = (siteId: number | undefined) => {
    const world = worldRef.current;
    if (!world || siteId == null) return;
    const result = simulate({
      durationH, nParticles: 600, dtS: 600,
      currentU: 0.25, currentV: 0.10,
      windSpeed, windDirDeg: windDeg, windFactor: 0.03,
      diffusivity: diffK, seed: 42,
    });
    simRef.current = result;
    setOriginId(siteId);
    world.setDiffusion(result, siteId);
    world.focusSite(siteId);
    setTFrac(0);
    stopPlay();
    setPlaying(true);
    playTimerRef.current = window.setInterval(() => {
      setTFrac((t) => {
        const next = t + 0.0045;
        if (next >= 1) { stopPlay(); return 1; }
        return next;
      });
    }, 80);
  };

  // 时间分数 → 场景粒子位置
  useEffect(() => {
    if (simRef.current) worldRef.current?.setDiffusionTime(tFrac);
  }, [tFrac]);

  useEffect(() => () => { if (playTimerRef.current) window.clearInterval(playTimerRef.current); }, []);

  const sim = simRef.current;
  const curStep = sim ? Math.floor(tFrac * sim.steps) : 0;
  const curRadiusKm = sim ? (sim.radius95[curStep] / 1000).toFixed(1) : '—';

  const firstSiteId = sites[0]?.id;

  return (
    <div className="ocean3d-page">
      <div ref={containerRef} className="ocean3d-canvas" />

      {/* 顶部: 标题 + 模式切换 */}
      <header className="ocean3d-topbar glass">
        <div>
          <span className="eyebrow"><i /> OCEAN DIGITAL TWIN</span>
          <h1>海洋 3D 态势</h1>
        </div>
        <div className="ocean3d-mode" role="tablist" aria-label="场景模式">
          <button className={mode === 'monitor' ? 'active' : ''} onClick={() => setMode('monitor')} role="tab" aria-selected={mode === 'monitor'}>
            <Radar size={15} />监测模式
          </button>
          <button className={mode === 'volunteer' ? 'active' : ''} onClick={() => setMode('volunteer')} role="tab" aria-selected={mode === 'volunteer'}>
            <Sprout size={15} />科普模式
          </button>
        </div>
      </header>

      {/* 监测模式: 站点面板 + 扩散推演控制 */}
      {mode === 'monitor' && (
        <aside className="ocean3d-panel glass">
          <h2><Waves size={15} />监测站点 · 实时数据</h2>
          <ul className="ocean3d-sites">
            {sites.length === 0 && <li className="ocean3d-empty">站点数据加载中或暂无站点…</li>}
            {sites.map((s) => (
              <li key={s.id}>
                <button onClick={() => { worldRef.current?.focusSite(s.id); setSiteDetail(s); }}>
                  <span className="dot" style={{ background: LEVEL_COLOR(s.pollutionIndex) }} />
                  <span className="code">{s.code}</span>
                  <span className="name">{s.name.replace('监测点', '')}</span>
                  <em style={{ color: LEVEL_COLOR(s.pollutionIndex) }}>
                    {s.pollutionIndex == null ? '—' : `${s.pollutionIndex.toFixed(1)}`}
                    <small>{s.taskCount}任务</small>
                  </em>
                </button>
              </li>
            ))}
          </ul>

          <h2 className="ocean3d-section"><Wind size={15} />垃圾漂移扩散推演</h2>
          <p className="ocean3d-hint">从站点释放虚拟粒子群，模拟垃圾随风与洋流的漂移扩散（简化拉格朗日模型）</p>
          <div className="ocean3d-sliders">
            <label>风向 <output>{windDeg}°</output>
              <input type="range" min={0} max={350} step={10} value={windDeg} onChange={(e) => setWindDeg(Number(e.target.value))} />
            </label>
            <label>风速 <output>{windSpeed} m/s</output>
              <input type="range" min={0} max={15} step={0.5} value={windSpeed} onChange={(e) => setWindSpeed(Number(e.target.value))} />
            </label>
            <label>扩散系数 <output>{diffK} m²/s</output>
              <input type="range" min={10} max={500} step={10} value={diffK} onChange={(e) => setDiffK(Number(e.target.value))} />
            </label>
            <label>推演时长 <output>{durationH} h</output>
              <input type="range" min={6} max={96} step={6} value={durationH} onChange={(e) => setDurationH(Number(e.target.value))} />
            </label>
          </div>
          <div className="ocean3d-actions">
            <button className="primary-button" onClick={() => runSim(originId ?? firstSiteId)} disabled={!firstSiteId}>
              <Play size={14} />{sim ? '重新推演' : '开始推演'}
            </button>
            {sim && (
              <button className="secondary-button" onClick={() => (playing ? stopPlay() : setPlaying(true))}>
                {playing ? <><Pause size={14} />暂停</> : <><Play size={14} />继续</>}
              </button>
            )}
          </div>
          {sim && (
            <div className="ocean3d-siminfo">
              <span>T+{(tFrac * durationH).toFixed(0)}h</span>
              <span>95%粒子半径 <b>{curRadiusKm} km</b></span>
              <input aria-label="推演时间轴" type="range" min={0} max={1000} value={Math.round(tFrac * 1000)}
                onChange={(e) => { stopPlay(); setTFrac(Number(e.target.value) / 1000); }} />
            </div>
          )}
          <p className="ocean3d-disclaimer"><Info size={12} />简化示意模型·非预报产品：均匀流场 + 3%风致漂移(Leeway) + 随机游走扩散；站点布局为示意</p>
        </aside>
      )}

      {/* 科普模式: 垃圾选择 + 投放引导 */}
      {mode === 'volunteer' && (
        <aside className="ocean3d-panel glass ocean3d-panel-left">
          <h2><Trash2 size={15} />投放垃圾 · 看看会发生什么</h2>
          <p className="ocean3d-hint">选择垃圾类型，<b>点击海面</b>投放，观察它的漂移沉降与真实危害链</p>
          <div className="ocean3d-chips">
            {GARBAGE_IMPACTS.map((g) => (
              <button key={g.key} className={garbageKey === g.key ? 'active' : ''} style={{ borderColor: garbageKey === g.key ? g.color : undefined }}
                onClick={() => setGarbageKey(g.key)}>
                <span className="dot" style={{ background: g.color }} />{g.name}
              </button>
            ))}
          </div>
          <div className="ocean3d-siminfo">
            <span>已投放 <b>{dropCount}</b> 件</span>
            <span><Wind size={12} />拖拽旋转视角 · 滚轮缩放</span>
          </div>
          <p className="ocean3d-disclaimer"><Info size={12} />危害链与数据来自项目海洋知识库；降解年限为量级估计</p>
        </aside>
      )}

      {/* 站点详情卡（点击数据柱） */}
      {siteDetail && (
        <div className="ocean3d-card glass">
          <button className="ocean3d-close" aria-label="关闭" onClick={() => setSiteDetail(null)}><X size={15} /></button>
          <h3><span className="dot" style={{ background: LEVEL_COLOR(siteDetail.pollutionIndex) }} />{siteDetail.code} · {siteDetail.name}</h3>
          <div className="ocean3d-kv">
            <span>污染指数</span><b style={{ color: LEVEL_COLOR(siteDetail.pollutionIndex) }}>{siteDetail.pollutionIndex?.toFixed(1) ?? '—'} / 10（{LEVEL_TEXT(siteDetail.pollutionIndex)}）</b>
            <span>检测任务</span><b>{siteDetail.taskCount} 次</b>
            <span>累计检出</span><b>{siteDetail.totalObjects} 件垃圾</b>
            <span>最近任务</span><b>{(siteDetail as SiteStat).lastTaskAt ?? '—'}</b>
          </div>
          {mode === 'monitor' && (
            <button className="primary-button" onClick={() => runSim(siteDetail.id)}><Crosshair size={13} />从此站点扩散推演</button>
          )}
        </div>
      )}

      {/* 危害链警示卡（科普模式） */}
      {impact && (
        <div className="ocean3d-card glass ocean3d-impact">
          <button className="ocean3d-close" aria-label="关闭" onClick={() => setImpact(null)}><X size={15} /></button>
          <h3 style={{ color: impact.color }}>{impact.name} 入海之后…</h3>
          <ol className="ocean3d-chain">
            {impact.chain.map((step, i) => <li key={i} style={{ animationDelay: `${i * 0.35}s` }}>{step}</li>)}
          </ol>
          <div className="ocean3d-degrade">
            <span>完全降解需要约</span>
            <b>{impact.degradeYears} 年</b>
            <small>{impact.degradeText}</small>
          </div>
          <p className="ocean3d-stat">{impact.stat}</p>
          <p className="ocean3d-disclaimer"><Info size={12} />来源：项目海洋知识库（data/knowledge）</p>
        </div>
      )}

      {/* 图例 */}
      <footer className="ocean3d-legend glass">
        <span><i style={{ background: '#27dafa' }} />污染良好</span>
        <span><i style={{ background: '#ffbd66' }} />污染中等</span>
        <span><i style={{ background: '#ff5f6e' }} />污染严重</span>
        <span><i style={{ background: '#54f1a9' }} />扩散粒子</span>
      </footer>
    </div>
  );
}
