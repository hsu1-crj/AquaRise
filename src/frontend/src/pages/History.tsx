import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, Download, FileSearch, FileText, Filter, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../services/api';
import type { DetectionRecord, VideoDetectResult } from '../types';
import { ImageDetailCard, VideoResultCard } from '../components/resultViews';

const PAGE_SIZE = 50;

/** 生成页码序列：页数 ≤7 全列，否则首尾 + 当前页±1，中间用省略号 */
function pageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  if (current > 3) pages.push('…');
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i += 1) pages.push(i);
  if (current < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

export function HistoryPage() {
  const [records, setRecords] = useState<DetectionRecord[]>([]);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('全部等级');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 「查看详情」弹窗：视频任务复用 VideoResultCard（预览帧画廊+标注视频+目标列表），图片任务复用 ImageDetailCard（标注图+目标列表）
  const [detail, setDetail] = useState<VideoDetectResult | null>(null);
  const [detailRecord, setDetailRecord] = useState<DetectionRecord | null>(null); // 打开详情的那条记录（用于重试）
  const [detailType, setDetailType] = useState<'图片' | '视频'>('图片');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [creatingReport, setCreatingReport] = useState(false);
  const [reportError, setReportError] = useState('');

  const searchTimer = useRef<number | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** 服务端分页拉取：等级过滤 + 编号/文件名搜索都交给后端，页码按 total 生成 */
  const load = async (targetPage: number, filters: { level: string; query: string }) => {
    setLoading(true); setError('');
    try {
      const payload = await api.getHistory(targetPage, PAGE_SIZE, filters);
      setRecords(payload.items);
      setTotal(payload.total);
      setPage(targetPage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(1, { level: '全部等级', query: '' }); }, []);
  // 卸载时清理搜索防抖定时器
  useEffect(() => () => { if (searchTimer.current) window.clearTimeout(searchTimer.current); }, []);

  // Esc 关闭详情弹窗
  useEffect(() => {
    if (!detail) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDetail(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

  const goTo = (target: number) => {
    const next = Math.min(Math.max(1, target), totalPages);
    if (next !== page) void load(next, { level, query });
  };

  const changeLevel = (value: string) => {
    setLevel(value);
    void load(1, { level: value, query });
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => void load(1, { level, query: value }), 300);
  };

  const exportCsv = () => {
    const lines = ['任务编号,检测时间,监测点位,类型,目标数,污染等级,状态', ...records.map((item) => [item.id, item.createdAt, item.location, item.type, item.objectCount, item.level, item.status].join(','))];
    const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'aquarise-detection-history.csv'; link.click(); URL.revokeObjectURL(link.href);
  };

  /** 打开详情：历史记录 id 形如 DET-{task_id}，取出数字后拉取 /detect/result（图片/视频通用） */
  const openDetail = async (record: DetectionRecord) => {
    const taskId = Number(record.id.replace(/\D+/g, ''));
    if (!taskId) return;
    setDetailRecord(record);
    setDetailType(record.type);
    setDetail(null); setDetailError(''); setReportError('');
    setDetailLoading(true);
    try {
      setDetail(await api.getVideoResult(taskId));
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : '加载详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const createDetailReport = async () => {
    if (!detail) return;
    setCreatingReport(true); setReportError('');
    try {
      await api.createReport(String(detail.taskId));
      setDetail(null);
      window.location.hash = 'reports'; // 与智能识别一致：报告生成后跳转报告页
    } catch (reason) {
      setReportError(reason instanceof Error ? reason.message : '报告生成失败');
    } finally {
      setCreatingReport(false);
    }
  };

  return <div className="page-stack"><section className="page-heading compact"><div><span className="eyebrow"><i /> DETECTION ARCHIVE</span><h1>检测历史</h1><p>检索、筛选和导出所有水下影像识别任务。</p></div><button className="primary-button" onClick={exportCsv}><Download />导出当前结果</button></section><section className="panel glass data-panel"><div className="filter-bar"><label className="filter-search"><Search /><input value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="搜索任务编号或文件名" /></label><label><Filter />污染等级<select value={level} onChange={(event) => changeLevel(event.target.value)}><option>全部等级</option><option>优</option><option>良</option><option>中</option><option>差</option><option>严重</option></select></label><label><CalendarDays />时间范围<select><option>近 30 天</option><option>近 90 天</option><option>全部</option></select></label><button className="secondary-button" onClick={() => void load(page, { level, query })}><RefreshCw />刷新</button></div>{loading ? <div className="table-state"><i className="loader-orbit" />正在加载检测记录…</div> : error ? <div className="table-state error"><FileSearch />{error}<button onClick={() => void load(page, { level, query })}>重试</button></div> : records.length === 0 ? <div className="table-state"><FileSearch />没有符合当前条件的检测记录</div> : <div className="table-wrap"><table><thead><tr><th>任务编号</th><th>检测时间</th><th>监测点位</th><th>类型</th><th>识别目标</th><th>污染等级</th><th>状态</th><th>操作</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td><strong className="id-cell">{record.id}</strong></td><td>{record.createdAt}</td><td>{record.location}</td><td><span className="type-chip">{record.type}</span></td><td><b>{record.objectCount}</b> 件</td><td><span className={`level-badge level-${record.level}`}>{record.level}</span></td><td><span className="status-complete"><i />{record.status}</span></td><td><button className="table-link" onClick={() => void openDetail(record)}>查看详情<ChevronRight /></button></td></tr>)}</tbody></table></div>}<footer className="table-footer"><span>共 {total} 条记录 · 第 {page}/{totalPages} 页</span><div className="pagination"><button disabled={page <= 1} onClick={() => goTo(page - 1)} aria-label="上一页"><ChevronLeft /></button>{pageNumbers(page, totalPages).map((item, index) => item === '…' ? <span key={`e-${index}`} className="page-ellipsis">…</span> : <button key={item} className={item === page ? 'active' : ''} onClick={() => goTo(item)}>{item}</button>)}<button disabled={page >= totalPages} onClick={() => goTo(page + 1)} aria-label="下一页"><ChevronRight /></button></div></footer></section>

    {detailLoading ? (
      <div className="detail-overlay"><div className="detail-modal"><div className="table-state"><i className="loader-orbit" />正在加载识别详情…</div></div></div>
    ) : detail && (
      <div className="detail-overlay" role="dialog" aria-modal="true" aria-label="识别详情" onClick={() => setDetail(null)}>
        <div className="detail-modal" onClick={(event) => event.stopPropagation()}>
          <header className="detail-modal-head">
            <div><span className="eyebrow"><i /> RECOGNITION DETAIL</span><h3>{detailType === '视频' ? '识别详情 · 视频回放' : '识别详情'}</h3></div>
            <button className="detail-close" onClick={() => setDetail(null)} aria-label="关闭详情"><X /></button>
          </header>
          <div className="detail-modal-body">
            {detailError ? (
              <div className="table-state error"><FileSearch />{detailError}<button onClick={() => detailRecord && void openDetail(detailRecord)}>重试</button></div>
            ) : detailType === '视频' ? (
              <VideoResultCard fileName={detail.fileName} status={null} result={detail} />
            ) : (
              <ImageDetailCard detail={detail} />
            )}
          </div>
          <footer className="detail-modal-foot">
            {reportError && <div className="inline-error"><AlertCircle />{reportError}</div>}
            <button className="secondary-button" onClick={() => setDetail(null)}>关闭</button>
            <button className="primary-button" disabled={creatingReport} onClick={createDetailReport}>
              {creatingReport ? <LoaderCircle className="spin" /> : <FileText />}生成质量评估报告
            </button>
          </footer>
        </div>
      </div>
    )}
  </div>;
}
