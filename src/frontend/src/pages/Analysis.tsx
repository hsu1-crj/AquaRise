import { useEffect, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, BrainCircuit, CalendarRange, Download, Info, Layers3, MapPinned, RefreshCw } from 'lucide-react';
import { MaterialChart, OceanChart, RankingChart, TrendChart } from '../components/Charts';
import { api } from '../services/api';
import type { EChartsCoreOption as EChartsOption } from 'echarts/core';
import type { SiteStat, StatsAnalysis, TrendPoint } from '../types';

export function AnalysisPage() {
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [analysis, setAnalysis] = useState<StatsAnalysis | null>(null);
  const [siteStats, setSiteStats] = useState<SiteStat[]>([]);
  const [period, setPeriod] = useState('month');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.getTrend(period), api.getAnalysis(), api.getSiteStats()])
      .then(([trendData, analysisData, siteData]) => {
        setTrend(trendData);
        setAnalysis(analysisData);
        setSiteStats(siteData);
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

  return <div className="page-stack"><section className="page-heading compact"><div><span className="eyebrow"><i /> ENVIRONMENT INSIGHTS</span><h1>海洋污染分析</h1><p>从趋势、材质和海域维度洞察污染变化，辅助治理决策。</p></div><div className="heading-actions"><label className="period-select"><CalendarRange /><select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="week">近 7 天</option><option value="month">近 30 天</option><option value="year">近 12 月</option></select></label><button className="secondary-button" onClick={exportCsv} disabled={!analysis}><Download />导出分析</button></div></section><section className="insight-strip glass"><BrainCircuit /><div><span>AI 洞察</span><strong>A-07 点位污染指数高于区域均值 34%</strong><p>近两周废弃渔网目标持续增多，建议优先排查沿岸渔业作业密集区。</p></div><button>查看治理建议</button></section><section className="analysis-kpis"><article className="panel glass"><span>综合污染指数<Info /></span><strong>{analysis?.pollutionIndex.toFixed(1) ?? '—'}<small>/ 10</small></strong>{indexDelta == null ? <em className="neutral">基于近 30 天</em> : <em className={indexDelta < 0 ? 'down' : 'up'}>{indexDelta < 0 ? <ArrowDownRight /> : <ArrowUpRight />}较上月 {Math.abs(indexDelta).toFixed(1)}%</em>}</article><article className="panel glass"><span>塑料垃圾占比<Layers3 /></span><strong>{analysis?.plasticPercent.toFixed(1) ?? '—'}<small>%</small></strong>{plasticDelta == null ? <em className="neutral">基于近 30 天</em> : <em className={plasticDelta > 0 ? 'up' : 'down'}>{plasticDelta > 0 ? <ArrowUpRight /> : <ArrowDownRight />}较上月 {Math.abs(plasticDelta).toFixed(1)}%</em>}</article><article className="panel glass"><span>高风险监测点<MapPinned /></span><strong>{analysis?.severeCount ?? '—'}<small>处</small></strong><em className="neutral">近 30 日严重污染任务</em></article><article className="panel glass"><span>治理有效率<Activity /></span><strong>82.6<small>%</small></strong><em className="up good"><ArrowUpRight />较上月 6.7%</em></article></section><section className="analysis-grid"><article className="panel glass analysis-trend"><header className="panel-simple-title"><div><h2>污染趋势与密度变化</h2><span>目标数量 / 单位面积垃圾密度</span></div><button onClick={() => setPeriod(period)}><RefreshCw /></button></header>{loading ? <div className="chart-loading"><i className="loader-orbit" />数据计算中…</div> : <TrendChart data={trend} />}</article><article className="panel glass"><header className="panel-simple-title"><div><h2>垃圾材质构成</h2><span>各材质目标占比</span></div></header><MaterialChart breakdown={analysis?.materialBreakdown} total={analysis?.totalObjects} /></article><article className="panel glass"><header className="panel-simple-title"><div><h2>海域污染对比</h2><span>监测点垃圾密度 /㎡</span></div></header><SiteComparisonChart sites={siteStats} loading={loading} /></article><article className="panel glass"><header className="panel-simple-title"><div><h2>高频目标排名</h2><span>近 30 日识别总量</span></div></header><RankingChart ranking={analysis?.classRanking} /></article></section></div>;
}

/** 海域污染对比（F0 真数据版）：分站点污染指数 + 任务/目标数提示。
 * 无任何站点任务时展示空态引导（上传时选择监测点），不再回退静态假数据。 */
function SiteComparisonChart({ sites, loading }: { sites: SiteStat[]; loading: boolean }) {
  const withData = sites.filter((s) => s.taskCount > 0);
  const option: EChartsOption = {
    tooltip: {
      trigger: 'axis', backgroundColor: '#092a3e', borderColor: 'rgba(75,220,255,.28)',
      textStyle: { color: '#eaffff' },
      formatter: (params: unknown) => {
        const list = params as { dataIndex: number }[];
        const s = withData[list[0]?.dataIndex];
        if (!s) return '';
        return `<b>${s.code} ${s.name}</b><br/>污染指数：${s.pollutionIndex ?? '—'} / 10<br/>任务数：${s.taskCount} · 检出目标：${s.totalObjects}<br/>最近任务：${s.lastTaskAt ?? '—'}`;
      },
    },
    grid: { left: 12, right: 12, top: 22, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: withData.map((s) => s.code), axisLabel: { color: 'rgba(207,232,244,.56)' }, axisLine: { lineStyle: { color: 'rgba(94,214,255,.15)' } } },
    yAxis: { type: 'value', max: 10, axisLabel: { color: 'rgba(207,232,244,.56)' }, splitLine: { lineStyle: { color: 'rgba(94,214,255,.08)' } } },
    series: [{
      type: 'bar',
      data: withData.map((s) => ({ value: s.pollutionIndex ?? 0,
        // 按污染指数着色：低=青绿 → 高=红，视觉即风险等级
        itemStyle: { borderRadius: [6, 6, 0, 0], color: (s.pollutionIndex ?? 0) >= 7 ? '#ff5f6e' : (s.pollutionIndex ?? 0) >= 5 ? '#ffbd66' : '#27dafa' } })),
      barWidth: 22,
    }],
  };
  if (loading) return <div className="chart-loading"><i className="loader-orbit" />数据计算中…</div>;
  if (withData.length === 0) {
    return <div className="chart-empty">暂无分站点数据<br /><small>在「检测识别」上传时选择监测点，此处即展示各站点污染对比</small></div>;
  }
  return <OceanChart option={option} className="comparison-chart" />;
}
