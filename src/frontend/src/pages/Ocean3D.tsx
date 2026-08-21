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
import { Wind, Crosshair, FileText, Info, Pause, Play, Radar, Radio, RefreshCw, Sprout, Trash2, UploadCloud, Volume2, VolumeX, Waves, X } from 'lucide-react';
import { formatStoryYear } from '../three/story';
import type { GarbageStoryState } from '../three/story';
import { api, isMockMode } from '../services/api';
import type { MarineInfo, SiteStat, Summary } from '../types';
import { OceanWorld } from '../three/oceanWorld';
import type { SiteVisual } from '../three/oceanWorld';
import { simulate } from '../three/diffusion';
import type { DiffusionResult } from '../three/diffusion';
import { GARBAGE_IMPACTS, impactByKey } from '../three/impactData';
import type { GarbageImpact } from '../three/impactData';
import { KNOWLEDGE_POIS, loadPoiProgress, savePoiProgress } from '../data/knowledgePois';
import type { KnowledgePoi } from '../data/knowledgePois';
import { speakText, speakQueued, stopSpeaking } from '../services/speech';
import { flushDropsNow, hasGuideListener, onBroadcast, reportGarbageDrop } from '../services/broadcast';
import { playAlertSound, playChime, playSplashSound } from '../services/sfx';
import { GuideDock } from '../components/GuideDock';
import type { TimeMode, WeatherMode } from '../three/weather';

type Mode = 'monitor' | 'volunteer';

const LEVEL_COLOR = (index: number | null): string =>
  index == null ? '#2a7f9e' : index >= 7 ? '#ff5f6e' : index >= 5 ? '#ffbd66' : '#27dafa';
const LEVEL_TEXT = (index: number | null): string =>
  index == null ? '暂无数据' : index >= 7 ? '严重' : index >= 5 ? '中等' : '良好';
type GlobeStationView = {
  id: number;
  code: string;
  name: string;
  lat: number;
  lng: number;
  region: string;
  country: string;
  pollutionIndex: number | null;
};

const DEMO_GLOBE_STATIONS: GlobeStationView[] = [
  { id: 1, code: 'CN-01', name: '舟山近岸站', lat: 29.96, lng: 122.38, region: '东海 · 舟山', country: '中国', pollutionIndex: 3.4 },
  { id: 2, code: 'AU-02', name: '大堡礁站', lat: -16.9, lng: 145.8, region: '昆士兰外海', country: '澳大利亚', pollutionIndex: 2.6 },
  { id: 3, code: 'US-03', name: '蒙特雷湾站', lat: 36.62, lng: -121.9, region: '加州近岸', country: '美国', pollutionIndex: 5.9 },
];

const toGlobeStation = (site: SiteStat): GlobeStationView => ({
  id: site.id, code: site.code, name: site.name, lat: site.lat, lng: site.lng,
  region: '监测海域', country: '项目站点', pollutionIndex: site.pollutionIndex,
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

export function Ocean3DPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<OceanWorld | null>(null);
  const modeRef = useRef<Mode>('monitor');
  const garbageKeyRef = useRef('bag');
  const playTimerRef = useRef<number | null>(null);
  const [mode, setMode] = useState<Mode>('monitor');
  const [sites, setSites] = useState<SiteStat[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [siteDetail, setSiteDetail] = useState<SiteVisual | null>(null);
  const [impact, setImpact] = useState<GarbageImpact | null>(null);
  const [dropCount, setDropCount] = useState(0);
  const [story, setStory] = useState<GarbageStoryState | null>(null);
  const [garbageKey, setGarbageKey] = useState('bag');
  const [voiceOn, setVoiceOn] = useState(true);
  const [waterQuality, setWaterQuality] = useState(100);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState<number | null>(null);
  const voiceOnRef = useRef(true);
  useEffect(() => { voiceOnRef.current = voiceOn; }, [voiceOn]);

  // 污染聚合面板数据(由活跃垃圾轮询聚合, 替代旧的多张拖拽警示卡)
  const [pollutions, setPollutions] = useState<Array<{ info: GarbageImpact; count: number }>>([]);

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
  // 实时检测联动
  const [live, setLive] = useState<LiveState | null>(null);
  const [liveSiteId, setLiveSiteId] = useState<number | null>(null);
  const livePollRef = useRef<number | null>(null);
  const liveUrlsRef = useRef<string[]>([]);

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
    (window as unknown as Record<string, unknown>).__oceanWorld = world;
    world.setKnowledgePOIs(KNOWLEDGE_POIS, loadPoiProgress());
    world.showGlobe(buildGlobeStations([]));
    setGlobeMode(true);
    api.getSummary().then(setSummary).catch(() => { /* KPI条失败不阻塞场景 */ });
    api.getSiteStats().then((list) => {
      setSites(list);
      try { world.setSites(list); } catch (err) { (window as unknown as Record<string, unknown>).__ocean3dError = String(err); }
      if (globeActiveRef.current) world.showGlobe(buildGlobeStations(list));
    }).catch(() => { if (globeActiveRef.current) world.showGlobe(buildGlobeStations([])); });
    api.getMarine().then(setMarine).catch(() => setMarine(null));
    return () => {
      if (playTimerRef.current) window.clearInterval(playTimerRef.current);
      if (livePollRef.current) { window.clearInterval(livePollRef.current); window.clearTimeout(livePollRef.current); }
      for (const url of liveUrlsRef.current) URL.revokeObjectURL(url);
      liveUrlsRef.current = [];
      stopSpeaking();
      flushDropsNow();
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
    if (mode !== 'volunteer') { setStory(null); setWaterQuality(100); return; }
    const timer = window.setInterval(() => {
      setStory(worldRef.current?.getGarbageStoryState() ?? null);
      const active = worldRef.current?.getActiveGarbage() ?? [];
      setWaterQuality(Math.max(28, 100 - active.length * 9));
      const byKey = new Map<string, number>();
      for (const item of active) byKey.set(item.key, (byKey.get(item.key) ?? 0) + 1);
      setPollutions(
        Array.from(byKey.entries())
          .map(([key, count]) => ({ info: impactByKey(key), count }))
          .filter((p): p is { info: GarbageImpact; count: number } => p.info != null),
      );
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
      setSites(list);
      try { world.setSites(list); } catch { /* 场景未就绪时忽略 */ }
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
        if (s.pollutionIndex != null && s.pollutionIndex >= 7 && now - (lastAlertRef.current[s.id] ?? 0) > 300000) {
          lastAlertRef.current[s.id] = now;
          world.triggerAlert(s.id);
          playAlertSound();
          if (voiceOnRef.current) {
            speakText(`告警：${s.name}污染指数${s.pollutionIndex.toFixed(1)}，达到严重等级`, { force: true });
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

  useEffect(() => () => { if (playTimerRef.current) window.clearInterval(playTimerRef.current); }, []);

  // ---------- 实时检测联动(上传影像 → 3D场景实时呈现) ----------

  /** 清除联动: 停轮询/回收预览URL/移除3D叠加层 */
  const clearLive = () => {
    if (livePollRef.current) {
      window.clearInterval(livePollRef.current);
      window.clearTimeout(livePollRef.current);
      livePollRef.current = null;
    }
    for (const url of liveUrlsRef.current) URL.revokeObjectURL(url);
    liveUrlsRef.current = [];
    worldRef.current?.clearLiveTask();
    setLive(null);
  };

  /** Mock模式: 客户端模拟一次完整联动(无后端也能演示全流程) */
  const runMockLive = (siteId: number, siteCode: string) => {
    const world = worldRef.current;
    if (!world) return;
    world.startLiveTask(siteId, siteCode);
    world.focusSite(siteId);
    setLive({ phase: 'processing', kind: 'mock', siteId, progress: 0, totalObjects: 0 });
    let progress = 0;
    let objects = 0;
    const timer = window.setInterval(() => {
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
    setLive({ phase: 'uploading', kind: 'video', siteId, progress: 0, totalObjects: 0 });
    try {
      const { taskId } = await api.createVideoTask(file, siteId);
      world.startLiveTask(siteId, siteCode);
      world.focusSite(siteId);
      setLive({ phase: 'processing', kind: 'video', siteId, progress: 0, totalObjects: 0 });
      const poll = async (): Promise<void> => {
        const st = await api.getVideoStatus(taskId);
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
            world.feedLiveTaskTargets(res.results.slice(0, 48).map((r) => ({ name: r.className, confidence: r.confidence })));
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
      world.finishLiveTask('任务失败');
      setLive((l) => (l ? { ...l, phase: 'error', error: reason instanceof Error ? reason.message : '任务创建失败' } : l));
    }
  };

  /** 图片联动: 批量识别, 本地预览图+检测框上屏, 汇总目标标定 */
  const runLiveImages = async (files: File[], siteId: number, siteCode: string) => {
    const world = worldRef.current;
    if (!world) return;
    const urls = files.map((f) => URL.createObjectURL(f));
    liveUrlsRef.current = urls;
    setLive({ phase: 'processing', kind: 'image', siteId, progress: 3, totalObjects: 0 });
    world.startLiveTask(siteId, siteCode);
    world.focusSite(siteId);
    world.showLiveTaskFrame(urls[0]);
    try {
      const res = await api.detectImages(files, (current, total) => {
        const progress = Math.min(95, Math.round((current / total) * 92) + 3);
        world.updateLiveTaskProgress({ progress, totalObjects: 0, processedFrames: current, totalFrames: total });
        const url = urls[current - 1];
        if (url) world.showLiveTaskFrame(url);
        setLive((l) => (l ? { ...l, progress } : l));
      }, siteId);
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
      world.finishLiveTask('任务失败');
      setLive((l) => (l ? { ...l, phase: 'error', error: reason instanceof Error ? reason.message : '识别任务失败，请重试' } : l));
    }
  };

  const onLiveFile = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0 || !worldRef.current) return;
    const siteId = liveSiteId ?? sites[0]?.id ?? 1;
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

  const firstSiteId = sites[0]?.id;
  const liveSiteValue = liveSiteId ?? firstSiteId ?? 1;
  const liveBusy = live?.phase === 'uploading' || live?.phase === 'processing';
  const quizSolved = quiz != null && collectedPois.includes(quiz.id);

  return (
    <div className={`ocean3d-page ${globeActive ? 'globe-mode' : ''}`}>
      <div ref={containerRef} className="ocean3d-canvas" />
      {globeActive && (
        <aside className="ocean3d-globe-sites glass" aria-label="全球监测站点">
          <div className="globe-sites-heading"><span className="globe-eyebrow">GLOBAL OCEAN NETWORK</span><h2>监测站点</h2><p>选择站点，地球将自动定位并进入海面环境</p></div>
          <div className="globe-site-list">
            {buildGlobeStations(sites).map((station) => (
              <button key={station.id} className={activeStation === station.id ? 'active' : ''} onClick={() => { setActiveStation(station.id); worldRef.current?.travelGlobeToSite(station.id); }}>
                <span className="globe-site-status" style={{ background: LEVEL_COLOR(station.pollutionIndex) }} />
                <span className="globe-site-copy"><b>{station.code} · {station.name}</b><small>{station.country} · {station.region}</small></span>
                <span className="globe-site-risk">{LEVEL_TEXT(station.pollutionIndex)}</span>
              </button>
            ))}
          </div>
        </aside>
      )}
      {!globeActive && (<>
      {/* 顶部: 标题 + 模式切换 */}
      <header className="ocean3d-topbar glass">
        <div>
          <span className="eyebrow"><i /> OCEAN DIGITAL TWIN</span>
          <h1>海洋 3D 态势</h1>
        </div>
        <div className="ocean3d-topbar-actions">
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
            <button className={mode === 'monitor' ? 'active' : ''} onClick={() => setMode('monitor')} role="tab" aria-selected={mode === 'monitor'}>
              <Radar size={15} />监测模式
            </button>
            <button className={mode === 'volunteer' ? 'active' : ''} onClick={() => setMode('volunteer')} role="tab" aria-selected={mode === 'volunteer'}>
              <Sprout size={15} />科普模式
            </button>
          </div>
        </div>
      </header>

      {/* 污染聚合面板(右侧, 替代旧的浮动叠加卡: 按类型聚合计数, 点击展开危害链) */}
      {mode === 'volunteer' && (
        <PollutionPanel items={pollutions}
          onClearOne={(key) => { worldRef.current?.removeStoryByKey(key); }} />
      )}

      {/* 全局KPI实数条（系统真实统计, 3D场景与项目业务接轨的门面） */}
      {summary && (
        <div className="ocean3d-kpis">
          <div className="glass"><b>{summary.totalTasks}</b><span>累计任务</span></div>
          <div className="glass"><b>{summary.totalObjects}</b><span>检出目标</span></div>
          <div className="glass"><b>{summary.seaAreas}</b><span>监测海域</span></div>
          <div className="glass"><b>{summary.activeAlerts}</b><span>污染告警</span></div>
        </div>
      )}

      {/* 监测模式: 站点面板 + 实时联动 + 海况 + 扩散推演控制 */}
      {mode === 'monitor' && (
        <aside className="ocean3d-panel glass">
          <h2><Waves size={15} />监测站点 · 实时数据
            <button className="ocean3d-sync" disabled={syncBusy} title="同步最新检测数据(上传识别后点击或等待45s自动同步)" onClick={() => syncSites(true)}>
              <RefreshCw size={13} className={syncBusy ? 'spin' : undefined} />{syncBusy ? '同步中…' : syncAt ? `同步 ${syncAt}` : '同步检测'}
            </button>
          </h2>
          <ul className="ocean3d-sites">
            {sites.length === 0 && <li className="ocean3d-empty">{isMockMode() ? 'Mock 模式：站点数据不加载' : '站点数据加载中或暂无站点…'}</li>}
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

          <h2 className="ocean3d-section"><Radio size={15} />实时检测联动</h2>
          <p className="ocean3d-hint">上传水下影像，任务<b>实时驱动本场景</b>：任务ROV出发巡检、标注帧同步上屏、检出目标逐个标定，完成后站点指数自动刷新{isMockMode() ? '（Mock 模式将模拟全流程）' : ''}</p>
          <div className="ocean3d-live">
            <label className="ocean3d-live-site">联动站点
              <select value={liveSiteValue} disabled={liveBusy}
                onChange={(e) => { setLiveSiteId(Number(e.target.value)); setWindApplied(false); }}>
                {sites.length === 0 && <option value={1}>演示站点（模拟）</option>}
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} · {s.name.replace('监测点', '')}</option>
                ))}
              </select>
            </label>
            <label className={`ocean3d-live-upload${liveBusy ? ' busy' : ''}${live?.phase === 'done' ? ' done' : ''}`}>
              <input type="file" multiple accept={LIVE_IMAGE_TYPES.concat(LIVE_VIDEO_TYPES).join(',')}
                onChange={onLiveFile} disabled={liveBusy} aria-label="上传影像开始实时联动" />
              <UploadCloud size={14} />{liveBusy ? '检测进行中…' : live?.phase === 'done' ? '再传一次' : '上传影像 · 开始联动'}
            </label>
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
                {live.phase === 'done' && live.summary && <p className="ok">{live.summary} · 已同步站点数据</p>}
                {live.phase === 'error' && <p className="err">{live.error ?? '未知错误'}</p>}
              </div>
            )}
          </div>

          <h2 className="ocean3d-section"><Wind size={15} />真实海况 · 舟山海域</h2>
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

      {/* 科普模式: 垃圾选择 + 知识收集 + 投放引导 */}
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
            <span><Wind size={12} />拖拽转视角 · WASD 移动 · Q 下潜\/E 上浮 · 穿越水面自动切换场景</span>
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
            <button className="ocean3d-sync" onClick={() => setVoiceOn((v) => !v)} title="语音播报与音效开关">
              {voiceOn ? <Volume2 size={13} /> : <VolumeX size={13} />}{voiceOn ? '语音播报：开' : '语音播报：关'}
            </button>
          </div>
          <p className="ocean3d-disclaimer"><Info size={12} />危害链与数据来自项目海洋知识库；降解年限为量级估计</p>
        </aside>
      )}

      {/* 站点详情卡（点击浮标） */}
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
          {(siteDetail as SiteStat).evidence && (siteDetail as SiteStat).evidence!.length > 0 && (
            <div className="ocean3d-evidence">
              <span>本站检测证据（点击图片查看大图）</span>
              <div>
                {(siteDetail as SiteStat).evidence!.slice(0, 3).map((e) => (
                  <figure key={e.taskId}>
                    {e.mediaUrl
                      ? <img src={e.mediaUrl} alt={`任务${e.taskId}标注图`} loading="lazy" onClick={() => setLightbox(e.mediaUrl)} style={{ cursor: 'zoom-in' }} />
                      : <i className="noimg">无图</i>}
                    <figcaption>
                      #{e.taskId} · {e.className ?? '—'} ×{e.objectCount} · {e.level ?? '—'}<br />{e.at ?? ''}
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
                ))}
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

      {/* 大图查看器 */}
      {lightbox && (
        <div className="ocean3d-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="检测标注大图" />
          <button className="ocean3d-close" aria-label="关闭"><X size={16} /></button>
        </div>
      )}

      {/* 知识漂流瓶问答弹窗 */}
      {quiz && (
        <div className="ocean3d-quiz" role="dialog" aria-modal="true" aria-label={`知识问答 ${quiz.title}`}>
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
      {story?.active && (
        <div className="ocean3d-story glass">
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
      {mode === 'volunteer' && (guideOpen
        ? <GuideDock voiceOn={voiceOn} onClose={() => setGuideOpen(false)} />
        : (
          <button className="ocean3d-guide-reopen glass" onClick={() => setGuideOpen(true)}>
            <Volume2 size={13} />数字人导游
          </button>
        ))}

      {/* 图例 */}
      <footer className="ocean3d-legend glass">
        <span><i style={{ background: '#27dafa' }} />污染良好</span>
        <span><i style={{ background: '#ffbd66' }} />污染中等</span>
        <span><i style={{ background: '#ff5f6e' }} />污染严重</span>
        <span><i style={{ background: '#54f1a9' }} />扩散粒子</span>
        {mode === 'volunteer' && <span><i style={{ background: '#ffd76a' }} />知识漂流瓶</span>}
      </footer>
      </>)}
    </div>
  );
}

/** 污染聚合面板: 右侧固定面板按类型汇总活跃污染(替代会互相重叠的浮动卡),
 *  点击类型行展开该类危害链与清除操作 */
function PollutionPanel({ items, onClearOne }: {
  items: Array<{ info: GarbageImpact; count: number }>;
  onClearOne: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return (
    <aside className="ocean3d-pollution glass" aria-label="污染警示">
      <h2><Trash2 size={14} />污染警示 · {total} 处</h2>
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
