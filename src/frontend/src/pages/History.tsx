import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Download, FileSearch, Filter, RefreshCw, Search } from 'lucide-react';
import { api } from '../services/api';
import type { DetectionRecord } from '../types';

export function HistoryPage() {
  const [records, setRecords] = useState<DetectionRecord[]>([]);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('全部等级');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try { setRecords(await api.getHistory()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '加载失败'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => records.filter((record) => {
    const matchesQuery = `${record.id}${record.location}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (level === '全部等级' || record.level === level);
  }), [records, query, level]);

  const exportCsv = () => {
    const lines = ['任务编号,检测时间,监测点位,类型,目标数,污染等级,状态', ...filtered.map((item) => [item.id, item.createdAt, item.location, item.type, item.objectCount, item.level, item.status].join(','))];
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'aquarise-detection-history.csv'; link.click(); URL.revokeObjectURL(link.href);
  };

  return <div className="page-stack"><section className="page-heading compact"><div><span className="eyebrow"><i /> DETECTION ARCHIVE</span><h1>检测历史</h1><p>检索、筛选和导出所有水下影像识别任务。</p></div><button className="primary-button" onClick={exportCsv}><Download />导出当前结果</button></section><section className="panel glass data-panel"><div className="filter-bar"><label className="filter-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务编号或监测点位" /></label><label><Filter />污染等级<select value={level} onChange={(event) => setLevel(event.target.value)}><option>全部等级</option><option>优</option><option>良</option><option>中</option><option>差</option><option>严重</option></select></label><label><CalendarDays />时间范围<select><option>近 30 天</option><option>近 90 天</option><option>全部</option></select></label><button className="secondary-button" onClick={load}><RefreshCw />刷新</button></div>{loading ? <div className="table-state"><i className="loader-orbit" />正在加载检测记录…</div> : error ? <div className="table-state error"><FileSearch />{error}<button onClick={load}>重试</button></div> : filtered.length === 0 ? <div className="table-state"><FileSearch />没有符合当前条件的检测记录</div> : <div className="table-wrap"><table><thead><tr><th>任务编号</th><th>检测时间</th><th>监测点位</th><th>类型</th><th>识别目标</th><th>污染等级</th><th>状态</th><th>操作</th></tr></thead><tbody>{filtered.map((record) => <tr key={record.id}><td><strong className="id-cell">{record.id}</strong></td><td>{record.createdAt}</td><td>{record.location}</td><td><span className="type-chip">{record.type}</span></td><td><b>{record.objectCount}</b> 件</td><td><span className={`level-badge level-${record.level}`}>{record.level}</span></td><td><span className="status-complete"><i />{record.status}</span></td><td><button className="table-link">查看详情<ChevronRight /></button></td></tr>)}</tbody></table></div>}<footer className="table-footer"><span>共 {filtered.length} 条记录</span><div><button disabled><ChevronLeft /></button><button className="active">1</button><button disabled><ChevronRight /></button></div></footer></section></div>;
}
