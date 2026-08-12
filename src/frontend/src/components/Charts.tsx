import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GraphicComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption as EChartsOption } from 'echarts/core';
import type { TrendPoint } from '../types';

echarts.use([BarChart, LineChart, PieChart, GraphicComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface ChartProps { option: EChartsOption; className?: string }

export function OceanChart({ option, className = '' }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.getInstanceByDom(ref.current) ?? echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chart.setOption(option, { notMerge: true });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [option]);
  return <div ref={ref} className={`chart ${className}`} role="img" aria-label="数据可视化图表" />;
}

const axisLabel = { color: 'rgba(207,232,244,.56)', fontSize: 11 };
const splitLine = { lineStyle: { color: 'rgba(94,214,255,.09)' } };

export function TrendChart({ data }: { data: TrendPoint[] }) {
  const option: EChartsOption = {
    animationDuration: 900,
    tooltip: { trigger: 'axis', backgroundColor: '#092a3e', borderColor: 'rgba(75,220,255,.28)', textStyle: { color: '#eaffff' } },
    grid: { left: 12, right: 18, top: 30, bottom: 8, containLabel: true },
    legend: { top: 0, right: 4, textStyle: axisLabel, itemWidth: 16, itemHeight: 8 },
    xAxis: { type: 'category', boundaryGap: false, data: data.map((item) => item.date), axisLabel, axisLine: { lineStyle: { color: 'rgba(94,214,255,.16)' } }, axisTick: { show: false } },
    yAxis: [
      { type: 'value', axisLabel, splitLine },
      { type: 'value', axisLabel: { ...axisLabel, formatter: '{value}/㎡' }, splitLine: { show: false } },
    ],
    series: [
      {
        name: '垃圾数量', type: 'line', smooth: true, symbol: 'none', data: data.map((item) => item.count),
        lineStyle: { color: '#20d7ff', width: 3 },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(32,215,255,.38)' }, { offset: 1, color: 'rgba(32,215,255,0)' }]) },
      },
      { name: '密度', type: 'line', smooth: true, symbolSize: 7, yAxisIndex: 1, data: data.map((item) => item.density), lineStyle: { color: '#54f1a9', width: 2 }, itemStyle: { color: '#54f1a9' } },
    ],
  };
  return <OceanChart option={option} className="trend-chart" />;
}

export function MaterialChart() {
  const option: EChartsOption = {
    tooltip: { trigger: 'item', backgroundColor: '#092a3e', borderColor: 'rgba(75,220,255,.28)', textStyle: { color: '#eaffff' } },
    legend: { bottom: 0, textStyle: axisLabel, itemWidth: 9, itemHeight: 9 },
    series: [{
      type: 'pie', radius: ['52%', '76%'], center: ['50%', '43%'], padAngle: 3, itemStyle: { borderRadius: 5 }, label: { show: false },
      data: [
        { name: '塑料/轻质', value: 48, itemStyle: { color: '#20d7ff' } },
        { name: '渔网/绳索', value: 22, itemStyle: { color: '#7068ff' } },
        { name: '金属/木质', value: 15, itemStyle: { color: '#54f1a9' } },
        { name: '其他', value: 15, itemStyle: { color: '#ffbd66' } },
      ],
    }],
    graphic: [{ type: 'text', left: 'center', top: '35%', style: { text: '487,392', fill: '#f0feff', font: '700 20px Inter' } }, { type: 'text', left: 'center', top: '47%', style: { text: '累计识别', fill: 'rgba(207,232,244,.5)', font: '11px sans-serif' } }],
  };
  return <OceanChart option={option} className="material-chart" />;
}

export function RankingChart() {
  const option: EChartsOption = {
    grid: { left: 8, right: 18, top: 6, bottom: 6, containLabel: true },
    xAxis: { type: 'value', show: false },
    yAxis: { type: 'category', inverse: true, data: ['易清除垃圾', '纠缠垃圾', '沉重垃圾'], axisLabel: { ...axisLabel, color: 'rgba(230,248,255,.75)' }, axisLine: { show: false }, axisTick: { show: false } },
    series: [{ type: 'bar', data: [128, 96, 82], barWidth: 8, showBackground: true, backgroundStyle: { color: 'rgba(94,214,255,.07)', borderRadius: 8 }, itemStyle: { borderRadius: 8, color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: '#1677ff' }, { offset: 1, color: '#42e8ff' }]) }, label: { show: true, position: 'right', color: '#bfefff', fontSize: 11 } }],
  };
  return <OceanChart option={option} className="ranking-chart" />;
}
