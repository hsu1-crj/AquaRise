import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Clock3,
  Maximize,
  Radio,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Waves,
} from 'lucide-react';
import { MaterialChart, RankingChart, TrendChart } from '../components/Charts';
import { HaitongLogo } from '../components/HaitongLogo';
import { api } from '../services/api';
import type { DetectionRecord, StatsAnalysis, Summary, TrendPoint } from '../types';

const REFRESH_MS = 60_000;

/** 从后端时间串提取 HH:MM（兼容带秒/不带秒格式） */
function timeOf(value: string) {
  const match = value.match(/(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : value;
}

// 时钟独立成叶子组件：每秒更新只重渲染自己，避免整屏（含全局 ECharts）跟随重绘而闪烁
function CommandClock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setTime(new Date());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <time className="command-time-display">
      <span className="time-date">{time.toLocaleDateString('zh-CN')}</span>
      <span className="time-hour">
        {time.toLocaleTimeString('zh-CN', { hour12: false })}
      </span>
    </time>
  );
}

export function CommandScreen({ onExit }: { onExit: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [analysis, setAnalysis] = useState<StatsAnalysis | null>(null);
  const [records, setRecords] = useState<DetectionRecord[]>([]);

  const load = useCallback(async () => {
    setError('');
    try {
      const [summaryData, trendData, analysisData, history] = await Promise.all([
        api.getSummary(),
        api.getTrend('month'),
        api.getAnalysis(),
        api.getHistory(1, 4),
      ]);
      setSummary(summaryData);
      setTrend(trendData);
      setAnalysis(analysisData);
      setRecords(history.items);
      setLastUpdated(new Date());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 大屏数据自动刷新：页面隐藏时暂停（与工作台约定一致），离开页面时清理
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // 监听 ESC 快捷键平滑退出大屏
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onExit();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExit]);

  const enterFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  const fmt = (n?: number) => (n == null ? '—' : n.toLocaleString('zh-CN'));
  const growth = (n?: number) => (n == null ? '—' : `+${n}%`);
  const qualityBand = (index?: number) => {
    if (index == null) return '暂无评估数据';
    if (index >= 6) return '污染较重，需重点处置';
    if (index >= 4) return '需重点关注，建议加密监测';
    return '整体处于可控水平';
  };

  return (
    <div className="command-screen">
      <div className="screen-grid-bg" />

      {/* ====== 数据同步状态覆盖层（首次加载 / 失败重试） ====== */}
      {loading && (
        <div className="screen-state-overlay" role="status">
          <i className="loader-orbit" />
          <span>正在汇聚监测数据…</span>
        </div>
      )}
      {!loading && error && (
        <div className="screen-state-overlay error" role="alert">
          <AlertTriangle size={16} />
          <span>同步失败：{error}</span>
          <button onClick={() => void load()}>重试</button>
        </div>
      )}

      {/* ====== 顶部指挥舱 HUD 控制栏 ====== */}
      <header className="command-header-hud">
        {/* 左侧：高端赛博 HUD 返回按钮 */}
        <div className="command-header-left">
          <button
            className="command-back-hud-btn"
            onClick={onExit}
            title="点击或按 ESC 键返回主监控工作台"
          >
            <div className="back-btn-icon">
              <ArrowLeft size={16} />
            </div>
            <div className="back-btn-content">
              <span className="back-main-text">返回工作台</span>
              <span className="back-sub-text">EXIT TO PLATFORM</span>
            </div>
            <span className="back-key-chip">ESC</span>
          </button>
        </div>

        {/* 中间：旗舰海瞳指挥中心品牌标语 */}
        <div className="command-header-center">
          <div className="command-brand-emblem">
            <HaitongLogo size={24} />
          </div>
          <div className="command-title-group">
            <div className="command-title-row">
              <span className="command-live-pill">
                <i className="live-blink" /> LIVE HUD
              </span>
              <h1>海瞳 · 海域污染智能监测指挥中心</h1>
              <span className="command-region-tag">渤海湾全域网络</span>
            </div>
            <p>HAITONG · OCEAN POLLUTION INTELLIGENCE COMMAND</p>
          </div>
        </div>

        {/* 右侧：遥测时钟、网络状态与全屏控制器 */}
        <aside className="command-header-right">
          <div className="command-telem-item">
            <Activity size={13} className="telem-icon" />
            <div className="telem-data">
              <span className="telem-label">TELEMETRY</span>
              <strong className="telem-val">实时</strong>
            </div>
          </div>

          <div className="command-clock-card">
            <Clock3 size={15} />
            <CommandClock />
          </div>

          <button
            className="command-fullscreen-btn"
            onClick={() => void load()}
            title="手动刷新大屏数据"
            disabled={loading}
          >
            <RefreshCw size={14} />
            {loading ? '同步中' : '刷新'}
          </button>
          <button
            className="command-fullscreen-btn"
            onClick={enterFullscreen}
            title="切换大屏全屏显示"
          >
            <Maximize size={14} />
            <span>全屏</span>
          </button>
        </aside>
      </header>

      {/* ====== 核心态势 KPI 指标带 ====== */}
      <section className="screen-kpis">
        <article>
          <ScanLine />
          <div>
            <span>累计检测任务</span>
            <strong>{fmt(summary?.totalTasks)}</strong>
          </div>
          <em>较上月 {growth(summary?.monthlyGrowth)}</em>
        </article>
        <article>
          <Radio />
          <div>
            <span>在线监测点</span>
            <strong>
              {fmt(summary?.seaAreas)}
              <small>处</small>
            </strong>
          </div>
          <em>覆盖 {summary?.coverageKm2 != null ? `${summary.coverageKm2} km²` : '—'}</em>
        </article>
        <article>
          <Waves />
          <div>
            <span>累计识别目标</span>
            <strong>{fmt(summary?.totalObjects)}</strong>
          </div>
          <em>本月 {growth(summary?.monthlyGrowth)}</em>
        </article>
        <article className="danger">
          <AlertTriangle />
          <div>
            <span>当前污染预警</span>
            <strong>{fmt(summary?.activeAlerts)}</strong>
          </div>
          <em>{analysis?.severeCount ?? '—'} 个高风险</em>
        </article>
      </section>

      {/* ====== 主体数据可视化网格 ====== */}
      <main>
        <div className="screen-column left">
          <article>
            <h2>
              <span>01</span>垃圾类型分布
            </h2>
            <RankingChart ranking={analysis?.classRanking} />
          </article>
          <article>
            <h2>
              <span>02</span>材质构成占比
            </h2>
            <MaterialChart breakdown={analysis?.materialBreakdown} total={analysis?.totalObjects} />
          </article>
        </div>

        <div className="screen-center">
          <article className="screen-map">
            <h2>渤海近岸实时监测网络</h2>
            <div className="sonar-map large">
              <div className="sonar-rings">
                <i />
                <i />
                <i />
                <i />
              </div>
              <span className="coast coast-a">秦皇岛</span>
              <span className="coast coast-b">北戴河</span>
              <span className="coast coast-c">渤海湾</span>
              <button className="map-point point-a">
                <i />
                <b>A-07 · 严重</b>
              </button>
              <button className="map-point point-b">
                <i />
                <b>B-12</b>
              </button>
              <button className="map-point point-c">
                <i />
                <b>C-03</b>
              </button>
              <button className="map-point point-d">
                <i />
                <b>D-09</b>
              </button>
              <div className="map-sweep" />
            </div>
            <div className="screen-map-status">
              <span>
                <i />在线点位 {fmt(summary?.seaAreas)}
              </span>
              <span>覆盖 {summary?.coverageKm2 != null ? `${summary.coverageKm2} km²` : '—'}</span>
              <span>刷新于 {lastUpdated ? lastUpdated.toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</span>
            </div>
          </article>
          <article className="screen-trend">
            <h2>
              <span>03</span>近 30 日污染变化趋势
            </h2>
            <TrendChart data={trend} />
          </article>
        </div>

        <div className="screen-column right">
          <article>
            <h2>
              <span>04</span>环境质量总览
            </h2>
            <div className="screen-quality">
              <div>
                <strong>{analysis ? analysis.pollutionIndex.toFixed(1) : '—'}</strong>
                <span>综合污染指数 / 10</span>
              </div>
              <p>
                <ShieldCheck />{qualityBand(analysis?.pollutionIndex)}
              </p>
              <dl>
                <div>
                  <dt>近 30 天检出</dt>
                  <dd>{fmt(analysis?.totalObjects)}</dd>
                </div>
                <div>
                  <dt>塑料占比</dt>
                  <dd>{analysis ? `${analysis.plasticPercent.toFixed(1)}%` : '—'}</dd>
                </div>
                <div>
                  <dt>高风险任务</dt>
                  <dd>{fmt(analysis?.severeCount)}</dd>
                </div>
              </dl>
            </div>
          </article>
          <article className="screen-alerts">
            <h2>
              <span>05</span>实时预警信息
            </h2>
            {records.length === 0 ? (
              <div className="no-record">暂无最新监测任务</div>
            ) : (
              records.slice(0, 4).map((record) => (
                <div key={record.id}>
                  <i className={`level-${record.level}`} />
                  <section>
                    <strong>{record.location}</strong>
                    <span>发现 {record.objectCount} 个垃圾目标</span>
                  </section>
                  <time>{timeOf(record.createdAt)}</time>
                </div>
              ))
            )}
          </article>
        </div>
      </main>

      {/* ====== 底部信息栏 ====== */}
      <footer>
        <span>
          <i />数据实时更新中{lastUpdated ? ` · 刷新于 ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
        </span>
        <p>海瞳 · HAITONG Ocean Intelligence System · 第 8 组</p>
        <span>模型 YOLO11 · 服务状态正常</span>
      </footer>
    </div>
  );
}