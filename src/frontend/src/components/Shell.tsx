import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  AreaChart,
  Bell,
  Bot,
  ChevronDown,
  Clock3,
  Compass,
  FileBarChart,
  FileCheck2,
  FlaskConical,
  History,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Maximize2,
  Orbit,
  Menu,
  MonitorPlay,
  Radar,
  ScanLine,
  Search,
  ShieldCheck,
  Sparkles,
  UserRound,
  Waves,
  X,
} from 'lucide-react';
import type { DetectionRecord, PageKey, Report, UserInfo } from '../types';
import { api, isMockMode } from '../services/api';
import { HaitongLogo } from './HaitongLogo';
import { DigitalHumanIcon } from './DigitalHumanIcon';

interface ShellProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  /** 全局搜索跳转：携带查询词（及可选的目标报告）跳转到对应业务页 */
  onSearchJump: (target: { page: 'history' | 'reports'; query: string; reportId?: string }) => void;
  onLogout: () => void;
  user?: UserInfo | null;
  children: ReactNode;
}

const navGroups: Array<{
  title: string;
  items: Array<{ id: PageKey; label: string; icon: any; badge?: string }>;
}> = [
  {
    title: '监测中心',
    items: [
      { id: 'dashboard', label: '态势总览', icon: Compass },
      { id: 'ocean3d', label: '海洋 3D 态势', icon: Orbit },
      { id: 'detection', label: '智能识别', icon: ScanLine, badge: 'AI' },
      { id: 'history', label: '检测历史', icon: Clock3 },
    ],
  },
  {
    title: '研判与决策',
    items: [
      { id: 'analysis', label: '污染分析', icon: AreaChart },
      { id: 'screen', label: '指挥大屏', icon: MonitorPlay },
      { id: 'reports', label: '质量报告', icon: FileCheck2 },
    ],
  },
  {
    title: '智能服务',
    items: [
      { id: 'assistant', label: '海洋守护者', icon: DigitalHumanIcon, badge: '数字人' },
      { id: 'atlas', label: '海瞳 · 生命图谱', icon: HaitongLogo, badge: '3D' },
    ],
  },
];

export function Shell({ page, onNavigate, onSearchJump, onLogout, user, children }: ShellProps) {
  // ---- 全局搜索：输入防抖拉取检测任务与报告，下拉展示匹配结果，点击跳转对应页面 ----
  const [searchText, setSearchText] = useState('');
  const [taskHits, setTaskHits] = useState<DetectionRecord[]>([]);
  const [reportHits, setReportHits] = useState<Report[]>([]);
  const [searching, setSearching] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const searchTimer = useRef<number | null>(null);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 点击搜索框外或按 Esc 关闭下拉；按 ⌘/Ctrl+K 聚焦搜索框
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(event.target as Node)) setDropOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setDropOpen(false); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, []);

  const changeSearch = (value: string) => {
    setSearchText(value);
    const keyword = value.trim();
    if (!keyword) {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
      setTaskHits([]); setReportHits([]); setDropOpen(false);
      return;
    }
    setDropOpen(true); setSearching(true);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(async () => {
      try {
        // 检测任务走后端 query（编号/文件名），报告较少则全量拉取后前端过滤（标题/海域/编号/摘要）
        const [taskPage, reports] = await Promise.all([
          api.getHistory(1, 20, { query: keyword }).catch(() => ({ items: [], total: 0 })),
          api.getReports().catch(() => []),
        ]);
        const kw = keyword.toLowerCase();
        setTaskHits(taskPage.items);
        setReportHits(reports.filter((r) => [r.title, r.area, r.summary, r.id].some((f) => f?.toLowerCase().includes(kw))).slice(0, 5));
      } catch { /* 搜索失败静默，不阻塞页面 */ }
      finally { setSearching(false); }
    }, 250);
  };

  const jumpSearch = (page: 'history' | 'reports', reportId?: string) => {
    setDropOpen(false); setSearchText('');
    onSearchJump({ page, query: searchText.trim(), reportId });
  };

  return (
    <div className="app-shell">
      <div className="ocean-ambient" aria-hidden="true"><i /><i /><i /></div>
      <input className="nav-toggle" type="checkbox" id="nav-toggle" aria-label="切换导航" />
      <aside className="sidebar glass-strong">
        <div className="brand">
          <div className="brand-mark">
            <HaitongLogo size={26} />
            <span className="brand-radar-ring" />
          </div>
          <div className="brand-meta">
            <div className="brand-name-wrap">
              <strong>海瞳</strong>
              <span className="brand-sub-name">HAITONG</span>
              <span className="brand-badge-pro">PRO</span>
            </div>
            <span className="brand-tagline">海洋全域智守平台</span>
          </div>
          <label htmlFor="nav-toggle" className="nav-close" aria-label="关闭导航"><X size={16} /></label>
        </div>
        <div className="project-pill"><span className="live-dot" />渤海近岸监测项目<ChevronDown size={14} /></div>
        <nav aria-label="主导航">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.title}>
              <div className="nav-caption">{group.title}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${page === item.id ? 'active' : ''} ${item.id === 'atlas' ? 'nav-item-atlas' : ''} ${item.id === 'assistant' ? 'nav-item-assistant' : ''}`}
                    onClick={() => onNavigate(item.id)}
                  >
                    <Icon
                      size={20}
                      className={
                        item.id === 'atlas'
                          ? 'nav-atlas-icon'
                          : item.id === 'assistant'
                          ? 'nav-assistant-icon'
                          : ''
                      }
                    />
                    <span>{item.label}</span>
                    {item.badge && (
                      <b
                        className={`nav-badge ${item.badge === '3D' ? 'badge-3d' : item.badge === '数字人' ? 'badge-human' : ''}`}
                        style={
                          item.badge === '3D'
                            ? {
                                background: 'linear-gradient(135deg, #38f8d4, #1be7ff)',
                                color: '#011928',
                                fontWeight: 800,
                                boxShadow: '0 0 10px rgba(56, 248, 212, 0.4)',
                              }
                            : item.badge === '数字人'
                            ? {
                                background: 'linear-gradient(135deg, #5cf2ae, #2bdcff)',
                                color: '#011e2b',
                                fontWeight: 800,
                                fontSize: '9px',
                                padding: '1px 5px',
                                borderRadius: '4px',
                                boxShadow: '0 0 10px rgba(92, 242, 174, 0.35)',
                              }
                            : undefined
                        }
                      >
                        {item.badge}
                      </b>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className={`nav-item ${page === 'profile' ? 'active' : ''}`} onClick={() => onNavigate('profile')}><UserRound size={19} /><span>个人中心</span></button>
          <button className="nav-item" onClick={onLogout}><LogOut size={19} /><span>退出登录</span></button>
          <div className="system-health"><ShieldCheck size={18} /><div><strong>系统运行正常</strong><span>全部服务在线</span></div><em>99.9%</em></div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar glass">
          <label htmlFor="nav-toggle" className="menu-button" aria-label="打开导航"><Menu /></label>
          <div className="search-box" ref={searchBoxRef}><Search size={18} /><input ref={searchInputRef} aria-label="全局搜索" placeholder="搜索检测任务、海域或报告…" value={searchText} onChange={(event) => changeSearch(event.target.value)} onFocus={() => searchText.trim() && setDropOpen(true)} /><kbd>⌘ K</kbd>{dropOpen && <div className="search-results" role="listbox">{searching ? <div className="search-status"><LoaderCircle className="spin" />搜索中…</div> : taskHits.length === 0 && reportHits.length === 0 ? <div className="search-status">没有匹配的检测任务或报告</div> : <>{taskHits.length > 0 && <><div className="search-group">检测任务</div>{taskHits.slice(0, 6).map((item) => <button key={item.id} className="search-item" role="option" onClick={() => jumpSearch('history')}><History size={15} /><span><strong>{item.id}</strong><small>{item.createdAt} · {item.type} · {item.location} · {item.level}度</small></span></button>)}</>}{reportHits.length > 0 && <><div className="search-group">质量报告</div>{reportHits.map((item) => <button key={item.id} className="search-item" role="option" onClick={() => jumpSearch('reports', item.id)}><FileBarChart size={15} /><span><strong>{item.title}</strong><small>{item.area} · {item.createdAt.slice(0, 10)} · {item.level}度污染</small></span></button>)}</>}</>}</div>}</div>
          <div className="top-actions">
            {isMockMode() && <span className="demo-badge"><FlaskConical size={14} />演示数据</span>}
            <button className="icon-button" aria-label="消息通知"><Bell size={19} /><i /></button>
            <button className="user-chip" onClick={() => onNavigate('profile')}><span>{(user?.username ?? '林').slice(0, 1).toUpperCase()}</span><div><strong>{user?.username ?? '林海'}</strong><small>{user?.role === 'admin' ? '管理员' : '用户'}</small></div><ChevronDown size={15} /></button>
          </div>
        </header>
        <div className="page-container">{children}</div>
      </main>
    </div>
  );
}
