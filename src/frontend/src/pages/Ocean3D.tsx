/**
 * 海洋 3D 态势页 —— 双模式 + 开放视角:
 *  监测模式: 真实站点数据 + 实时检测联动(上传影像→ROV巡检+标注帧上屏+目标标定)
 *            + 真实海况(Open-Meteo, 实测风场一键填入推演) + 污染告警联动
 *            + 扩散推演 + 检测证据联动(同步/大图/报告跳转)
 *  科普模式: 点击海面投放垃圾 → 沉降海底 → 持久污染(浑浊带/死鱼/水质下降)
 *            + 知识漂流瓶收集答题 + 数字人导游播报(投放汇总合并/队列不截断)
 *            + 右侧污染聚合面板(不再弹叠加卡片)
 *  环境: 昼夜(白天/黄昏/夜晚/自动循环) × 天气(晴/云/雨), 夜晚星空+月光+水下荧光
 *  视角: 自由飞行(WASD+QE, 双击方向键疾跑) / 站点聚焦(海面视角) / 水下ROV
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Wind, Crosshair, FileText, Globe2, Info, Maximize2, Minimize2, Pause, Play, Radar, Radio, RefreshCw, Sprout, Trash2, UploadCloud, Volume2, VolumeX, Waves, X } from 'lucide-react';
import { formatStoryYear } from '../three/story';
import type { GarbageStoryState } from '../three/story';
import { api, isMockMode } from '../services/api';
import type { MarineInfo, SiteStat, Summary, UserInfo } from '../types';
import { OceanWorld } from '../three/oceanWorld';
import type { SiteVisual } from '../three/oceanWorld';
import { simulate } from '../three/diffusion';
import type { DiffusionResult } from '../three/diffusion';
import { GARBAGE_IMPACTS, impactByKey } from '../three/impactData';
import type { GarbageImpact } from '../three/impactData';
import { KNOWLEDGE_POIS, loadPoiProgress, savePoiProgress } from '../data/knowledgePois';
import type { KnowledgePoi } from '../data/knowledgePois';
import { speakText, speakQueued, stopSpeaking } from '../services/speech';
import { emitBroadcast, flushDropsNow, hasGuideListener, onBroadcast, reportGarbageDrop } from '../services/broadcast';
import { GuideDock } from '../components/GuideDock';
import { playAlertSound, playChime, playSplashSound } from '../services/sfx';
import type { TimeMode, WeatherMode } from '../three/weather';

type Mode = 'monitor' | 'volunteer';

type GlobeStationView = {
  id: number;
  code: string;
  name: string;
  lat: number;
  lng: number;
  region: string;
  country: string;
  /** 环境质量评分 1-10(分高质量好); 未检测为 null */
  qualityScore: number | null;
  taskCount: number;
};

const DEMO_GLOBE_STATIONS: GlobeStationView[] = [
  { id: 1, code: 'CN-01', name: '北戴河站', lat: 39.82, lng: 119.52, region: '渤海 · 北戴河', country: '中国', qualityScore: null, taskCount: 0 },
  { id: 2, code: 'QHD-01', name: '秦皇岛站', lat: 39.93, lng: 119.60, region: '渤海 · 秦皇岛', country: '中国', qualityScore: null, taskCount: 0 },
  { id: 3, code: 'BHB-01', name: '渤海湾站', lat: 39.00, lng: 117.72, region: '渤海 · 渤海湾', country: '中国', qualityScore: null, taskCount: 0 },
];
/** 演示站点时间戳相对当前时间生成, 避免硬编码日期过期 */
const demoTimeAgo = (hoursAgo: number): string => {
  const d = new Date(Date.now() - hoursAgo * 3600e3);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const DEMO_SITE_STATS: SiteStat[] = DEMO_GLOBE_STATIONS.map((station, index) => ({
  id: station.id,
  code: station.code,
  name: station.name,
  lat: station.lat,
  lng: station.lng,
  taskCount: [24, 18, 11][index] ?? 0,
  totalObjects: [386, 214, 172][index] ?? 0,
  qualityScore: null, // 演示站点未检测 → 评分显示"未检测"
  lastTaskAt: demoTimeAgo([4 + Math.random() * 3, 11 + Math.random() * 3, 26 + Math.random() * 4][index] ?? 0),
}));
// 每片海域只保留一个代表监测站（北戴河/秦皇岛/渤海湾各一处）
const seenArea = new Set<number>();
const sitesForMode = (siteList: SiteStat[]): SiteStat[] => {
  if (siteList.length === 0) return DEMO_SITE_STATS;
  seenArea.clear();
  return siteList.filter((s) => {
    if (s.seaAreaId == null) return true;
    if (seenArea.has(s.seaAreaId)) return false;
    seenArea.add(s.seaAreaId);
    return true;
  });
};

/** 环境质量评分: 未检测过的站点 → null(显示"未检测");
 *  检测过的站点 → 后端 qualityScore(1-10 整数, 分越高质量越好) */
const qualityOf = (s: { qualityScore: number | null; taskCount: number }): number | null =>
  s.taskCount > 0 ? s.qualityScore : null;
const QUALITY_COLOR = (score: number | null): string =>
  score == null ? '#2a7f9e' : score >= 7 ? '#54f1a9' : score >= 4 ? '#ffbd66' : '#ff5f6e';
const QUALITY_TEXT = (score: number | null): string =>
  score == null ? '未检测' : score >= 7 ? '优' : score >= 4 ? '中' : '差';

const toGlobeStation = (site: SiteStat): GlobeStationView => ({
  id: site.id, code: site.code, name: site.name, lat: site.lat, lng: site.lng,
  region: '监测海域', country: '项目站点',
  qualityScore: qualityOf(site), taskCount: site.taskCount,
});

const buildGlobeStations = (siteList: SiteStat[]): GlobeStationView[] =>
  isMockMode() || siteList.length === 0 ? DEMO_GLOBE_STATIONS : siteList.slice(0, 3).map(toGlobeStation);

// 实时联动上传约束(与 Detection 页一致)
const LIVE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const LIVE_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const LIVE_MAX_IMAGES = 10;
const LIVE_MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const LIVE_MAX_VIDEO_SIZE = 500 * 1024 * 1024;

const DIR_NAMES = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const dirName = (deg: number | null): string =>
  deg == null ? '—' : `${DIR_NAMES[Math.round(deg / 45) % 8]} ${Math.round(deg)}°`;

/** 一次实时联动任务的状态(面板展示 + 驱动3D) */
interface LiveState {
  phase: 'uploading' | 'processing' | 'done' | 'error';
  kind: 'image' | 'video' | 'mock';
  siteId: number;
  progress: number;
  totalObjects: number;
  summary?: string;
  error?: string;
}

const LIVE_PHASE_TEXT: Record<LiveState['phase'], string> = {
  uploading: '上传中…',
  processing: '检测进行中，ROV 巡检作业',
  done: '联动检测完成',
  error: '任务失败',
};

export function Ocean3DPage({ user }: { user?: UserInfo | null }) {
  // ============ 用户组模式锁定（RBAC） ============
  // ocean3d_monitor（监测模式）/ ocean3d_science（科普模式）由用户组决定；
  // 权限未加载（演示模式/首帧）时双模式开放，加载后自动纠正到有权限的模式。
  const perms = user?.permissions;
  const allowMonitor = !perms || perms.includes('ocean3d_monitor');
  const allowVolunteer = !perms || perms.includes('ocean3d_science');
  const defaultMode: Mode = allowMonitor ? 'monitor' : 'volunteer';
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<OceanWorld | null>(null);
  const modeRef = useRef<Mode>(defaultMode);
  const garbageKeyRef = useRef('bag');
  const playTimerRef = useRef<number | null>(null);
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [sites, setSites] = useState<SiteStat[]>([]);
  const sitesRef = useRef<SiteStat[]>([]);
  useEffect(() => { sitesRef.current = sites; }, [sites]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [siteDetail, setSiteDetail] = useState<SiteVisual | null>(null);
  const [impact, setImpact] = useState<GarbageImpact | null>(null);
  const [dropCount, setDropCount] = useState(0);
  const [story, setStory] = useState<GarbageStoryState | null>(null);
  const [garbageKey, setGarbageKey] = useState('bag');
  const [voiceOn, setVoiceOn] = useState(true);
  const [waterQuality, setWaterQuality] = useState(100);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [resultVideoUrl, setResultVideoUrl] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState<number | null>(null);
  const [imageOverflow, setImageOverflow] = useState(false);
  const voiceOnRef = useRef(true);
  useEffect(() => { voiceOnRef.current = voiceOn; }, [voiceOn]);

  // 污染聚合面板数据(由活跃垃圾轮询聚合, 替代旧的多张拖拽警示卡)
  const [pollutions, setPollutions] = useState<Array<{ info: GarbageImpact; count: number }>>([]);
  const pollutionKeyRef = useRef('');
  const waterQualityValueRef = useRef(100);
  const storyKeyRef = useRef('');

  // 环境系统(昼夜/天气)
  const [envTime, setEnvTime] = useState<TimeMode>('day');
  const [envWeather, setEnvWeather] = useState<WeatherMode>('clear');
  const [envPhase, setEnvPhase] = useState('');

  // 同步检测按钮反馈
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncAt, setSyncAt] = useState<string | null>(null);

  // 扩散推演参数与播放状态
  const [originId, setOriginId] = useState<number | null>(null);
  const [windDeg, setWindDeg] = useState(135);
  const [windSpeed, setWindSpeed] = useState(6);
  const [diffK, setDiffK] = useState(100);
  const [durationH, setDurationH] = useState(72);
  const [playing, setPlaying] = useState(false);
  const [tFrac, setTFrac] = useState(0);
  const simRef = useRef<DiffusionResult | null>(null);

  const [globeActive, setGlobeActive] = useState(true);
  const globeActiveRef = useRef(true);
  const setGlobeMode = (active: boolean) => { globeActiveRef.current = active; setGlobeActive(active); };
  const [activeStation, setActiveStation] = useState(0);
  const [pollutionOpen, setPollutionOpen] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [visiblePanels, setVisiblePanels] = useState<Record<string, boolean>>({
    kpis: true, monitor: true, volunteer: true, pollution: true, detail: true, story: true, guide: true, legend: true,
  });
  const togglePanel = (key: string) => setVisiblePanels((current) => ({ ...current, [key]: !current[key] }));
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else pageRef.current?.requestFullscreen().catch(() => {});
  };
  useEffect(() => {
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, []);
  // 实时检测联动
  const [live, setLive] = useState<LiveState | null>(null);

  const livePollRef = useRef<number | null>(null);
  const liveUrlsRef = useRef<string[]>([]);
  // 异步联动任务序号: 自增使仍在飞的异步链失效(取消保护)
  const taskSeqRef = useRef(0);
  // 跨海域跃迁提示("已跨越 XX km 抵达 XX站")
  const [jumpToast, setJumpToast] = useState<string | null>(null);
  const jumpToastTimer = useRef<number | null>(null);

  // 真实海况
  const [marine, setMarine] = useState<MarineInfo | null>(null);
  const [windApplied, setWindApplied] = useState(false);

  // 科普知识收集 + 数字人导游
  const [quiz, setQuiz] = useState<KnowledgePoi | null>(null);
  const [quizWrong, setQuizWrong] = useState<number | null>(null);
  const [collectedPois, setCollectedPois] = useState<string[]>(() => loadPoiProgress());
  const [guideOpen, setGuideOpen] = useState(true);

  // 告警联动(首次同步只布防不触发, 之后指数≥7告警, 站点级5分钟冷却)
  const alertArmedRef = useRef(false);
  const lastAlertRef = useRef<Record<number, number>>({});
  const celebratedRef = useRef(false);

  /** 进入/跃迁抵达站点 → 场景播报站点实况(数字人在线由它念, 否则页面语音兜底);
   *  科普模式数据随站点刷新, 这里把"当前海域是谁"讲给用户听 */
  const announceStationArrival = (stationId: number, via: 'globe' | 'jump', km?: number | null) => {
    const site = sitesRef.current.find((s) => s.id === stationId);
    if (!site || modeRef.current !== 'volunteer') return;
    const quality = qualityOf(site);
    const level = quality == null ? '尚未检测，等待识别任务' : `环境质量评分 ${quality} 分（满分 10 分），水质${QUALITY_TEXT(quality)}`;
    const dist = via === 'jump' && km != null ? `跨越约 ${km} 公里海域，` : '';
    // 延迟发出: 从地球入场时 GuideDock 随海面视图重新挂载, 订阅就绪需要一拍;
    // 立即发会被"导游不在线→页面兜底"抢先, 导游挂载后收不到
    window.setTimeout(() => {
      emitBroadcast({
        kind: 'notice',
        text: `${dist}欢迎来到 ${site.code} ${site.name}。${level}，累计检出 ${site.totalObjects} 件垃圾。`,
      });
    }, via === 'globe' ? 1200 : 200);
  };

  // 世界初始化（一次）
  useEffect(() => {
    if (!containerRef.current) return;
    const world = new OceanWorld(containerRef.current, {
      onSiteClick: (site) => { setSiteDetail(site); setActiveStation(site.id); },
      onGlobeSelect: (station) => { setActiveStation(station.id); worldRef.current?.setActiveSite(station.id); },
      onGlobeEnter: (stationId) => {
        setGlobeMode(false);
        setActiveStation(stationId);
        worldRef.current?.setActiveSite(stationId);
        worldRef.current?.switchToSite(stationId);
        announceStationArrival(stationId, 'globe');
      },
      onSiteJump: (info) => {
        setActiveStation(info.toId);
        const to = sitesRef.current.find((s) => s.id === info.toId);
        const km = info.distanceKm != null ? Math.round(info.distanceKm) : null;
        const text = to
          ? `已跨越${km != null ? `约 ${km} km` : '一段海域'}抵达 ${to.code} · ${to.name.replace('监测点', '')}`
          : '跨海域跃迁完成';
        setJumpToast(text);
        if (jumpToastTimer.current) window.clearTimeout(jumpToastTimer.current);
        jumpToastTimer.current = window.setTimeout(() => setJumpToast(null), 4200);
        announceStationArrival(info.toId, 'jump', km);
      },
      onWaterClick: (point) => {
        if (modeRef.current !== 'volunteer') return;
        const info = impactByKey(garbageKeyRef.current);
        world.dropGarbage(point, garbageKeyRef.current, info?.color ?? '#ff6f91');
        setDropCount((c) => c + 1);
        if (voiceOnRef.current) playSplashSound();
        if (info) reportGarbageDrop(info.name, info.chain.slice(0, 2).join('，'));
      },
      onGarbageImpact: (key) => { setImpact(impactByKey(key) ?? null); },
      onPoiClick: (poi) => { setQuiz(poi); setQuizWrong(null); },
    });
    worldRef.current = world;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__oceanWorld = world;
    world.setKnowledgePOIs(KNOWLEDGE_POIS, loadPoiProgress());
    world.showGlobe(buildGlobeStations([]));
    setGlobeMode(true);
    let cancelled = false; // 卸载后不再写状态
    api.getSummary().then((data) => { if (!cancelled) setSummary(data); }).catch(() => { /* KPI条失败不阻塞场景 */ });
    api.getSiteStats().then((list) => {
      if (cancelled) return;
      const visibleSites = sitesForMode(list);
      setSites(visibleSites);
      try { world.setSites(visibleSites); } catch (err) { if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__ocean3dError = String(err); }
      if (globeActiveRef.current) world.showGlobe(buildGlobeStations(visibleSites));
    }).catch(() => {
      if (cancelled) return;
      const fallbackSites = sitesForMode([]);
      setSites(fallbackSites);
      world.setSites(fallbackSites);
      if (globeActiveRef.current) world.showGlobe(buildGlobeStations(fallbackSites));
    });

    return () => {
      if (playTimerRef.current) window.clearInterval(playTimerRef.current);
      if (jumpToastTimer.current) window.clearTimeout(jumpToastTimer.current);
      ++taskSeqRef.current;
      for (const url of liveUrlsRef.current) URL.revokeObjectURL(url);
      liveUrlsRef.current = [];
      stopSpeaking();
      flushDropsNow();
      world.dispose();
      worldRef.current = null;
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).__oceanWorld;
        delete (window as unknown as Record<string, unknown>).__ocean3dError;
      }
    };
  }, []);

  // 真实海况: 跟随当前站点坐标取数(后端按坐标独立缓存30分钟), 切站即刷新
  useEffect(() => {
    let cancelled = false;
    const site = sites.find((s) => s.id === activeStation);
    api.getMarine(site?.lat, site?.lng)
      .then((info) => { if (!cancelled) setMarine(info); })
      .catch(() => { if (!cancelled) setMarine(null); });
    return () => { cancelled = true; };
  }, [activeStation, sites]);

  // 模式锁定纠偏：权限加载完成后，若当前模式不在允许集合内，切到有权限的模式
  useEffect(() => {
    if (mode === 'monitor' && !allowMonitor) setMode('volunteer');
    if (mode === 'volunteer' && !allowVolunteer) setMode('monitor');
  }, [mode, allowMonitor, allowVolunteer]);

  // 模式切换同步（点击行为 + 状态清理）
  useEffect(() => {
    modeRef.current = mode;
    worldRef.current?.setClickMode(mode === 'volunteer' ? 'water' : 'site');
    setImpact(null);
    setSiteDetail(null);
    if (mode !== 'monitor') clearLive();
    flushDropsNow();
    if (mode !== 'volunteer') setPollutions([]);
  }, [mode]);
  useEffect(() => { garbageKeyRef.current = garbageKey; }, [garbageKey]);

  // 广播兜底: 数字人导游坞不在线时, 投放汇总改走语音队列(导游在线时由它念, 不双声道)
  useEffect(() => onBroadcast((msg) => {
    if (hasGuideListener()) return;
    if (voiceOnRef.current) speakQueued(msg.text);
  }), []);

  // 科普叙事HUD: 轮询时间加速状态 + 水质 + 污染聚合面板数据(活跃垃圾按类型计数)
  useEffect(() => {
    if (mode !== 'volunteer') {
      setStory(null); setWaterQuality(100); setPollutions([]);
      storyKeyRef.current = ''; waterQualityValueRef.current = 100; pollutionKeyRef.current = '';
      return;
    }
    const timer = window.setInterval(() => {
      // 与上次内容一致则跳过 setState, 避免每200ms无谓重渲染
      const nextStory = worldRef.current?.getGarbageStoryState() ?? null;
      const storyKey = nextStory ? `${nextStory.year}|${nextStory.stage}|${nextStory.stageLabel}|${nextStory.degradationYears}|${nextStory.active ? 1 : 0}` : '';
      if (storyKey !== storyKeyRef.current) { storyKeyRef.current = storyKey; setStory(nextStory); }
      const active = worldRef.current?.getActiveGarbage() ?? [];
      const quality = Math.max(28, 100 - active.length * 9);
      if (quality !== waterQualityValueRef.current) { waterQualityValueRef.current = quality; setWaterQuality(quality); }
      const byKey = new Map<string, number>();
      for (const item of active) byKey.set(item.key, (byKey.get(item.key) ?? 0) + 1);
      const nextPollutions = Array.from(byKey.entries())
        .map(([key, count]) => ({ info: impactByKey(key), count }))
        .filter((p): p is { info: GarbageImpact; count: number } => p.info != null);
      const pollutionKey = nextPollutions.map((p) => `${p.info.key}:${p.count}`).join('|');
      if (pollutionKey !== pollutionKeyRef.current) { pollutionKeyRef.current = pollutionKey; setPollutions(nextPollutions); }
    }, 200);
    return () => window.clearInterval(timer);
  }, [mode]);

  // auto 昼夜循环的时段标签轮询
  useEffect(() => {
    if (envTime !== 'auto') { setEnvPhase(''); return; }
    const timer = window.setInterval(() => setEnvPhase(worldRef.current?.envPhaseLabel ?? ''), 1000);
    return () => window.clearInterval(timer);
  }, [envTime]);

  // 监测模式: 每45s自动同步站点数据(上传识别后 3D 自动跟进) + 手动同步共用
  const syncSites = (manual = false) => {
    const world = worldRef.current;
    if (!world) return;
    if (manual) setSyncBusy(true);
    api.getSiteStats().then((list) => {
      const visibleSites = sitesForMode(list);
      setSites(visibleSites);
      // 详情卡跟随最新站点数据刷新, 站点被移除时关闭详情卡
      setSiteDetail((prev) => (prev ? visibleSites.find((s) => s.id === prev.id) ?? null : prev));
      try { world.setSites(visibleSites); } catch { /* 场景未就绪时忽略 */ }
      if (manual) {
        setSyncAt(new Date().toTimeString().slice(0, 5));
        api.getSummary().then(setSummary).catch(() => undefined);
      }
      // 告警联动: 指数≥7 → 3D红环+光束+提示音+语音(站点级5分钟冷却, 首次同步仅布防)
      if (!alertArmedRef.current) {
        alertArmedRef.current = true;
        const now = Date.now();
        for (const s of list) lastAlertRef.current[s.id] = now;
        return;
      }
      const now = Date.now();
      for (const s of list) {
        if (s.qualityScore != null && s.qualityScore <= 3 && now - (lastAlertRef.current[s.id] ?? 0) > 300000) {
          lastAlertRef.current[s.id] = now;
          world.triggerAlert(s.id);
          playAlertSound();
          if (voiceOnRef.current) {
            speakText(`告警：${s.name}环境质量评分仅${s.qualityScore}分，水质严重恶化`, { force: true });
          }
        }
      }
    }).catch(() => undefined)
      .finally(() => setSyncBusy(false));
  };
  useEffect(() => {
    if (mode !== 'monitor') return;
    const timer = window.setInterval(() => syncSites(), 45000);
    return () => window.clearInterval(timer);
  }, [mode]);

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

  // ---------- 实时检测联动(上传影像 → 3D场景实时呈现) ----------

  /** 清除联动: 停轮询/回收预览URL/移除3D叠加层 */
  const clearLive = () => {
    ++taskSeqRef.current; // 使仍在飞的异步联动链失效
    if (livePollRef.current) {
      window.clearInterval(livePollRef.current);
      window.clearTimeout(livePollRef.current);
      livePollRef.current = null;
    }
    for (const url of liveUrlsRef.current) URL.revokeObjectURL(url);
    liveUrlsRef.current = [];
    worldRef.current?.clearLiveTask();
    setLive(null);
    setResultVideoUrl(null);
  };

  /** Mock模式: 客户端模拟一次完整联动(无后端也能演示全流程) */
  const runMockLive = (siteId: number, siteCode: string) => {
    const world = worldRef.current;
    if (!world) return;
    const seq = ++taskSeqRef.current;
    world.startLiveTask(siteId, siteCode);
    world.focusSite(siteId);
    setLive({ phase: 'processing', kind: 'mock', siteId, progress: 0, totalObjects: 0 });
    let progress = 0;
    let objects = 0;
    const timer = window.setInterval(() => {
      if (seq !== taskSeqRef.current) { window.clearInterval(timer); livePollRef.current = null; return; }
      progress = Math.min(100, progress + 4 + Math.random() * 7);
      objects += Math.random() < 0.75 ? 1 + Math.floor(Math.random() * 2) : 0;
      world.updateLiveTaskProgress({ progress, totalObjects: objects });
      if (Math.random() < 0.6) {
        const g = GARBAGE_IMPACTS[Math.floor(Math.random() * GARBAGE_IMPACTS.length)];
        world.feedLiveTaskTargets([{ name: g.name, confidence: 0.55 + Math.random() * 0.4 }]);
      }
      setLive((l) => (l ? { ...l, progress, totalObjects: objects } : l));
      if (progress >= 100) {
        window.clearInterval(timer);
        livePollRef.current = null;
        const summaryText = `模拟检测完成 · 检出 ${objects} 件`;
        world.finishLiveTask(summaryText);
        setLive((l) => (l ? { ...l, phase: 'done', summary: summaryText } : l));
        if (voiceOnRef.current) speakText(`${siteCode}站${summaryText}`, { force: true });
      }
    }, 650);
    livePollRef.current = timer;
  };

  /** 视频联动: 异步任务轮询驱动(标注帧上屏 + 进度 + 完成后目标标定) */
  const runLiveVideo = async (file: File, siteId: number, siteCode: string) => {
    const world = worldRef.current;
    if (!world) return;
    const seq = ++taskSeqRef.current; // 取消保护: 序号变化或已卸载时丢弃后续写入
    const stale = (): boolean => seq !== taskSeqRef.current || !worldRef.current;
    setLive({ phase: 'uploading', kind: 'video', siteId, progress: 0, totalObjects: 0 });
    try {
      // 后端 site_id 字段语义是"海域id": 必须传站点挂靠的海域, 而非站点本身
      const { taskId } = await api.createVideoTask(file, sites.find((s) => s.id === siteId)?.seaAreaId ?? undefined);
      if (stale()) return;
      world.startLiveTask(siteId, siteCode);
      world.focusSite(siteId);
      setLive({ phase: 'processing', kind: 'video', siteId, progress: 0, totalObjects: 0 });
      const poll = async (): Promise<void> => {
        const st = await api.getVideoStatus(taskId);
        if (stale()) return;
        world.updateLiveTaskProgress({
          progress: st.progress,
          totalObjects: st.totalObjects,
          processedFrames: st.processedFrames ?? null,
          totalFrames: st.totalFrames ?? null,
        });
        if (st.previewUrl) world.showLiveTaskFrame(st.previewUrl);
        setLive((l) => (l ? { ...l, progress: st.progress, totalObjects: st.totalObjects } : l));
        if (st.status === 'completed') {
          let summaryText = `检测完成 · 检出 ${st.totalObjects} 件`;
          try {
            const res = await api.getVideoResult(taskId);
            if (stale()) return;
            world.feedLiveTaskTargets(res.results.slice(0, 48).map((r) => ({ name: r.className, confidence: r.confidence })));
            setResultVideoUrl(res.annotatedVideoUrl ?? st.previewUrl ?? null);
          } catch { /* 目标列表失败不阻塞完成态 */ }
          world.finishLiveTask(summaryText);
          setLive({ phase: 'done', kind: 'video', siteId, progress: 100, totalObjects: st.totalObjects, summary: summaryText });
          syncSites(true);
          if (voiceOnRef.current) speakText(`${siteCode}站${summaryText}`, { force: true });
          return;
        }
        if (st.status === 'failed') {
          world.finishLiveTask('任务失败');
          setLive((l) => (l ? { ...l, phase: 'error', error: '视频识别失败，请重试' } : l));
          return;
        }
        livePollRef.current = window.setTimeout(poll, 1200);
      };
      await poll();
    } catch (reason) {
      if (stale()) return; // 已被新任务/清除/卸载取代, 不再写场景与状态
      world.finishLiveTask('任务失败');
      setLive((l) => (l ? { ...l, phase: 'error', error: reason instanceof Error ? reason.message : '任务创建失败' } : l));
    }
  };

  /** 图片联动: 批量识别, 本地预览图+检测框上屏, 汇总目标标定 */
  const runLiveImages = async (files: File[], siteId: number, siteCode: string) => {
    const world = worldRef.current;
    if (!world) return;
    const seq = ++taskSeqRef.current;
    const stale = (): boolean => seq !== taskSeqRef.current || !worldRef.current;
    // 覆盖前先回收上一批预览URL, 避免blob泄漏
    for (const old of liveUrlsRef.current) URL.revokeObjectURL(old);
    const urls = files.map((f) => URL.createObjectURL(f));
    liveUrlsRef.current = urls;
    setLive({ phase: 'processing', kind: 'image', siteId, progress: 3, totalObjects: 0 });
    world.startLiveTask(siteId, siteCode);
    world.focusSite(siteId);
    world.showLiveTaskFrame(urls[0]);
    try {
      const res = await api.detectImages(files, (current, total) => {
        if (stale()) return;
        const progress = Math.min(95, Math.round((current / total) * 92) + 3);
        world.updateLiveTaskProgress({ progress, totalObjects: 0, processedFrames: current, totalFrames: total });
        const url = urls[current - 1];
        if (url) world.showLiveTaskFrame(url);
        setLive((l) => (l ? { ...l, progress } : l));
      }, sites.find((s) => s.id === siteId)?.seaAreaId ?? undefined);
      if (stale()) return; // 任务已被取消: 回收工作交给 clearLive/卸载清理
      const okItems = res.items.filter((i) => i.success && i.result);
      const targets = okItems
        .flatMap((i) => (i.result?.objects ?? []).map((o) => ({ name: o.labelZh || o.label, confidence: o.confidence })))
        .slice(0, 48);
      world.feedLiveTaskTargets(targets);
      // 最优结果(检出最多的一张)画框上屏
      const best = okItems.slice().sort((a, b) => (b.result?.objects.length ?? 0) - (a.result?.objects.length ?? 0))[0];
      if (best?.result) {
        const r = best.result;
        const idx = okItems.indexOf(best);
        world.showLiveTaskFrame(urls[idx], r.objects.map((o) => ({
          x: o.bbox[0] / r.sourceWidth, y: o.bbox[1] / r.sourceHeight,
          w: o.bbox[2] / r.sourceWidth, h: o.bbox[3] / r.sourceHeight,
        })));
      }
      const totalObjects = okItems.reduce((s, i) => s + (i.result?.objects.length ?? 0), 0);
      const summaryText = `${res.successCount} 张图片 · 检出 ${totalObjects} 件`;
      world.updateLiveTaskProgress({ progress: 100, totalObjects, processedFrames: res.successCount, totalFrames: res.total });
      world.finishLiveTask(summaryText);
      setLive({ phase: 'done', kind: 'image', siteId, progress: 100, totalObjects, summary: summaryText });
      syncSites(true);
      if (voiceOnRef.current) speakText(`${siteCode}站联动检测完成，${summaryText}`, { force: true });
    } catch (reason) {
      if (stale()) return;
      world.finishLiveTask('任务失败');
      setLive((l) => (l ? { ...l, phase: 'error', error: reason instanceof Error ? reason.message : '识别任务失败，请重试' } : l));
    }
  };

  const onLiveFile = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0 || !worldRef.current) return;
    // 联动目标固定为当前聚焦站点(原"联动站点"下拉已移除: 聚焦谁就对谁联动)
    const siteId = activeStation || sites[0]?.id || 1;
    const siteCode = sites.find((s) => s.id === siteId)?.code ?? `站点${siteId}`;
    if (isMockMode()) { runMockLive(siteId, siteCode); return; }
    const file = files[0];
    if (file.type.startsWith('video/')) {
      if (!LIVE_VIDEO_TYPES.includes(file.type)) {
        setLive({ phase: 'error', kind: 'video', siteId, progress: 0, totalObjects: 0, error: `不支持的视频格式（${file.type || '未知'}），请使用 MP4/WebM` });
        return;
      }
      if (file.size > LIVE_MAX_VIDEO_SIZE) {
        setLive({ phase: 'error', kind: 'video', siteId, progress: 0, totalObjects: 0, error: '视频超过 500MB 上限' });
        return;
      }
      void runLiveVideo(file, siteId, siteCode);
    } else {
      setImageOverflow(files.length > LIVE_MAX_IMAGES);
      const images = files.slice(0, LIVE_MAX_IMAGES);
      for (const f of images) {
        if (!LIVE_IMAGE_TYPES.includes(f.type)) {
          setLive({ phase: 'error', kind: 'image', siteId, progress: 0, totalObjects: 0, error: `不支持的图片格式（${f.type || '未知'}），请使用 JPG/PNG/WebP` });
          return;
        }
        if (f.size > LIVE_MAX_IMAGE_SIZE) {
          setLive({ phase: 'error', kind: 'image', siteId, progress: 0, totalObjects: 0, error: '单张图片超过 10MB 上限' });
          return;
        }
      }
      void runLiveImages(images, siteId, siteCode);
    }
  };

  // ---------- 真实海况: 实测风场一键填入推演 ----------

  const applyMarineWind = () => {
    if (!marine || marine.windSpeedMs == null || marine.windDirectionDeg == null) return;
    // 推演用"风作用去向", 气象风向是"来向", 差180°
    const to = (marine.windDirectionDeg + 180) % 360;
    setWindDeg(Math.round(to / 10) * 10 % 360);
    setWindSpeed(Math.min(15, Math.max(0, Math.round(marine.windSpeedMs * 2) / 2)));
    setWindApplied(true);
  };

  // ---------- 科普知识收集 ----------

  const answerQuiz = (index: number) => {
    if (!quiz || collectedPois.includes(quiz.id)) return;
    if (index === quiz.answer) {
      playChime();
      worldRef.current?.markPoiCollected(quiz.id);
      setCollectedPois((prev) => {
        if (prev.includes(quiz.id)) return prev;
        const next = [...prev, quiz.id];
        savePoiProgress(next);
        return next;
      });
      setQuizWrong(null);
      if (voiceOnRef.current) speakText(`${quiz.title}，答对了！${quiz.explain}`, { force: true });
    } else {
      setQuizWrong(index);
    }
  };

  // 集齐全部知识瓶 → 一次性庆祝播报
  useEffect(() => {
    if (mode === 'volunteer' && !celebratedRef.current && collectedPois.length >= KNOWLEDGE_POIS.length) {
      celebratedRef.current = true;
      if (voiceOnRef.current) speakText('恭喜你集齐了全部海洋知识徽章，你就是这片海域的守护者！', { force: true });
    }
  }, [collectedPois, mode]);

  const sim = simRef.current;
  const curStep = sim ? Math.floor(tFrac * sim.steps) : 0;
  const curRadiusKm = sim ? (sim.radius95[curStep] / 1000).toFixed(1) : '—';

  const firstSiteId = sites[0]?.id; // 扩散推演的兜底起点
  // 科普模式"当前站点实况": 跟随所选站点与最新同步数据, 切站点即刷新
  const activeSite = sites.find((s) => s.id === activeStation) ?? null;
  const liveBusy = live?.phase === 'uploading' || live?.phase === 'processing';
  const quizSolved = quiz != null && collectedPois.includes(quiz.id);

  return (
    <div ref={pageRef} className={`ocean3d-page ${globeActive ? 'globe-mode' : ''}${visiblePanels.kpis ? '' : ' hide-kpis'}${visiblePanels.monitor ? '' : ' hide-monitor'}${visiblePanels.volunteer ? '' : ' hide-volunteer'}${visiblePanels.pollution ? '' : ' hide-pollution'}${visiblePanels.detail ? '' : ' hide-detail'}${visiblePanels.story ? '' : ' hide-story'}${visiblePanels.guide ? '' : ' hide-guide'}${visiblePanels.legend ? '' : ' hide-legend'}`}>
      <div ref={containerRef} className="ocean3d-canvas" />
      {globeActive && (
        <aside className="ocean3d-globe-sites glass" aria-label="全球监测站点">
          <div className="globe-sites-heading"><span className="globe-eyebrow">GLOBAL OCEAN NETWORK</span><h2>监测站点</h2><p>选择站点，地球将自动定位并进入海面环境</p></div>
          <div className="globe-site-list">
            {buildGlobeStations(sites).map((station) => (
              <button key={station.id} className={activeStation === station.id ? 'active' : ''} onClick={() => { setActiveStation(station.id); worldRef.current?.travelGlobeToSite(station.id); }}>
                <span className="globe-site-status" style={{ background: QUALITY_COLOR(station.qualityScore) }} />
                <span className="globe-site-copy"><b>{station.code} · {station.name}</b><small>{station.country} · {station.region}</small></span>
                <span className="globe-site-risk">{station.qualityScore == null ? '未检测' : `${station.qualityScore}分 · ${QUALITY_TEXT(station.qualityScore)}`}</span>
              </button>
            ))}
          </div>
        </aside>
      )}
      {!globeActive && (<>
      <header className="ocean3d-topbar glass">
        <div>
          <span className="eyebrow"><i /> OCEAN DIGITAL TWIN</span>
          <h1>海洋 3D 态势</h1>
        </div>
        <div className="ocean3d-topbar-actions">
          <button className="topbar-btn globe-btn" aria-label="返回地球" title="返回地球选择站点" onClick={() => { worldRef.current?.showGlobe(buildGlobeStations(sites)); setGlobeMode(true); }}><Globe2 size={17} /></button>
          <button className="topbar-btn" aria-label={fullscreen ? '退出全屏' : '进入全屏'} title={fullscreen ? '退出全屏' : '进入全屏'} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          {/* 环境系统: 昼夜 × 天气 */}
          <div className="ocean3d-env" aria-label="环境模式">
            <div className="env-group" role="group" aria-label="时间模式">
              {([['day', '白昼'], ['sunset', '黄昏'], ['night', '夜晚'], ['auto', '自动']] as Array<[TimeMode, string]>).map(([value, label]) => (
                <button key={value} className={envTime === value ? 'active' : ''} title={value === 'auto' ? '昼夜自动循环(约3.5分钟一天)' : `切换到${label}`}
                  onClick={() => { setEnvTime(value); worldRef.current?.setEnvTime(value); }}>
                  {label}
                </button>
              ))}
              {envTime === 'auto' && envPhase && <em className="env-phase">{envPhase}</em>}
            </div>
            <div className="env-group" role="group" aria-label="天气模式">
              {([['clear', '晴'], ['cloudy', '多云'], ['rain', '雨']] as Array<[WeatherMode, string]>).map(([value, label]) => (
                <button key={value} className={envWeather === value ? 'active' : ''} title={`切换到${label}天`}
                  onClick={() => { setEnvWeather(value); worldRef.current?.setEnvWeather(value); }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="ocean3d-mode" role="tablist" aria-label="场景模式">
            {allowMonitor && (
              <button className={mode === 'monitor' ? 'active' : ''} onClick={() => setMode('monitor')} role="tab" aria-selected={mode === 'monitor'}>
                <Radar size={15} />监测模式
              </button>
            )}
            {allowVolunteer && (
              <button className={mode === 'volunteer' ? 'active' : ''} onClick={() => setMode('volunteer')} role="tab" aria-selected={mode === 'volunteer'}>
                <Sprout size={15} />科普模式
              </button>
            )}
          </div>
        </div>
      </header>
      <nav className="ocean3d-panel-controls" aria-label="3D面板显示控制">
        {(mode === 'monitor'
          ? ([['kpis', '数据总览'], ['monitor', '监测面板']] as const)
          : ([['volunteer', '科普面板'], ['guide', '数字人']] as const)
        ).map(([key, label]) => <button key={key} className={visiblePanels[key] ? 'active' : ''} onClick={() => togglePanel(key)}>{label}</button>)}
      </nav>



      {/* 全局KPI实数条（系统真实统计, 3D场景与项目业务接轨的门面） */}
      {visiblePanels.kpis && mode === 'monitor' && summary && (
        <div className="ocean3d-kpis">
          <button className="ocean3d-panel-close" aria-label="关闭数据总览" onClick={() => togglePanel('kpis')}><X size={13} /></button>
          <div className="glass"><b>{summary.totalTasks}</b><span>累计任务</span></div>
          <div className="glass"><b>{summary.totalObjects}</b><span>检出目标</span></div>
          <div className="glass"><b>{summary.seaAreas}</b><span>监测海域</span></div>
          <div className="glass"><b>{summary.activeAlerts}</b><span>污染告警</span></div>
        </div>
      )}

      {/* 监测模式: 站点面板 + 实时联动 + 海况 + 扩散推演控制 */}
      {visiblePanels.monitor && mode === 'monitor' && (
        <aside className="ocean3d-panel glass">
          <h2><Waves size={15} />监测站点 · 实时数据
            <span className="ocean3d-panel-heading-actions">
              <button className="ocean3d-sync" disabled={syncBusy} title="同步最新检测数据(上传识别后点击或等待45s自动同步)" onClick={() => syncSites(true)}>
                <RefreshCw size={13} className={syncBusy ? 'spin' : undefined} />{syncBusy ? '同步中…' : syncAt ? `同步 ${syncAt}` : '同步检测'}
              </button>
              <button className="ocean3d-panel-close" aria-label="关闭监测面板" onClick={() => togglePanel('monitor')}><X size={13} /></button>
            </span>
          </h2>
          <ul className="ocean3d-sites">
            {sites.length === 0 && <li className="ocean3d-empty">{isMockMode() ? 'Mock 模式：站点数据不加载' : '站点数据加载中或暂无站点…'}</li>}
            {sites.map((s) => (
              <li key={s.id}>
                <button onClick={() => { worldRef.current?.focusSite(s.id); setSiteDetail(s); }}>
                  <span className="dot" style={{ background: QUALITY_COLOR(qualityOf(s)) }} />
                  <span className="code">{s.code}</span>
                  <span className="name">{s.name.replace('监测点', '')}</span>
                  <em style={{ color: QUALITY_COLOR(qualityOf(s)) }}>
                    {qualityOf(s) == null ? '未检测' : `${qualityOf(s)}分`}
                    <small>{s.taskCount}任务</small>
                  </em>
                </button>
              </li>
            ))}
          </ul>

          <h2 className="ocean3d-section"><Radio size={15} />实时检测联动</h2>
          <p className="ocean3d-hint">上传水下影像，任务<b>实时驱动当前站点场景</b>：任务ROV出发巡检、标注帧同步上屏、检出目标逐个标定，完成后站点指数自动刷新{isMockMode() ? '（Mock 模式将模拟全流程）' : ''}</p>
          <div className="ocean3d-live">
            <label className={`ocean3d-live-upload${liveBusy ? ' busy' : ''}${live?.phase === 'done' ? ' done' : ''}`}>
              <input type="file" multiple accept={LIVE_IMAGE_TYPES.concat(LIVE_VIDEO_TYPES).join(',')}
                onChange={onLiveFile} disabled={liveBusy} aria-label="上传影像开始实时联动" />
              <UploadCloud size={14} />{liveBusy ? '检测进行中…' : live?.phase === 'done' ? '再传一次' : '上传影像 · 开始联动'}
            </label>
            {imageOverflow && <p className="ocean3d-hint">单次最多识别 {LIVE_MAX_IMAGES} 张，已仅取前 {LIVE_MAX_IMAGES} 张</p>}
            {live && (
              <div className={`ocean3d-live-status phase-${live.phase}`}>
                <div className="ocean3d-live-bar"><i style={{ width: `${live.progress}%` }} /></div>
                <div className="ocean3d-live-meta">
                  <span>{LIVE_PHASE_TEXT[live.phase]}{live.kind === 'mock' ? '（模拟）' : ''}</span>
                  <span>检出 <b>{live.totalObjects}</b> 件</span>
                  {(live.phase === 'done' || live.phase === 'error') && (
                    <button onClick={clearLive}>{live.phase === 'done' ? '清除联动' : '关闭'}</button>
                  )}
                </div>
                {live.phase === 'done' && live.summary && (
                  <p className="ok">
                    {live.summary} · 已同步站点数据
                    {resultVideoUrl && <button className="ocean3d-sync" style={{ marginLeft: 8 }} onClick={() => setLightbox(resultVideoUrl)}>查看识别视频</button>}
                  </p>
                )}
                {live.phase === 'error' && <p className="err">{live.error ?? '未知错误'}</p>}
              </div>
            )}
          </div>

          <h2 className="ocean3d-section"><Wind size={15} />真实海况 · {activeSite ? activeSite.name.replace(/监测点|监测站点/g, '') : '当前海域'}</h2>
          {marine ? (
            <div className="ocean3d-marine">
              <div><span>有效波高</span><b>{marine.waveHeightM ?? '—'} m</b></div>
              <div><span>浪向(来向)</span><b>{dirName(marine.waveDirectionDeg)}</b></div>
              <div><span>海表温度</span><b>{marine.seaTempC ?? '—'} ℃</b></div>
              <div><span>风速</span><b>{marine.windSpeedMs ?? '—'} m/s</b></div>
              <div><span>风向(来向)</span><b>{dirName(marine.windDirectionDeg)}</b></div>
              <div><span>观测时间</span><b>{(() => { const t = marine.observedAt ?? marine.fetchedAt; return t.length > 5 ? t.slice(5, 16) : t; })()}</b></div>
              <button className="ocean3d-marine-apply" onClick={applyMarineWind}
                disabled={marine.windSpeedMs == null || marine.windDirectionDeg == null}>
                <Wind size={12} />{windApplied ? '已填入 ✓ 实测风场' : '用实测风场填入推演'}
              </button>
              <p className="ocean3d-hint">
                {marine.stale ? '当前为离线缓存数据（外网不可达）· ' : ''}数据源 Open-Meteo 海洋 API，后端每 30 分钟更新
              </p>
            </div>
          ) : (
            <p className="ocean3d-hint">海况数据加载中或暂不可用（后端离线且无缓存时隐藏）…</p>
          )}

          <h2 className="ocean3d-section"><Wind size={15} />垃圾漂移扩散推演</h2>
          <p className="ocean3d-hint">从站点释放虚拟粒子群，模拟垃圾随风与洋流的漂移扩散（简化拉格朗日模型）</p>
          <div className="ocean3d-sliders">
            <label>风向 <output>{windDeg}°{windApplied && <i className="live-flag" title="已填入实测风场" />}</output>
              <input type="range" min={0} max={350} step={10} value={windDeg} onChange={(e) => { setWindDeg(Number(e.target.value)); setWindApplied(false); }} />
            </label>
            <label>风速 <output>{windSpeed} m/s</output>
              <input type="range" min={0} max={15} step={0.5} value={windSpeed} onChange={(e) => { setWindSpeed(Number(e.target.value)); setWindApplied(false); }} />
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

      {/* 科普模式左列: 科普面板在上, 污染提示紧随其后(纵向流式排列, 结构上不可能重叠) */}
      {mode === 'volunteer' && (
        <div className="ocean3d-left-stack">
      {visiblePanels.volunteer && (
        <aside className="ocean3d-panel glass ocean3d-panel-left">
          <h2><Trash2 size={15} />投放垃圾 · 看看会发生什么 <button className="ocean3d-panel-close" aria-label="关闭科普面板" onClick={() => togglePanel('volunteer')}><X size={13} /></button></h2>
          {/* 当前站点实况: 随所选站点与同步数据刷新, 不同海域内容不同 */}
          {activeSite ? (
            <div className="ocean3d-site-live" aria-label="当前站点实况">
              <span className="globe-eyebrow">CURRENT STATION</span>
              <b>{activeSite.code} · {activeSite.name}</b>
              <div className="ocean3d-kv">
                <span>环境评分</span>
                <b style={{ color: QUALITY_COLOR(qualityOf(activeSite)) }}>
                  {qualityOf(activeSite) == null ? '未检测 · 识别后生成' : `${qualityOf(activeSite)} / 10（${QUALITY_TEXT(qualityOf(activeSite))}）`}
                </b>
                <span>累计检出</span><b>{activeSite.totalObjects} 件垃圾</b>
                <span>最近任务</span><b>{activeSite.lastTaskAt ?? '—'}</b>
              </div>
            </div>
          ) : (
            <p className="ocean3d-hint">当前海域：未指定站点（可在地球视图选择站点进入）</p>
          )}
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
            <span><Wind size={12} />拖拽转视角 · WASD 移动 · Q 下潜 / E 上浮 · 穿越水面自动切换场景</span>
          </div>
          {/* 水质实时反馈(活跃污染越多越差) */}
          <div className="ocean3d-quality">
            <span>海域水质</span>
            <div className="ocean3d-quality-bar">
              <i style={{ width: `${waterQuality}%`, background: waterQuality > 70 ? '#54f1a9' : waterQuality > 45 ? '#ffbd66' : '#ff5f6e' }} />
            </div>
            <b style={{ color: waterQuality > 70 ? '#54f1a9' : waterQuality > 45 ? '#ffbd66' : '#ff5f6e' }}>{waterQuality}</b>
          </div>

          <h2 className="ocean3d-section">🧴 知识漂流瓶 · 边探索边收集</h2>
          <p className="ocean3d-hint">海面、水层与海底漂着 <b>{KNOWLEDGE_POIS.length}</b> 只知识瓶，靠近<b>点击</b>回答问题，答对点亮收集（进度自动保存）</p>
          <div className="ocean3d-quality">
            <span>收集进度</span>
            <div className="ocean3d-quality-bar">
              <i style={{ width: `${(collectedPois.length / KNOWLEDGE_POIS.length) * 100}%`, background: '#ffd76a' }} />
            </div>
            <b style={{ color: '#ffd76a' }}>{collectedPois.length}/{KNOWLEDGE_POIS.length}</b>
          </div>
          {collectedPois.length >= KNOWLEDGE_POIS.length && (
            <p className="ocean3d-poi-done">🎉 已集齐全部海洋知识徽章，你就是这片海域的守护者！</p>
          )}

          <div className="ocean3d-siminfo">
            <button className="ocean3d-sync" onClick={() => { setVoiceOn((v) => !v); stopSpeaking(); }} title="语音播报与音效开关（关闭时立即停止当前播报）">
              {voiceOn ? <Volume2 size={13} /> : <VolumeX size={13} />}{voiceOn ? '语音播报：开' : '语音播报：关'}
            </button>
          </div>
          <p className="ocean3d-disclaimer"><Info size={12} />危害链与数据来自项目海洋知识库；降解年限为量级估计</p>
        </aside>
      )}
      {/* 污染聚合: 跟在科普面板下方(纵向流式), 替代旧的浮动叠加卡 */}
      <button className={`ocean3d-pollution-toggle glass${pollutionOpen ? ' open' : ''}`} aria-expanded={pollutionOpen}
        onClick={() => setPollutionOpen((o) => !o)}>
        <Trash2 size={14} />污染提示{pollutions.length > 0 ? ` · ${pollutions.length}` : ''}
      </button>
      {visiblePanels.pollution && pollutionOpen && (
        <PollutionPanel
          items={pollutions}
          onClearOne={(key) => { worldRef.current?.removeStoryByKey(key); }}
          onClose={() => setPollutionOpen(false)}
        />
      )}
        </div>
      )}

      {/* 站点详情卡（点击浮标） */}
      {visiblePanels.detail && siteDetail && (
        <div className="ocean3d-card glass">
          <button className="ocean3d-close" aria-label="关闭" onClick={() => setSiteDetail(null)}><X size={15} /></button>
          <h3><span className="dot" style={{ background: QUALITY_COLOR(qualityOf(siteDetail)) }} />{siteDetail.code} · {siteDetail.name}</h3>
          <div className="ocean3d-kv">
            <span>环境质量评分</span><b style={{ color: QUALITY_COLOR(qualityOf(siteDetail)) }}>{qualityOf(siteDetail) == null ? '未检测 · 识别后生成（1-10分）' : `${qualityOf(siteDetail)} / 10（${QUALITY_TEXT(qualityOf(siteDetail))}）`}</b>
            <span>检测任务</span><b>{siteDetail.taskCount} 次</b>
            <span>累计检出</span><b>{siteDetail.totalObjects} 件垃圾</b>
            <span>最近任务</span><b>{(siteDetail as SiteStat).lastTaskAt ?? '—'}</b>
          </div>
          {(siteDetail as SiteStat).evidence && (siteDetail as SiteStat).evidence!.length > 0 && (
            <div className="ocean3d-evidence">
              <span>本站检测历史（图片点击放大，视频点击播放识别结果）</span>
              <div>
                {(siteDetail as SiteStat).evidence!.slice(0, 6).map((e) => {
                  const isVideo = e.mediaKind === 'video' || e.videoUrl != null;
                  const openUrl = isVideo ? (e.videoUrl ?? e.mediaUrl) : e.mediaUrl;
                  return (
                    <figure key={`${e.taskId}-${isVideo ? 'v' : 'i'}`}>
                      {e.mediaUrl ? (
                        <button className="ocean3d-evidence-media" aria-label={isVideo ? `播放任务${e.taskId}识别视频` : `查看任务${e.taskId}标注大图`}
                          onClick={() => { if (openUrl) setLightbox(openUrl); }}>
                          <img src={e.mediaUrl} alt={isVideo ? `任务${e.taskId}视频封面` : `任务${e.taskId}标注图`} loading="lazy" />
                          {isVideo && <span className="ocean3d-evidence-play"><Play size={12} />视频</span>}
                        </button>
                      ) : isVideo && e.videoUrl ? (
                        <button className="ocean3d-evidence-media ocean3d-evidence-novideo" aria-label={`播放任务${e.taskId}识别视频`}
                          onClick={() => setLightbox(e.videoUrl!)}>
                          <Play size={16} />播放识别视频
                        </button>
                      ) : <i className="noimg">无图</i>}
                      <figcaption>
                        #{e.taskId} · {isVideo ? '视频检测' : (e.className ?? '—')} ×{e.objectCount} · {e.level ?? '—'}<br />{e.at ?? ''}
                        {e.taskId > 0 && (
                          <button className="ocean3d-report-link" disabled={reportBusy === e.taskId}
                            onClick={() => {
                              setReportBusy(e.taskId);
                              api.createReport(String(e.taskId))
                                .then(() => { window.location.hash = 'reports'; })
                                .catch(() => undefined)
                                .finally(() => setReportBusy(null));
                            }}>
                            <FileText size={11} />{reportBusy === e.taskId ? '生成中…' : '生成报告'}
                          </button>
                        )}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </div>
          )}
          {mode === 'monitor' && (
            <div className="ocean3d-actions">
              <button className="primary-button" onClick={() => runSim(siteDetail.id)}><Crosshair size={13} />从此站点扩散推演</button>
              <button className="secondary-button" onClick={() => { window.location.hash = 'history'; }}>
                <FileText size={13} />检测历史
              </button>
            </div>
          )}

        </div>
      )}
      {/* 大图/识别视频查看器 */}
      {lightbox && (
        <div className="ocean3d-lightbox" onClick={() => setLightbox(null)}>
          {/\.(mp4|webm|mov)(\?|$)/i.test(lightbox)
            ? <video src={lightbox} controls autoPlay onClick={(e) => e.stopPropagation()} style={{ maxWidth: '86vw', maxHeight: '82vh', borderRadius: 10 }} />
            : <img src={lightbox} alt="检测标注大图" />}
          <button className="ocean3d-close" aria-label="关闭" onClick={() => setLightbox(null)}><X size={16} /></button>
        </div>
      )}

      {/* 跨海域跃迁提示 */}
      {jumpToast && <div className="ocean3d-jump-toast glass" role="status">{jumpToast}</div>}

      {/* 知识漂流瓶问答弹窗 */}
      {quiz && (
        <div className="ocean3d-quiz" role="dialog" aria-modal="true" aria-label={`知识问答 ${quiz.title}`}
          onKeyDown={(e) => { if (e.key === 'Escape') { setQuiz(null); setQuizWrong(null); } }}>
          <div className="ocean3d-quiz-card glass">
            <button className="ocean3d-close" aria-label="关闭" onClick={() => { setQuiz(null); setQuizWrong(null); }}><X size={15} /></button>
            <header className="ocean3d-quiz-head"><span className="poi-dot" />知识漂流瓶 · {quiz.zone}</header>
            <h3>{quiz.title}</h3>
            <p className="ocean3d-quiz-q">{quiz.question}</p>
            <div className="ocean3d-quiz-options">
              {quiz.options.map((opt, i) => (
                <button key={i}
                  className={quizWrong === i ? 'wrong' : quizSolved && i === quiz.answer ? 'right' : ''}
                  disabled={quizSolved && i !== quiz.answer}
                  onClick={() => answerQuiz(i)}>
                  {opt}
                </button>
              ))}
            </div>
            {quizWrong != null && !quizSolved && <p className="quiz-hint">不对哦，再想想～</p>}
            {quizSolved && (
              <p className="quiz-explain">✅ {quiz.explain}<small>来源：项目知识库《{quiz.source}》</small></p>
            )}
            <div className="ocean3d-actions">
              {quizSolved
                ? <button className="primary-button" onClick={() => { setQuiz(null); setQuizWrong(null); }}>知道了</button>
                : <button className="secondary-button" onClick={() => { setQuiz(null); setQuizWrong(null); }}>先不答</button>}
            </div>
          </div>
        </div>
      )}

      {/* 时间加速叙事HUD（科普模式投放后） */}
      {visiblePanels.story && story?.active && (
        <div className="ocean3d-story glass">
          <button className="ocean3d-panel-close" aria-label="关闭时间叙事" onClick={() => togglePanel('story')}><X size={13} /></button>
          <div className="ocean3d-story-time">
            <span className="live-dot" />
            <b>{formatStoryYear(story.year)}</b>
            <em>时间加速中 ×10⁵</em>
          </div>
          <p>{story.stageLabel}</p>
          <div className="ocean3d-story-stages">
            {[0, 1, 2, 3].map((i) => <i key={i} className={story.stage >= i ? 'on' : ''} />)}
          </div>
          {story.stage >= 2 && story.degradationYears > 0 && (
            <small>距完全降解还需约 <b>{Math.max(0, story.degradationYears - Math.floor(story.year))} 年</b></small>
          )}
        </div>
      )}

      {/* 数字人导游(科普模式, 未配置数字人时降级语音模式) */}
      {visiblePanels.guide && mode === 'volunteer' && (guideOpen
        ? <GuideDock voiceOn={voiceOn} onClose={() => setGuideOpen(false)} />
        : (
          <button className="ocean3d-guide-reopen glass" onClick={() => setGuideOpen(true)}>
            <Volume2 size={13} />数字人导游
          </button>
        ))}

      </>)}
    </div>
  );
}

/** 污染聚合面板: 右侧固定面板按类型汇总活跃污染(替代会互相重叠的浮动卡),
 *  点击类型行展开该类危害链与清除操作 */
function PollutionPanel({ items, onClearOne, onClose }: {
  items: Array<{ info: GarbageImpact; count: number }>;
  onClearOne: (key: string) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return (
    <aside className="ocean3d-pollution glass" aria-label="污染警示">
      <h2><Trash2 size={14} />污染警示 · {total} 处 <button className="ocean3d-panel-close" aria-label="关闭污染提示" onClick={onClose}><X size={13} /></button></h2>
      <ul>
        {items.map(({ info, count }) => (
          <li key={info.key}>
            <button
              className="pollution-row"
              aria-expanded={expanded === info.key}
              onClick={() => setExpanded(expanded === info.key ? null : info.key)}>
              <span className="dot" style={{ background: info.color }} />
              <span className="name">{info.name}{count > 1 && <b> ×{count}</b>}</span>
              <span className="years" title="量级估计降解年限">{info.degradeYears}年</span>
            </button>
            {expanded === info.key && (
              <div className="pollution-detail">
                <ol className="ocean3d-chain">
                  {info.chain.map((step, i) => <li key={i} style={{ animationDelay: `${i * 0.2}s` }}>{step}</li>)}
                </ol>
                <p className="ocean3d-stat">{info.stat}</p>
                <button className="secondary-button" onClick={() => onClearOne(info.key)}>
                  <Trash2 size={12} />清除一处
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="ocean3d-disclaimer"><Info size={12} />点击类型展开危害链 · 数据来自项目海洋知识库</p>
    </aside>
  );
}
