import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, BrainCircuit, CalendarRange, Download, Info, Layers3, MapPinned, RefreshCw } from 'lucide-react';
import { MaterialChart, OceanChart, RankingChart, TrendChart } from '../components/Charts';
import { api } from '../services/api';
import type { EChartsCoreOption as EChartsOption } from 'echarts/core';
import type { TrendPoint } from '../types';

export function AnalysisPage() {
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [period, setPeriod] = useState('month');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getTrend(period).then(setTrend).finally(() => setLoading(false));
  }, [period]);

  const comparison = useMemo<EChartsOption>(() => ({
    tooltip: { trigger: 'axis', backgroundColor: '#092a3e', borderColor: 'rgba(75,220,255,.28)', textStyle: { color: '#eaffff' } },
    grid: { left: 12, right: 12, top: 22, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: ['A-02', 'A-07', 'B-08', 'B-12', 'C-03', 'D-09'], axisLabel: { color: 'rgba(207,232,244,.56)' }, axisLine: { lineStyle: { color: 'rgba(94,214,255,.15)' } } },
    yAxis: { type: 'value', axisLabel: { color: 'rgba(207,232,244,.56)' }, splitLine: { lineStyle: { color: 'rgba(94,214,255,.08)' } } },
    series: [{ type: 'bar', data: [4.1, 7.8, 3.6, 5.4, 2.2, 1.8], barWidth: 22, itemStyle: { borderRadius: [6, 6, 0, 0], color: '#27dafa' } }],
  }), []);

  return <div className="page-stack"><section className="page-heading compact"><div><span className="eyebrow"><i /> ENVIRONMENT INSIGHTS</span><h1>海洋污染分析</h1><p>从趋势、材质和海域维度洞察污染变化，辅助治理决策。</p></div><div className="heading-actions"><label className="period-select"><CalendarRange /><select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="week">近 7 天</option><option value="month">近 30 天</option><option value="year">近 12 月</option></select></label><button className="secondary-button"><Download />导出分析</button></div></section><section className="insight-strip glass"><BrainCircuit /><div><span>AI 洞察</span><strong>A-07 点位污染指数高于区域均值 34%</strong><p>近两周废弃渔网目标持续增多，建议优先排查沿岸渔业作业密集区。</p></div><button>查看治理建议</button></section><section className="analysis-kpis"><article className="panel glass"><span>综合污染指数<Info /></span><strong>4.62<small>/ 10</small></strong><em className="down"><ArrowDownRight />较上月 8.4%</em></article><article className="panel glass"><span>塑料垃圾占比<Layers3 /></span><strong>48.2<small>%</small></strong><em className="up"><ArrowUpRight />较上月 3.1%</em></article><article className="panel glass"><span>高风险监测点<MapPinned /></span><strong>3<small>处</small></strong><em className="neutral">共监测 28 处</em></article><article className="panel glass"><span>治理有效率<Activity /></span><strong>82.6<small>%</small></strong><em className="up good"><ArrowUpRight />较上月 6.7%</em></article></section><section className="analysis-grid"><article className="panel glass analysis-trend"><header className="panel-simple-title"><div><h2>污染趋势与密度变化</h2><span>目标数量 / 单位面积垃圾密度</span></div><button onClick={() => setPeriod(period)}><RefreshCw /></button></header>{loading ? <div className="chart-loading"><i className="loader-orbit" />数据计算中…</div> : <TrendChart data={trend} />}</article><article className="panel glass"><header className="panel-simple-title"><div><h2>垃圾材质构成</h2><span>各材质目标占比</span></div></header><MaterialChart /></article><article className="panel glass"><header className="panel-simple-title"><div><h2>海域污染对比</h2><span>监测点垃圾密度 /㎡</span></div></header><OceanChart option={comparison} className="comparison-chart" /></article><article className="panel glass"><header className="panel-simple-title"><div><h2>高频目标排名</h2><span>近 30 日识别总量</span></div></header><RankingChart /></article></section></div>;
}
