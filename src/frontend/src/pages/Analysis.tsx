import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, BrainCircuit, CalendarRange, Download, Info, Layers3, MapPinned, RefreshCw } from 'lucide-react';
import { MaterialChart, OceanChart, RankingChart, TrendChart } from '../components/Charts';
import { api } from '../services/api';
import { useSeaArea } from '../context/SeaAreaContext';
import type { EChartsCoreOption as EChartsOption } from 'echarts/core';
import type { SiteStat, StatsAnalysis, TrendPoint } from '../types';

export function AnalysisPage() {
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [analysis, setAnalysis] = useState<StatsAnalysis | null>(null);
  const [siteStats, setSiteStats] = useState<SiteStat[]>([]);
  const [period, setPeriod] = useState('month');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [adviceOpen, setAdviceOpen] = useState(false);
  // 侧边栏全局海域选择：趋势/聚合/KPI 随所选海域过滤；海域污染对比图保持全域对比
  const { seaAreaId, seaAreaName } = useSeaArea();

  useEffect(() => {
    setLoading(true);
    setLoadError(false);
    const areaFilter = seaAreaId === '' ? undefined : seaAreaId;
    Promise.all([api.getTrend(period, areaFilter), api.getAnalysis(areaFilter), api.getSiteStats()])
      .then(([trendData, analysisData, siteData]) => {
        setTrend(trendData);
        setAnalysis(analysisData);
        setSiteStats(siteData);
      })
      .catch(() => setLoadError(true)) // 失败保留旧数据；首次失败时图表区展示错误态而非编造数据
      .finally(() => setLoading(false));
  }, [period, refreshKey, seaAreaId]);
  const indexDelta = analysis && analysis.pollutionIndexPrev > 0
    ? ((analysis.pollutionIndex - analysis.pollutionIndexPrev) / analysis.pollutionIndexPrev) * 100
    : null;
  const plasticDelta = analysis && analysis.plasticPercentPrev > 0
    ? ((analysis.plasticPercent - analysis.plasticPercentPrev) / analysis.plasticPercentPrev) * 100
    : null;

  // 基于近 30 天检测聚合数据动态生成 AI 洞察与治理建议（数据未就绪时为 null）
  const insight = useMemo(() => (analysis ? buildInsight(analysis) : null), [analysis]);

  const exportCsv = () => {
    if (!analysis) return;
    const lines = ['指标,数值,说明'];
    lines.push(`综合污染指数,${analysis.pollutionIndex} / 10,${indexDelta != null ? `较上月 ${Math.abs(indexDelta).toFixed(1)}%` : '近 30 天'}`);
    lines.push(`塑料垃圾占比,${analysis.plasticPercent}%,${plasticDelta != null ? `较上月 ${Math.abs(plasticDelta).toFixed(1)}%` : '近 30 天'}`);
    lines.push(`高风险监测点,${analysis.highRiskAreas} 处,近 30 日综合污染指数 ≥ 6 的海域`);
    lines.push(`近 30 天检出垃圾,${analysis.totalObjects} 件,`);
    lines.push('');
    lines.push('材质构成,数量');
    Object.entries(analysis.materialBreakdown).forEach(([name, count]) => lines.push(`${name},${count}`));
    lines.push('');
    lines.push('高频垃圾类型,数量');
    analysis.classRanking.forEach((item) => lines.push(`${item.name},${item.count}`));
    const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'haitong-analysis.csv'; link.click(); URL.revokeObjectURL(link.href);
  };

  return <div className="page-stack"><section className="page-heading compact"><div><span className="eyebrow"><i /> ENVIRONMENT INSIGHTS</span><h1>海洋污染分析</h1><p>从趋势、材质和海域维度洞察污染变化，辅助治理决策。当前范围：{seaAreaName}</p></div><div className="heading-actions"><label className="period-select"><CalendarRange /><select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="week">近 7 天</option><option value="month">近 30 天</option><option value="year">近 12 月</option></select></label><button className="secondary-button" onClick={exportCsv} disabled={!analysis}><Download />导出分析</button></div></section><section className="insight-strip glass"><BrainCircuit /><div><span>AI 洞察</span>{insight ? <><strong>{insight.title}</strong><p>{insight.description}</p>{adviceOpen && insight.recommendations.length > 0 && <ul className="insight-advice">{insight.recommendations.map((item) => <li key={item}>{item}</li>)}</ul>}</> : loadError ? <p>数据加载失败，请点击「污染趋势」面板右上角刷新按钮重试。</p> : <p>正在基于检测数据生成洞察…</p>}</div><button onClick={() => setAdviceOpen((open) => !open)} aria-expanded={adviceOpen} disabled={!insight || insight.recommendations.length === 0}>{adviceOpen ? '收起建议' : '查看治理建议'}</button></section><section className="analysis-kpis"><article className="panel glass"><span>综合污染指数<Info /></span><strong>{analysis?.pollutionIndex.toFixed(1) ?? '—'}<small>/ 10</small></strong>{indexDelta == null ? <em className="neutral">基于近 30 天</em> : <em className={indexDelta < 0 ? 'down' : 'up'}>{indexDelta < 0 ? <ArrowDownRight /> : <ArrowUpRight />}较上月 {Math.abs(indexDelta).toFixed(1)}%</em>}</article><article className="panel glass"><span>塑料垃圾占比<Layers3 /></span><strong>{analysis?.plasticPercent.toFixed(1) ?? '—'}<small>%</small></strong>{plasticDelta == null ? <em className="neutral">基于近 30 天</em> : <em className={plasticDelta > 0 ? 'up' : 'down'}>{plasticDelta > 0 ? <ArrowUpRight /> : <ArrowDownRight />}较上月 {Math.abs(plasticDelta).toFixed(1)}%</em>}</article><article className="panel glass"><span>高风险监测点<MapPinned /></span><strong>{analysis?.highRiskAreas ?? '—'}<small>处</small></strong><em className="neutral">近 30 日污染指数 ≥ 6 的海域</em></article><article className="panel glass"><span>近 30 天检出垃圾<Activity /></span><strong>{analysis?.totalObjects ?? '—'}<small>件</small></strong><em className="neutral">近 30 天累计检出目标</em></article></section><section className="analysis-grid"><article className="panel glass analysis-trend"><header className="panel-simple-title"><div><h2>污染趋势与密度变化</h2><span>目标数量 / 单位面积垃圾密度</span></div><button onClick={() => setRefreshKey((k) => k + 1)} title="重新拉取数据"><RefreshCw /></button></header>{loading ? <div className="chart-loading"><i className="loader-orbit" />数据计算中…</div> : <TrendChart data={trend} />}</article><article className="panel glass"><header className="panel-simple-title"><div><h2>垃圾材质构成</h2><span>各材质目标占比</span></div></header>{loadError && !analysis ? <div className="chart-empty">数据加载失败<br /><small>请点击「污染趋势」面板右上角刷新按钮重试</small></div> : <MaterialChart breakdown={analysis?.materialBreakdown} total={analysis?.totalObjects} />}</article><article className="panel glass"><header className="panel-simple-title"><div><h2>海域污染对比</h2><span>各海域环境质量评分 / 10</span></div></header><SiteComparisonChart sites={siteStats} loading={loading} /></article><article className="panel glass"><header className="panel-simple-title"><div><h2>高频目标排名</h2><span>近 30 日识别总量</span></div></header>{loadError && !analysis ? <div className="chart-empty">数据加载失败<br /><small>请点击「污染趋势」面板右上角刷新按钮重试</small></div> : <RankingChart ranking={analysis?.classRanking} />}</article></section></div>;
}
/** 由近 30 天聚合统计动态生成 AI 洞察与治理建议（无真实数据时回退为中性提示） */
function buildInsight(a: StatsAnalysis) {
  const top = a.classRanking[0];
  const topShare = a.totalObjects > 0 && top ? Math.round((top.count / a.totalObjects) * 100) : 0;
  const delta = a.pollutionIndexPrev > 0 ? a.pollutionIndex - a.pollutionIndexPrev : null;
  const rising = delta != null && delta > 0.4;
  const falling = delta != null && delta < -0.4;

  const trendText = delta == null ? '基于近 30 天检测数据' : rising ? '污染指数较上期上升' : falling ? '污染指数较上期下降' : '污染指数较上期持平';
  const title = `综合污染指数 ${a.pollutionIndex.toFixed(1)}/10 · ${trendText}`;

  const descParts: string[] = [];
  if (top) descParts.push(`最高频目标为「${top.name}」，近 30 天检出 ${top.count} 件（占 ${topShare}%）`);
  if (a.totalObjects > 0) descParts.push(`共检出 ${a.totalObjects} 件`);
  if (a.severeCount > 0) descParts.push(`${a.severeCount} 个任务达到严重污染`);
  const description = descParts.length ? `${descParts.join('；')}。` : '近 30 天暂无已完成检测任务，洞察待数据积累后生成。';

  const recs: string[] = [];
  if (a.severeCount > 0) recs.push(`优先安排 ${a.severeCount} 个高风险点位的现场复核与清理，72 小时内完成并记录治理前后对比数据。`);
  if (top && topShare >= 15) recs.push(`针对「${top.name}」开展专项清理与源头排查，该类约占检出目标的 ${topShare}%。`);
  if (a.plasticPercent > 0) recs.push(`塑料类目标占比 ${a.plasticPercent}%，建议增设海漂塑料拦截设施并加强沿岸协同回收。`);
  if (falling) recs.push('污染指数环比下降，保持现有监测频次并固化有效治理措施，持续验证整治效果。');
  if (!recs.length && (a.pollutionIndex > 0 || a.totalObjects > 0)) recs.push('建议扩大监测点位覆盖，补充多时段采样，待数据积累后细化治理方向。');

  return { title, description, recommendations: recs };
}

/** 海域环境质量对比（真数据版）：每海域一根柱 —— 质量评分(1-10, 越高越好) + 任务/目标数提示。
 * 同一海域的多个站点共享同一聚合值，按海域去重（全域=北戴河/秦皇岛/渤海湾三处）。
 * 无任何海域任务时展示空态引导（上传时选择监测点），不再回退静态假数据。 */
function SiteComparisonChart({ sites, loading }: { sites: SiteStat[]; loading: boolean }) {
  // 按海域去重：同一海域的多个站点共享同一聚合值，只保留每海域一个代表项
  // （与 3D 海洋态势页一致 —— 全域为北戴河/秦皇岛/渤海湾三处海域）
  const byArea = new Map<string, SiteStat>();
  for (const s of sites) {
    const key = s.seaAreaId != null ? `area-${s.seaAreaId}` : `site-${s.id}`;
    if (!byArea.has(key) || s.taskCount > (byArea.get(key)?.taskCount ?? -1)) byArea.set(key, s);
  }
  // 海域名：优先后端返回的 seaAreaName，否则取站点名「·」前缀
  const labelOf = (s: SiteStat) => s.seaAreaName ?? s.name.split('·')[0] ?? s.name;
  const withData = [...byArea.values()].filter((s) => s.taskCount > 0);
  const option: EChartsOption = {
    tooltip: {
      trigger: 'axis', backgroundColor: '#092a3e', borderColor: 'rgba(75,220,255,.28)',
      textStyle: { color: '#eaffff' },
      formatter: (params: unknown) => {
        const list = params as { dataIndex: number }[];
        const s = withData[list[0]?.dataIndex];
        if (!s) return '';
        return `<b>${labelOf(s)}</b><br/>代表站点：${s.code} ${s.name}<br/>环境质量评分：${s.qualityScore ?? '未检测'} / 10<br/>任务数：${s.taskCount} · 检出目标：${s.totalObjects}<br/>最近任务：${s.lastTaskAt ?? '—'}`;
      },
    },
    grid: { left: 12, right: 12, top: 22, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: withData.map(labelOf), axisLabel: { color: 'rgba(207,232,244,.56)' }, axisLine: { lineStyle: { color: 'rgba(94,214,255,.15)' } } },
    yAxis: { type: 'value', max: 10, axisLabel: { color: 'rgba(207,232,244,.56)' }, splitLine: { lineStyle: { color: 'rgba(94,214,255,.08)' } } },
    series: [{
      type: 'bar',
      data: withData.map((s) => ({ value: s.qualityScore ?? 0,
        // 按质量评分着色：高=青绿(好) → 低=红(差)，视觉即健康等级
        itemStyle: { borderRadius: [6, 6, 0, 0], color: s.qualityScore == null ? '#2a7f9e' : s.qualityScore >= 7 ? '#54f1a9' : s.qualityScore >= 4 ? '#ffbd66' : '#ff5f6e' } })),
      barWidth: 22,
    }],
  };
  if (loading) return <div className="chart-loading"><i className="loader-orbit" />数据计算中…</div>;
  if (withData.length === 0) {
    return <div className="chart-empty">暂无分海域数据<br /><small>在「检测识别」上传时选择监测点，此处即展示各海域环境质量对比</small></div>;
  }
  return <OceanChart option={option} className="comparison-chart" />;
}
