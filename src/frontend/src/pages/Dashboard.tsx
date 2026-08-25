import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Camera, ChevronRight, CircleGauge, FileDown, MapPin, Radio, RefreshCw, ScanLine, ShipWheel, Sparkles, TrendingUp, Waves } from 'lucide-react';
import { MaterialChart, RankingChart, TrendChart } from '../components/Charts';
import { api } from '../services/api';
import type { DetectionRecord, PageKey, StatsAnalysis, Summary, TrendPoint, UserInfo } from '../types';

const beijingClock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// 按北京时间(Asia/Shanghai)返回问候语与当前时刻,不受用户本机时区影响
function beijingNow(date: Date) {
  const parts = beijingClock.formatToParts(date);
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = Number(value('hour'));
  const greeting = hour >= 5 && hour < 12 ? '早上好' : hour >= 12 && hour < 18 ? '下午好' : '晚上好';
  return { greeting, time: `${value('hour')}:${value('minute')}:${value('second')}` };
}

// 每秒/定时再渲染只发生在时钟自身这个最小叶子组件上,避免整个 Dashboard 及图表跟随重绘导致闪烁
function useBeijingNow(intervalMs: number) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return beijingNow(now);
}

function BeijingGreeting({ name = '林海' }: { name?: string }) {
  const { greeting } = useBeijingNow(60_000);
  return <>{greeting}，{name}。</>;
}

function SyncTime() {
  const { time } = useBeijingNow(1000);
  return <span className="sync-status"><i />实时同步 · {time}</span>;
}

export function Dashboard({ onNavigate, user }: { onNavigate: (page: PageKey) => void; user?: UserInfo | null }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [analysis, setAnalysis] = useState<StatsAnalysis | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<DetectionRecord[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [summaryData, trendData, analysisData, history] = await Promise.all([
        api.getSummary(),
        api.getTrend(),
        api.getAnalysis(),
        api.getHistory(1, 4),
      ]);
      setSummary(summaryData);
      setTrend(trendData);
      setAnalysis(analysisData);
      setRecords(history.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <PageState type="loading" />;
  if (error) return <PageState type="error" message={error} onRetry={load} />;
  if (!summary) return <PageState type="empty" />;
  const cards = [
    { label: '累计检测任务', value: summary.totalTasks.toLocaleString(), unit: '次', icon: ScanLine, color: 'cyan', detail: '较上月 +12.4%' },
    { label: '识别垃圾目标', value: summary.totalObjects.toLocaleString(), unit: '件', icon: Camera, color: 'violet', detail: `本月 +${summary.monthlyGrowth}%` },
    { label: '覆盖监测海域', value: summary.seaAreas, unit: '处', icon: MapPin, color: 'green', detail: `${summary.coverageKm2} km²` },
    { label: '待处置预警', value: summary.activeAlerts, unit: '条', icon: AlertTriangle, color: 'coral', detail: '1 条严重预警' },
  ];

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div><span className="eyebrow"><i /> OCEAN INTELLIGENCE</span><h1>海洋污染态势总览</h1><p><BeijingGreeting name={user?.username} />渤海近岸 28 个监测点正在持续回传环境数据。</p></div>
        <div className="heading-actions"><SyncTime /><button className="secondary-button" onClick={load}><RefreshCw size={16} />刷新</button><button className="primary-button" onClick={() => onNavigate('detection')}><ScanLine size={17} />开始识别</button></div>
      </section>

      <section className="metric-grid">
        {cards.map(({ label, value, unit, icon: Icon, color, detail }) => (
          <article className={`metric-card glass metric-${color}`} key={label}>
            <div className="metric-icon"><Icon size={22} /></div><span>{label}</span><strong>{value}<small>{unit}</small></strong><em><TrendingUp size={13} />{detail}</em><div className="metric-glow" />
          </article>
        ))}
      </section>

      <section className="dashboard-grid">
        <article className="panel glass trend-panel">
          <PanelTitle icon={Waves} title="污染变化趋势" subtitle="近 30 日垃圾数量与密度变化" action="查看分析" onAction={() => onNavigate('analysis')} />
          <TrendChart data={trend} />
        </article>
        <article className="panel glass map-panel">
          <PanelTitle icon={Radio} title="实时监测网络" subtitle="渤海近岸点位状态" action="指挥大屏" onAction={() => onNavigate('screen')} />
          <div className="sonar-map">
            <div className="sonar-rings"><i /><i /><i /></div>
            <span className="coast coast-a">秦皇岛</span><span className="coast coast-b">北戴河</span><span className="coast coast-c">渤海湾</span>
            <button className="map-point point-a" title="A-07 严重"><i /><b>A-07</b></button>
            <button className="map-point point-b" title="B-12 正常"><i /><b>B-12</b></button>
            <button className="map-point point-c" title="C-03 正常"><i /><b>C-03</b></button>
            <button className="map-point point-d" title="D-09 注意"><i /><b>D-09</b></button>
            <div className="map-sweep" />
          </div>
          <div className="map-legend"><span><i className="normal" />运行正常 25</span><span><i className="warning" />需要关注 2</span><span><i className="danger" />严重预警 1</span></div>
        </article>
      </section>

      <section className="dashboard-lower">
        <article className="panel glass"><PanelTitle icon={CircleGauge} title="材质构成" subtitle="近 30 日识别结果" /><MaterialChart breakdown={analysis?.materialBreakdown} total={analysis?.totalObjects} /></article>
        <article className="panel glass"><PanelTitle icon={Sparkles} title="高频垃圾类型" subtitle="目标数量 TOP 5" /><RankingChart ranking={analysis?.classRanking} /></article>
        <article className="panel glass records-panel">
          <PanelTitle icon={ShipWheel} title="最近检测" subtitle="最新完成任务" action="全部记录" onAction={() => onNavigate('history')} />
          <div className="record-list">
            {records.length === 0
              ? <div className="no-record">暂无检测记录</div>
              : records.slice(0, 4).map((record) => <button key={record.id} onClick={() => onNavigate('history')}><span className={`level-dot level-${record.level}`} /><div><strong>{record.location}</strong><small>{record.createdAt} · {record.type}</small></div><em>{record.objectCount} 件</em><ChevronRight size={15} /></button>)}
          </div>
        </article>
      </section>

      <section className="action-banner glass">
        <div className="banner-orb"><Waves /></div><div><span>AI 环境研判</span><h3>A-07 点位塑料垃圾密度连续 3 日上升</h3><p>建议创建专项检测任务，并生成区域质量评估报告。</p></div>
        <button className="ghost-button" onClick={() => onNavigate('reports')}><FileDown size={17} />查看报告</button><button className="primary-button" onClick={() => onNavigate('detection')}>发起复检<ArrowRight size={17} /></button>
      </section>
    </div>
  );
}

function PanelTitle({ icon: Icon, title, subtitle, action, onAction }: { icon: typeof Waves; title: string; subtitle: string; action?: string; onAction?: () => void }) {
  return <header className="panel-title"><div className="panel-title-icon"><Icon size={18} /></div><div><h2>{title}</h2><span>{subtitle}</span></div>{action && <button onClick={onAction}>{action}<ChevronRight size={14} /></button>}</header>;
}

function PageState({ type, message, onRetry }: { type: 'loading' | 'error' | 'empty'; message?: string; onRetry?: () => void }) {
  return <div className="page-state glass"><div className={type === 'loading' ? 'loader-orbit' : 'state-icon'}>{type === 'error' ? <AlertTriangle /> : type === 'empty' ? <Waves /> : <i />}</div><h2>{type === 'loading' ? '正在汇聚海域数据' : type === 'error' ? '数据暂时失联' : '暂无监测数据'}</h2><p>{message ?? (type === 'loading' ? '正在连接监测站与分析服务…' : '创建首个识别任务后，数据会显示在这里。')}</p>{type === 'error' && <button className="primary-button" onClick={onRetry}><RefreshCw size={16} />重新加载</button>}</div>;
}
