import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Eye, FileBarChart, FilePlus2, LoaderCircle, Search, ShieldAlert, Sparkles, Trash2, X } from 'lucide-react';
import { api, getStoredToken } from '../services/api';
import type { Report } from '../types';

export function ReportsPage({ initialQuery = '', initialReportId }: { initialQuery?: string; initialReportId?: string }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [selected, setSelected] = useState<Report | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 全局搜索跳转到具体报告：列表加载完成后据此自动打开预览
  const [pendingFocus, setPendingFocus] = useState<string | null>(initialReportId ?? null);

  const load = async () => {
    setLoading(true); setError('');
    try { setReports(await api.getReports()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '报告加载失败'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!pendingFocus) return;
    const match = reports.find((item) => item.id === pendingFocus);
    if (match) { setSelected(match); setPendingFocus(null); }
  }, [reports, pendingFocus]);
  const filtered = useMemo(() => reports.filter((item) => `${item.id}${item.title}${item.area}${item.summary}`.includes(query)), [reports, query]);

  const downloadReport = (report: Report) => {
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

  return <div className="page-stack"><section className="page-heading compact"><div><span className="eyebrow"><i /> QUALITY REPORTS</span><h1>海洋质量报告</h1><p>汇总识别结果、污染评级与治理建议，形成可追溯评估档案。</p></div><button className="primary-button"><FilePlus2 />创建综合报告</button></section><section className="report-overview"><article className="report-hero glass"><div className="report-hero-icon"><FileBarChart /></div><div><span>本月报告</span><strong>24<small>份</small></strong><p>已覆盖 16 个监测点位</p></div><div className="mini-bars"><i style={{ height: '34%' }} /><i style={{ height: '56%' }} /><i style={{ height: '48%' }} /><i style={{ height: '72%' }} /><i style={{ height: '62%' }} /><i style={{ height: '86%' }} /><i style={{ height: '100%' }} /></div></article><article className="panel glass report-stat"><CheckCircle2 /><div><span>已生成</span><strong>21</strong><small>平均耗时 8.6 秒</small></div></article><article className="panel glass report-stat warning"><ShieldAlert /><div><span>风险报告</span><strong>4</strong><small>含差/严重等级</small></div></article><article className="panel glass report-stat"><Sparkles /><div><span>AI 解读</span><strong>18</strong><small>已生成治理建议</small></div></article></section><section className="panel glass reports-panel"><header className="reports-toolbar"><div><h2>报告档案</h2><span>统一管理自动生成的质量评估报告</span></div><label><Search /><input placeholder="搜索报告或海域" value={query} onChange={(event) => setQuery(event.target.value)} /></label></header>{loading ? <div className="table-state"><LoaderCircle className="spin" />正在加载报告…</div> : error ? <div className="table-state error">{error}<button onClick={load}>重试</button></div> : <div className="report-cards">{filtered.map((report) => <article key={report.id} className="report-card"><div className="report-cover"><span>海瞳</span><FileBarChart /><small>海洋污染质量评估</small><i /></div><div className="report-info"><div><span className={`level-badge level-${report.level}`}>{report.level}度污染</span><em>{report.status}</em></div><h3>{report.title}</h3><p>{report.summary}</p><dl><div><dt>质量评分</dt><dd>{report.score}<small>/100</small></dd></div><div><dt>识别目标</dt><dd>{report.objectCount}<small>件</small></dd></div><div><dt>生成时间</dt><dd>{report.createdAt.slice(5, 10)}</dd></div></dl><footer><button className="secondary-button" onClick={() => openReportPreview(report)}><Eye />在线预览</button><button className="icon-button" onClick={() => downloadReport(report)} aria-label="下载报告"><Download /></button><button className="icon-button danger" onClick={() => deleteReport(report)} aria-label="删除报告"><Trash2 /></button></footer></div></article>)}</div>}</section>{selected && <div className="modal-backdrop" onMouseDown={() => setSelected(null)}><article className="report-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setSelected(null)}><X /></button><header><span>海瞳 · 海洋智守平台</span><h2>{selected.title}</h2><p>报告编号 {selected.id} · {selected.createdAt}</p></header><div className="report-score-block"><div><strong>{selected.score}</strong><span>环境质量分</span></div><section><span className={`level-badge level-${selected.level}`}>{selected.level}度污染</span><h3>监测区域：{selected.area}</h3><p>本次共识别 {selected.objectCount} 个垃圾目标</p></section></div><section className="modal-section"><h3>01 · 综合评估摘要</h3><p>{selected.summary}</p></section><section className="modal-section"><h3>02 · 治理建议</h3><ul>{buildReportAdvice(selected).map((item) => <li key={item}>{item}</li>)}</ul></section><footer><button className="secondary-button" onClick={() => setSelected(null)}>关闭预览</button><button className="primary-button" onClick={() => downloadReport(selected)}><Download />下载报告</button><button className="secondary-button danger" onClick={() => deleteReport(selected)}><Trash2 />删除报告</button></footer></article></div>}</div>;
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
