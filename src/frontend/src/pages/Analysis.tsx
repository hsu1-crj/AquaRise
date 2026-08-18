import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, BrainCircuit, CalendarRange, Download, Info, Layers3, MapPinned, RefreshCw } from 'lucide-react';
import { MaterialChart, OceanChart, RankingChart, TrendChart } from '../components/Charts';
import { api } from '../services/api';
import type { EChartsCoreOption as EChartsOption } from 'echarts/core';
import type { StatsAnalysis, TrendPoint } from '../types';

export function AnalysisPage() {
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [analysis, setAnalysis] = useState<StatsAnalysis | null>(null);
  const [period, setPeriod] = useState('month');
  const [loading, setLoading] = useState(true);
  const [adviceOpen, setAdviceOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.getTrend(period), api.getAnalysis()])
      .then(([trendData, analysisData]) => {
        setTrend(trendData);
        setAnalysis(analysisData);
      })
      .catch(() => { /* 失败保留旧数据，图表区展示加载失败 */ })
      .finally(() => setLoading(false));
  }, [period]);

  // 环比增量（前窗口无数据时为 null → 显示"基于近 30 天"而非误导性百分比）
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
    lines.push(`高风险监测点,${analysis.severeCount} 处,近 30 天严重污染任务`);
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

  return <div className="page-stack"><section className="page-heading compact"><div><span className="eyebrow"><i /> ENVIRONMENT INSIGHTS</span><h1>海洋污染分析</h1><p>从趋势、材质和海域维度洞察污染变化，辅助治理决策。</p></div><div className="heading-actions"><label className="period-select"><CalendarRange /><select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="week">近 7 天</option><option value="month">近 30 天</option><option value="year">近 12 月</option></select></label><button className="secondary-button" onClick={exportCsv} disabled={!analysis}><Download />导出分析</button></div></section><section className="insight-strip glass"><BrainCircuit /><div><span>AI 洞察</span>{insight ? <><strong>{insight.title}</strong><p>{insight.description}</p>{adviceOpen && insight.recommendations.length > 0 && <ul className="insight-advice">{insight.recommendations.map((item) => <li key={item}>{item}</li>)}</ul>}</> : <p>正在基于检测数据生成洞察…</p>}</div><button onClick={() => setAdviceOpen((open) => !open)} aria-expanded={adviceOpen} disabled={!insight || insight.recommendations.length === 0}>{adviceOpen ? '收起建议' : '查看治理建议'}</button></section><section className="analysis-kpis"><article className="panel glass"><span>综合污染指数<Info /></span><strong>{analysis?.pollutionIndex.toFixed(1) ?? '—'}<small>/ 10</small></strong>{indexDelta == null ? <em className="neutral">基于近 30 天</em> : <em className={indexDelta < 0 ? 'down' : 'up'}>{indexDelta < 0 ? <ArrowDownRight /> : <ArrowUpRight />}较上月 {Math.abs(indexDelta).toFixed(1)}%</em>}</article><article className="panel glass"><span>塑料垃圾占比<Layers3 /></span><strong>{analysis?.plasticPercent.toFixed(1) ?? '—'}<small>%</small></strong>{plasticDelta == null ? <em className="neutral">基于近 30 天</em> : <em className={plasticDelta > 0 ? 'up' : 'down'}>{plasticDelta > 0 ? <ArrowUpRight /> : <ArrowDownRight />}较上月 {Math.abs(plasticDelta).toFixed(1)}%</em>}</article><article className="panel glass"><span>高风险监测点<MapPinned /></span><strong>{analysis?.severeCount ?? '—'}<small>处</small></strong><em className="neutral">近 30 日严重污染任务</em></article><article className="panel glass"><span>治理有效率<Activity /></span><strong>82.6<small>%</small></strong><em className="up good"><ArrowUpRight />较上月 6.7%</em></article></section><section className="analysis-grid"><article className="panel glass analysis-trend"><header className="panel-simple-title"><div><h2>污染趋势与密度变化</h2><span>目标数量 / 单位面积垃圾密度</span></div><button onClick={() => setPeriod(period)}><RefreshCw /></button></header>{loading ? <div className="chart-loading"><i className="loader-orbit" />数据计算中…</div> : <TrendChart data={trend} />}</article><article className="panel glass"><header className="panel-simple-title"><div><h2>垃圾材质构成</h2><span>各材质目标占比</span></div></header><MaterialChart breakdown={analysis?.materialBreakdown} total={analysis?.totalObjects} /></article><article className="panel glass"><header className="panel-simple-title"><div><h2>海域污染对比</h2><span>监测点垃圾密度 /㎡</span></div></header><OceanChart option={COMPARISON_OPTION} className="comparison-chart" /></article><article className="panel glass"><header className="panel-simple-title"><div><h2>高频目标排名</h2><span>近 30 日识别总量</span></div></header><RankingChart ranking={analysis?.classRanking} /></article></section></div>;
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

/** 海域对比目前无真实分海域数据（sea_area_id 为空），保留静态演示配置（模块级常量，避免每次渲染重建图表） */
const COMPARISON_OPTION: EChartsOption = {
  tooltip: { trigger: 'axis', backgroundColor: '#092a3e', borderColor: 'rgba(75,220,255,.28)', textStyle: { color: '#eaffff' } },
  grid: { left: 12, right: 12, top: 22, bottom: 8, containLabel: true },
  xAxis: { type: 'category', data: ['A-02', 'A-07', 'B-08', 'B-12', 'C-03', 'D-09'], axisLabel: { color: 'rgba(207,232,244,.56)' }, axisLine: { lineStyle: { color: 'rgba(94,214,255,.15)' } } },
  yAxis: { type: 'value', axisLabel: { color: 'rgba(207,232,244,.56)' }, splitLine: { lineStyle: { color: 'rgba(94,214,255,.08)' } } },
  series: [{ type: 'bar', data: [4.1, 7.8, 3.6, 5.4, 2.2, 1.8], barWidth: 22, itemStyle: { borderRadius: [6, 6, 0, 0], color: '#27dafa' } }],
};
