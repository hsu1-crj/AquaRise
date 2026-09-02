import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Eye, FileBarChart, FilePlus2, Gauge, LoaderCircle, MapPin, Search, ShieldAlert, Trash2, X } from 'lucide-react';
import { api, getStoredToken } from '../services/api';
import type { Report, SeaArea } from '../types';

export function ReportsPage({ initialQuery = '', initialReportId }: { initialQuery?: string; initialReportId?: string }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [selected, setSelected] = useState<Report | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 全局搜索跳转到具体报告：列表加载完成后据此自动打开预览
  const [pendingFocus, setPendingFocus] = useState<string | null>(initialReportId ?? null);
  // 「创建综合报告」：勾选若干报告后聚合生成（限定同一海域，避免跨海域汇总出海域名错乱）
  const [creating, setCreating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 海域下拉过滤：'' = 全部海域，'none' = 未指定海域（历史报告），其余为海域 id 字符串
  const [areaFilter, setAreaFilter] = useState('');
  const [seaAreas, setSeaAreas] = useState<SeaArea[]>([]);

  // 报告的海域归属 key（历史报告无海域 → 'none' 自成一组）
  const areaKeyOf = (r: Report) => (r.seaAreaId != null ? String(r.seaAreaId) : 'none');
  // 已勾选集合锁定的海域：第一份勾选报告决定后续可勾选范围
  const lockedAreaKey = useMemo(() => {
    const first = reports.find((r) => selectedIds.has(r.id));
    return first ? areaKeyOf(first) : null;
  }, [reports, selectedIds]);
  const lockedAreaName = useMemo(() => {
    const first = reports.find((r) => selectedIds.has(r.id));
    return first ? (first.seaAreaName ?? '未指定海域') : '';
  }, [reports, selectedIds]);
  const hasUnassigned = reports.some((r) => r.seaAreaId == null);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); return next; }
      // 同海域约束：已有勾选时，不允许混入其他海域的报告（与后端校验一致）
      const target = reports.find((r) => r.id === id);
      if (target && lockedAreaKey != null && areaKeyOf(target) !== lockedAreaKey) return prev;
      next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const load = async () => {
    setLoading(true); setError('');
    try { setReports(await api.getReports()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '报告加载失败'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    api.getSeaAreas().then(setSeaAreas).catch(() => { /* 海域列表失败不影响报告列表 */ });
  }, []);

  useEffect(() => {
    if (!pendingFocus) return;
    const match = reports.find((item) => item.id === pendingFocus);
    if (match) { setSelected(match); setPendingFocus(null); }
  }, [reports, pendingFocus]);
  const filtered = useMemo(() => reports.filter((item) =>
    (areaFilter === '' || areaKeyOf(item) === areaFilter) &&
    `${item.id}${item.title}${item.area}${item.summary}`.includes(query)
  ), [reports, query, areaFilter]);
  const overviewStats = useMemo(() => buildOverviewStats(reports), [reports]);

  // 下载报告：有预览地址时下载与在线预览一致的完整 HTML 报告；否则回退为摘要文本
  const downloadReport = async (report: Report) => {
    let html = '';
    if (report.reportUrl) {
      try { html = await api.getReportHtml(report.id); } catch { html = ''; }
    }
    if (html) {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${report.title.replace(/[\\/:*?"<>|]/g, '-')}.html`;
      link.click(); URL.revokeObjectURL(link.href);
      return;
    }
    const content = `${report.title}\n\n报告编号：${report.id}\n监测海域：${report.area}\n生成时间：${report.createdAt}\n质量评分：${report.score}\n污染等级：${report.level}\n识别目标：${report.objectCount} 件\n\n评估摘要\n${report.summary}\n\n本报告由海瞳海洋智守平台生成。`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${report.id}.txt`; link.click(); URL.revokeObjectURL(link.href);
  };

  // 在线预览：优先新窗口打开后端生成的完整 HTML 报告；无预览地址时回退到内置摘要弹窗
  const openReportPreview = (report: Report) => {
    if (report.reportUrl) {
      const token = getStoredToken();
      const url = token ? `${report.reportUrl}?token=${encodeURIComponent(token)}` : report.reportUrl;
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    setSelected(report);
  };

  // 删除报告：确认后调用后端删除记录与 HTML 文件，并从列表移除
  const deleteReport = async (report: Report) => {
    if (!window.confirm(`确定删除报告「${report.title}」吗？删除后不可恢复。`)) return;
    try {
      await api.deleteReport(report.id);
      setReports((prev) => prev.filter((item) => item.id !== report.id));
      setSelected((prev) => (prev && prev.id === report.id ? null : prev));
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '删除报告失败');
    }
  };

  // 综合报告：基于勾选的若干份报告聚合生成，完成后刷新列表并打开新报告
  const createComprehensiveReport = async () => {
    if (creating || selectedIds.size === 0) return;
    setCreating(true);
    try {
      const ids = Array.from(selectedIds).map((id) => Number(id.replace(/^RPT-/i, '')));
      const report = await api.createComprehensiveReport(ids);
      setSelectedIds(new Set());
      await load();
      openReportPreview(report);
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '综合报告创建失败');
    } finally {
      setCreating(false);
    }
  };

  return <div className="page-stack"><section className="page-heading compact"><div><span className="eyebrow"><i /> QUALITY REPORTS</span><h1>海洋质量报告</h1><p>汇总识别结果、污染评级与治理建议，形成可追溯评估档案。</p></div>{selectedIds.size > 0 && <button className="secondary-button" onClick={clearSelection} disabled={creating}>清除选择（{selectedIds.size}）</button>}<button className="primary-button" disabled={creating || selectedIds.size === 0} title={selectedIds.size === 0 ? '请先在报告卡片右上角勾选要汇总的报告' : undefined} onClick={createComprehensiveReport}>{creating ? <LoaderCircle className="spin" /> : <FilePlus2 />}{creating ? '正在创建…' : selectedIds.size > 0 ? `创建综合报告（${selectedIds.size} 份 · ${lockedAreaName}）` : '创建综合报告'}</button></section><section className="report-overview"><article className="report-hero glass"><div className="report-hero-icon"><FileBarChart /></div><div><span>本月报告</span><strong>{overviewStats.monthCount}<small>份</small></strong><p>已覆盖 {overviewStats.pointCount} 个监测点位</p></div><div className="mini-bars" title="近7天每日生成报告数">{overviewStats.barHeights.map((height, index) => <i key={index} style={{ height }} />)}</div></article><article className="panel glass report-stat"><CheckCircle2 /><div><span>已生成</span><strong>{overviewStats.generatedCount}</strong><small>识别目标 {overviewStats.totalObjects} 件</small></div></article><article className="panel glass report-stat warning"><ShieldAlert /><div><span>风险报告</span><strong>{overviewStats.riskCount}</strong><small>含差/严重等级</small></div></article><article className="panel glass report-stat"><Gauge /><div><span>平均质量分</span><strong>{overviewStats.avgScore}</strong><small>基于 {overviewStats.scoredCount} 份报告评分</small></div></article></section><section className="panel glass reports-panel"><header className="reports-toolbar"><div><h2>报告档案</h2><span>统一管理自动生成的质量评估报告</span></div><label className="period-select"><MapPin /><select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)} aria-label="按海域筛选报告"><option value="">全部海域</option>{seaAreas.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}{hasUnassigned && <option value="none">未指定海域</option>}</select></label><label><Search /><input placeholder="搜索报告或海域" value={query} onChange={(event) => setQuery(event.target.value)} /></label></header>{loading ? <div className="table-state"><LoaderCircle className="spin" />正在加载报告…</div> : error ? <div className="table-state error">{error}<button onClick={load}>重试</button></div> : <div className="report-cards">{filtered.map((report) => <article key={report.id} className="report-card"><div className="report-cover"><span>海瞳</span><FileBarChart /><small>海洋污染质量评估</small><i /><label className={`report-select ${selectedIds.has(report.id) ? 'checked' : ''}`} title={lockedAreaKey != null && areaKeyOf(report) !== lockedAreaKey && !selectedIds.has(report.id) ? '综合报告只能汇总同一海域的报告' : '勾选后纳入综合报告'}><input type="checkbox" checked={selectedIds.has(report.id)} disabled={lockedAreaKey != null && areaKeyOf(report) !== lockedAreaKey && !selectedIds.has(report.id)} onChange={() => toggleSelect(report.id)} />{selectedIds.has(report.id) ? '已选' : '纳入汇总'}</label></div><div className="report-info"><div><span className={`level-badge level-${report.level}`}>{report.level}度污染</span><em>{report.status}</em><span className="report-area-tag">{report.seaAreaName ?? '未指定海域'}</span></div><h3>{report.title}</h3><p>{report.summary}</p><dl><div><dt>质量评分</dt><dd>{report.score}<small>/100</small></dd></div><div><dt>识别目标</dt><dd>{report.objectCount}<small>件</small></dd></div><div><dt>生成时间</dt><dd>{report.createdAt.slice(5, 10)}</dd></div></dl><footer><button className="secondary-button" onClick={() => openReportPreview(report)}><Eye />在线预览</button><button className="icon-button" onClick={() => downloadReport(report)} aria-label="下载报告"><Download /></button><button className="icon-button danger" onClick={() => deleteReport(report)} aria-label="删除报告"><Trash2 /></button></footer></div></article>)}</div>}</section>{selected && <div className="modal-backdrop" onMouseDown={() => setSelected(null)}><article className="report-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setSelected(null)}><X /></button><header><span>海瞳 · 海洋智守平台</span><h2>{selected.title}</h2><p>报告编号 {selected.id} · {selected.createdAt}</p></header><div className="report-score-block"><div><strong>{selected.score}</strong><span>环境质量分</span></div><section><span className={`level-badge level-${selected.level}`}>{selected.level}度污染</span><h3>监测区域：{selected.area}</h3><p>本次共识别 {selected.objectCount} 个垃圾目标</p></section></div><section className="modal-section"><h3>01 · 综合评估摘要</h3><p>{selected.summary}</p></section><section className="modal-section"><h3>02 · 治理建议</h3><ul>{buildReportAdvice(selected).map((item) => <li key={item}>{item}</li>)}</ul></section><footer><button className="secondary-button" onClick={() => setSelected(null)}>关闭预览</button><button className="primary-button" onClick={() => downloadReport(selected)}><Download />下载报告</button><button className="secondary-button danger" onClick={() => deleteReport(selected)}><Trash2 />删除报告</button></footer></article></div>}</div>;
}

/** 由报告自身的检测结果（污染等级/目标数/质量评分）动态生成治理建议，替代写死文案 */
function buildReportAdvice(report: Report): string[] {
  const recs: string[] = [];
  if (report.level === '严重' || report.level === '差') {
    recs.push(`监测区域污染等级为「${report.level}」，优先安排高密度目标的人工复核与集中清理，72 小时内完成并记录治理前后对比数据。`);
  } else if (report.level === '中') {
    recs.push('污染等级为「中」，建议在 7 天内组织一次定点复检，确认污染源是否持续输入。');
  } else {
    recs.push('污染等级为「优/良」，建议保持常规监测节奏，防范新增污染源。');
  }
  if (report.objectCount >= 50) {
    recs.push(`本次识别目标较多（${report.objectCount} 件），建议按目标类别分区制定打捞计划，并优先清理高风险类别。`);
  } else if (report.objectCount > 0) {
    recs.push(`本次共识别 ${report.objectCount} 件垃圾，建议针对高频类别开展源头排查。`);
  }
  if (report.score < 60) {
    recs.push('环境质量评分偏低，建议扩大点位覆盖并加密采样，形成月度趋势观察。');
  } else {
    recs.push('将本次数据纳入月度海域趋势分析，持续观察污染变化。');
  }
  return recs;
}

/** 报表概览统计：从已加载报告列表实时计算，替代写死的卡片数字 */
function buildOverviewStats(reports: Report[], now = new Date()) {
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthCount = reports.filter((r) => (r.createdAt || '').slice(0, 7) === monthKey).length;
  const pointCount = new Set(reports.map((r) => r.area).filter(Boolean)).size;
  const generatedCount = reports.filter((r) => r.status === '已生成').length;
  const riskCount = reports.filter((r) => r.level === '差' || r.level === '严重').length;
  const totalObjects = reports.reduce((sum, r) => sum + (r.objectCount || 0), 0);
  const scored = reports.filter((r) => typeof r.score === 'number' && r.score >= 0);
  const scoredCount = scored.length;
  const avgScore = scoredCount ? Math.round(scored.reduce((sum, r) => sum + r.score, 0) / scoredCount) : 0;

  // 近 7 天每日生成报告数：按自然日补零，柱子位置稳定，无报告的天计 0
  const byDate = new Map<string, number>();
  for (const r of reports) {
    const day = (r.createdAt || '').slice(0, 10);
    if (day) byDate.set(day, (byDate.get(day) ?? 0) + 1);
  }
  const days: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push(byDate.get(key) ?? 0);
  }
  const maxCount = Math.max(1, ...days);
  const barHeights = days.map((count) => `${Math.max(6, Math.round((count / maxCount) * 100))}%`);
  return { monthCount, pointCount, generatedCount, riskCount, totalObjects, avgScore, scoredCount, barHeights };
}
