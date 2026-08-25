import { api } from '../api.js';
import { el, clear, icon, skeletonList, errorState, emptyState } from '../ui.js';
import { getSelectedSeaArea } from '../preferences.js';

export function renderAnalysis(container, ctx) {
  const { navigate, toast } = ctx;
  let mounted = true;
  const controller = new AbortController();
  const page = el('div', { className: 'page-pad analysis-page' });
  const back = el('button', { className: 'inline-back', onClick: () => navigate('dashboard') }, [icon('chevronLeft', 17), '返回首页']);
  const content = el('div', { className: 'analysis-content' }, skeletonList(3));
  page.append(back, content);
  container.append(page);
  load();

  async function load() {
    try {
      const [analysis, trend, sites] = await Promise.all([
        api.getAnalysis(), api.getTrend('week'), api.getSites(30),
      ]);
      if (!mounted) return;
      render(analysis || {}, trend || [], sites || []);
    } catch (error) {
      if (error?.name === 'AbortError' || !mounted) return;
      clear(content);
      content.append(errorState(error.message || '分析数据加载失败', load));
    }
  }

  function render(data, trend, sites) {
    clear(content);
    const selected = getSelectedSeaArea();
    const visibleSites = selected.id ? sites.filter((site) => site.seaAreaId === selected.id) : sites;
    content.append(el('section', { className: 'analysis-hero glass' }, [
      el('span', { className: 'eyebrow', textContent: '近 30 日全域统计' }),
      el('h1', { textContent: '污染分析简报' }),
      el('p', { textContent: `当前任务海域：${selected.name}。统计口径保持全域，站点态势按当前海域筛选。` }),
      el('div', { className: 'analysis-kpis' }, [
        kpi('污染指数', number(data.pollution_index), delta(data.pollution_index, data.pollution_index_prev, true)),
        kpi('塑料占比', `${number(data.plastic_percent)}%`, delta(data.plastic_percent, data.plastic_percent_prev, true)),
        kpi('严重任务', data.severe_count ?? 0, delta(data.severe_count, data.severe_count_prev, true)),
      ]),
    ]));

    content.append(el('section', { className: 'analysis-card' }, [
      sectionHead('近 7 日检测趋势', '不加载 ECharts'),
      sparkline(trend),
      el('p', { className: 'analysis-caption', textContent: trendSummary(trend) }),
    ]));

    const materials = Object.entries(data.material_breakdown || {});
    const materialCard = el('section', { className: 'analysis-card' }, [sectionHead('材质构成', `共 ${data.total_objects ?? 0} 个目标`)]);
    if (!materials.length) materialCard.append(emptyState('droplet', '暂无材质数据', '完成识别任务后将在此汇总'));
    else {
      const total = materials.reduce((sum, [, count]) => sum + count, 0) || 1;
      for (const [name, count] of materials) materialCard.append(el('div', { className: 'ratio-row' }, [
        el('div', { className: 'ratio-label' }, [el('span', { textContent: name }), el('b', { textContent: `${Math.round(count / total * 100)}%` })]),
        el('div', { className: 'ratio-track' }, [el('i', { style: { transform: `scaleX(${count / total})` } })]),
      ]));
    }
    content.append(materialCard);

    const siteCard = el('section', { className: 'analysis-card' }, [sectionHead('2D 海域态势', `${visibleSites.length} 个站点`)]);
    if (!visibleSites.length) siteCard.append(emptyState('mapPin', '当前海域暂无站点', '切换海域后可查看其他监测站点'));
    else {
      const list = el('div', { className: 'site-list' });
      for (const site of [...visibleSites].sort((a, b) => (b.pollutionIndex ?? -1) - (a.pollutionIndex ?? -1))) {
        const risk = site.pollutionIndex == null ? '暂无数据' : site.pollutionIndex >= 6 ? '高风险' : site.pollutionIndex >= 3 ? '需关注' : '稳定';
        list.append(el('article', { className: 'site-row' }, [
          el('span', { className: `site-dot ${risk === '高风险' ? 'danger' : risk === '需关注' ? 'warning' : ''}` }),
          el('div', {}, [el('strong', { textContent: site.name }), el('small', { textContent: `${site.taskCount} 次任务 · ${site.totalObjects} 个目标` })]),
          el('span', { className: 'risk-label', textContent: risk }),
        ]));
      }
      siteCard.append(list);
    }
    content.append(siteCard);

    const ranking = data.class_ranking || [];
    content.append(el('section', { className: 'analysis-card insight-card' }, [
      sectionHead('研判建议', '轻量结论'),
      el('ol', {}, [
        el('li', { textContent: data.severe_count ? `近 30 日有 ${data.severe_count} 个严重污染任务，应优先复核对应海域。` : '近期未出现严重污染任务，继续保持例行监测。' }),
        el('li', { textContent: materials[0] ? `${materials[0][0]}占比最高，建议围绕相关来源开展溯源。` : '当前材质样本不足，建议补充现场影像。' }),
        el('li', { textContent: ranking[0] ? `高频类别为${ranking[0].name}，累计 ${ranking[0].count} 个。` : '暂无稳定的高频类别结论。' }),
      ]),
      el('button', { className: 'btn-ghost btn-full', onClick: () => toast('完整多维联动分析为 PC 专属能力', 'info') }, ['在 PC 深入分析']),
    ]));
  }

  return { unmount() { mounted = false; controller.abort(); } };
}

function sectionHead(title, meta) {
  return el('div', { className: 'section-header' }, [el('h2', { className: 'section-title', textContent: title }), el('small', { textContent: meta })]);
}

function kpi(label, value, change) {
  return el('div', {}, [el('strong', { textContent: value }), el('span', { textContent: label }), el('small', { textContent: change })]);
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1);
}

function delta(current, previous, lowerIsBetter) {
  const diff = Number(current || 0) - Number(previous || 0);
  if (Math.abs(diff) < 0.05) return '较上期持平';
  const direction = diff > 0 ? '上升' : '下降';
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  return `较上期${direction} ${Math.abs(diff).toFixed(1)}${good ? ' · 改善' : ' · 关注'}`;
}

function sparkline(points) {
  if (!points.length) return emptyState('activity', '暂无趋势数据', '完成任务后生成轻量趋势');
  const values = points.map((point) => Number(point.count || 0));
  const max = Math.max(...values, 1);
  const coords = values.map((value, index) => `${10 + index * (280 / Math.max(values.length - 1, 1))},${92 - value / max * 72}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 300 105');
  svg.setAttribute('class', 'analysis-sparkline');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', coords);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '3');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  svg.append(line);
  return svg;
}

function trendSummary(points) {
  if (points.length < 2) return '数据点不足，暂不计算环比。';
  const first = Number(points[0].count || 0);
  const last = Number(points.at(-1).count || 0);
  const diff = last - first;
  return diff === 0 ? '最近检测量保持稳定。' : `最近检测量较周期开始${diff > 0 ? '增加' : '减少'} ${Math.abs(diff)} 次。`;
}
