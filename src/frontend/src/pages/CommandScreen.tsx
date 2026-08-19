import { useEffect, useMemo, useState } from 'react';
import type { EChartsCoreOption as EChartsOption } from 'echarts/core';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Clock3,
  Compass,
  Maximize,
  Radio,
  ScanLine,
  ShieldCheck,
  Waves,
} from 'lucide-react';
import { OceanChart, RankingChart, TrendChart } from '../components/Charts';
import { mockRecords, mockTrend } from '../data/mock';
import { HaitongLogo } from '../components/HaitongLogo';

export function CommandScreen({ onExit }: { onExit: () => void }) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setTime(new Date());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

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

  const alertOption = useMemo<EChartsOption>(
    () => ({
      grid: { left: 8, right: 8, top: 10, bottom: 5, containLabel: true },
      xAxis: {
        type: 'category',
        data: ['塑料', '渔网', '金属', '玻璃', '织物'],
        axisLabel: { color: 'rgba(207,232,244,.56)' },
        axisLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: 'rgba(207,232,244,.5)' },
        splitLine: { lineStyle: { color: 'rgba(94,214,255,.08)' } },
      },
      series: [
        {
          type: 'bar',
          data: [48, 22, 15, 9, 6],
          barWidth: 16,
          itemStyle: { color: '#38ddff', borderRadius: [4, 4, 0, 0] },
        },
      ],
    }),
    [],
  );

  const enterFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  return (
    <div className="command-screen">
      <div className="screen-grid-bg" />

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
              <strong className="telem-val">42ms · 实时</strong>
            </div>
          </div>

          <div className="command-clock-card">
            <Clock3 size={15} />
            <time className="command-time-display">
              <span className="time-date">{time.toLocaleDateString('zh-CN')}</span>
              <span className="time-hour">
                {time.toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
            </time>
          </div>

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
            <span>今日检测任务</span>
            <strong>286</strong>
          </div>
          <em>+12.6%</em>
        </article>
        <article>
          <Radio />
          <div>
            <span>在线监测点</span>
            <strong>
              28<small>/28</small>
            </strong>
          </div>
          <em>全部在线</em>
        </article>
        <article>
          <Waves />
          <div>
            <span>累计识别目标</span>
            <strong>487,392</strong>
          </div>
          <em>+1,284</em>
        </article>
        <article className="danger">
          <AlertTriangle />
          <div>
            <span>当前污染预警</span>
            <strong>03</strong>
          </div>
          <em>1 条严重</em>
        </article>
      </section>

      {/* ====== 主体数据可视化网格 ====== */}
      <main>
        <div className="screen-column left">
          <article>
            <h2>
              <span>01</span>垃圾类型分布
            </h2>
            <RankingChart />
          </article>
          <article>
            <h2>
              <span>02</span>材质构成占比
            </h2>
            <OceanChart option={alertOption} />
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
                <i />在线点位 28
              </span>
              <span>覆盖 126.8 km²</span>
              <span>数据延迟 42 ms</span>
            </div>
          </article>
          <article className="screen-trend">
            <h2>
              <span>03</span>近 30 日污染变化趋势
            </h2>
            <TrendChart data={mockTrend} />
          </article>
        </div>

        <div className="screen-column right">
          <article>
            <h2>
              <span>04</span>环境质量总览
            </h2>
            <div className="screen-quality">
              <div>
                <strong>72</strong>
                <span>综合质量分</span>
              </div>
              <p>
                <ShieldCheck />整体处于可控水平
              </p>
              <dl>
                <div>
                  <dt>优良点位</dt>
                  <dd>21</dd>
                </div>
                <div>
                  <dt>关注点位</dt>
                  <dd>4</dd>
                </div>
                <div>
                  <dt>高风险点位</dt>
                  <dd>3</dd>
                </div>
              </dl>
            </div>
          </article>
          <article className="screen-alerts">
            <h2>
              <span>05</span>实时预警信息
            </h2>
            {mockRecords.slice(0, 4).map((record) => (
              <div key={record.id}>
                <i className={`level-${record.level}`} />
                <section>
                  <strong>{record.location}</strong>
                  <span>发现 {record.objectCount} 个垃圾目标</span>
                </section>
                <time>{record.createdAt.slice(11)}</time>
              </div>
            ))}
          </article>
        </div>
      </main>

      {/* ====== 底部信息栏 ====== */}
      <footer>
        <span>
          <i />数据实时更新中 · 下次刷新 00:24
        </span>
        <p>海瞳 · HAITONG Ocean Intelligence System · 第 8 组</p>
        <span>模型 YOLO11 · 服务状态正常</span>
      </footer>
    </div>
  );
}
