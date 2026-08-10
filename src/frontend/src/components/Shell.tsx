import type { ReactNode } from 'react';
import {
  BarChart3,
  Bell,
  Bot,
  ChevronDown,
  FileBarChart,
  FlaskConical,
  History,
  LayoutDashboard,
  Library,
  LogOut,
  Maximize2,
  Menu,
  Radar,
  Search,
  ShieldCheck,
  UserRound,
  Waves,
  X,
} from 'lucide-react';
import type { PageKey, UserInfo } from '../types';
import { isMockMode } from '../services/api';

interface ShellProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  onLogout: () => void;
  user?: UserInfo | null;
  children: ReactNode;
}

const navGroups: Array<{ title: string; items: Array<{ id: PageKey; label: string; icon: typeof Waves }> }> = [
  { title: '监测中心', items: [
    { id: 'dashboard', label: '态势总览', icon: LayoutDashboard },
    { id: 'detection', label: '智能识别', icon: Radar },
    { id: 'history', label: '检测历史', icon: History },
  ] },
  { title: '研判与决策', items: [
    { id: 'analysis', label: '污染分析', icon: BarChart3 },
    { id: 'screen', label: '指挥大屏', icon: Maximize2 },
    { id: 'reports', label: '质量报告', icon: FileBarChart },
  ] },
  { title: '智能服务', items: [
    { id: 'assistant', label: '海洋守护者', icon: Bot },
    { id: 'knowledge', label: '知识库', icon: Library },
  ] },
];

export function Shell({ page, onNavigate, onLogout, user, children }: ShellProps) {
  return (
    <div className="app-shell">
      <div className="ocean-ambient" aria-hidden="true"><i /><i /><i /></div>
      <input className="nav-toggle" type="checkbox" id="nav-toggle" aria-label="切换导航" />
      <aside className="sidebar glass-strong">
        <div className="brand">
          <div className="brand-mark"><Waves size={27} /></div>
          <div><strong>AQUARISE</strong><span>海洋智守平台</span></div>
          <label htmlFor="nav-toggle" className="nav-close" aria-label="关闭导航"><X /></label>
        </div>
        <div className="project-pill"><span className="live-dot" />渤海近岸监测项目<ChevronDown size={14} /></div>
        <nav aria-label="主导航">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.title}>
              <div className="nav-caption">{group.title}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => onNavigate(item.id)}>
                    <Icon size={19} /><span>{item.label}</span>{item.id === 'detection' && <b>AI</b>}
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
          <div className="search-box"><Search size={18} /><input aria-label="全局搜索" placeholder="搜索检测任务、海域或报告…" /><kbd>⌘ K</kbd></div>
          <div className="top-actions">
            {isMockMode && <span className="demo-badge"><FlaskConical size={14} />演示数据</span>}
            <button className="icon-button" aria-label="消息通知"><Bell size={19} /><i /></button>
            <button className="user-chip" onClick={() => onNavigate('profile')}><span>{(user?.username ?? '林').slice(0, 1).toUpperCase()}</span><div><strong>{user?.username ?? '林海'}</strong><small>{user?.role === 'admin' ? '管理员' : '用户'}</small></div><ChevronDown size={15} /></button>
          </div>
        </header>
        <div className="page-container">{children}</div>
      </main>
    </div>
  );
}
