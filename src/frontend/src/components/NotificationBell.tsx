import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  BellRing,
  Check,
  CheckCircle2,
  FileBarChart,
  LoaderCircle,
  RefreshCw,
  Trash2,
  UserRoundPlus,
  XCircle,
} from 'lucide-react';
import type { PageKey } from '../types';
import {
  ADMIN_FOCUS_EVENT,
  ADMIN_FOCUS_TAB_KEY,
  deleteNotif,
  deleteReadNotifs,
  DETECTION_REFRESH_EVENT,
  getNotifications,
  markAllNotifRead,
  markNotifRead,
  PERMISSIONS_CHANGED_EVENT,
  subscribeNotifications,
  type NotifItem,
} from '../services/notifications';

const TYPE_META: Record<string, { icon: typeof Bell; tint: string }> = {
  task_completed: { icon: CheckCircle2, tint: '#2ee6a8' },
  task_failed: { icon: XCircle, tint: '#ff6885' },
  report_ready: { icon: FileBarChart, tint: '#38bdf8' },
  pollution_warning: { icon: AlertTriangle, tint: '#fbbf24' },
  group_change_request: { icon: UserRoundPlus, tint: '#a78bfa' },  // 换组申请（发给最高管理员）
  group_change_approved: { icon: CheckCircle2, tint: '#2ee6a8' },  // 申请已批准（发给申请人）
  group_change_rejected: { icon: XCircle, tint: '#ff6885' },       // 申请被驳回（发给申请人）
};
const TYPE_FALLBACK = { icon: Bell, tint: '#38bdf8' };

function timeAgo(value: string): string {
  if (!value) return '';
  const time = Date.parse(value.replace(' ', 'T'));
  if (Number.isNaN(time)) return value.slice(5, 16);
  const diff = Math.max(0, Date.now() - time);
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  if (diff < 48 * 60 * minute) return '昨天';
  return value.slice(5, 16).replace('-', '/');
}

export function NotificationBell({
  onSearchJump,
  onNavigate,
}: {
  onSearchJump: (target: { page: 'history' | 'reports'; query: string; reportId?: string }) => void;
  /** 业务页直接跳转（换组申请通知 → 后台管理 / 个人中心） */
  onNavigate?: (page: PageKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotifItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // SSE 订阅：init 快照定基 → 增量实时补；卸载时断开
  useEffect(() => {
    let alive = true;
    const unsubscribe = subscribeNotifications(
      (payload) => {
        setOffline(false);
        if (payload.type === 'permissions_changed') {
          // 权限瞬时事件：不属于铃铛消息，转成 window 事件由 App 重拉当前用户（功能入口即时更新）
          window.dispatchEvent(new CustomEvent(PERMISSIONS_CHANGED_EVENT));
          return;
        }
        if (payload.type === 'init') {
          setItems((payload.items ?? []).slice(0, 20));
          setUnreadCount(payload.unreadCount);
          setLoading(false);
        } else if (payload.type === 'notification' && payload.item) {
          setItems((prev) => [payload.item as NotifItem, ...prev.filter((n) => n.id !== (payload.item as NotifItem).id)].slice(0, 20));
          setUnreadCount(payload.unreadCount);
          const ntype = payload.item.type;
          // 检测任务完成/失败：转发给在途的检测历史页实时刷新列表，避免任务完成后仍需手动刷新
          if (ntype === 'task_completed' || ntype === 'task_failed') {
            window.dispatchEvent(new CustomEvent(DETECTION_REFRESH_EVENT, { detail: { taskId: payload.item.refId ?? null } }));
          }
        }
      },
      () => {
        if (alive) setOffline(true);
      },
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  // 外点关闭
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  const refresh = async () => {
    setLoading(true);
    try {
      const snap = await getNotifications();
      setItems(snap.items.slice(0, 20));
      setUnreadCount(snap.unreadCount);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => setOpen((prev) => {
    if (!prev) void refresh();
    return !prev;
  });

  const openItem = async (item: NotifItem) => {
    if (!item.isRead) {
      setUnreadCount((c) => Math.max(0, c - 1));
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, isRead: true } : n)));
      markNotifRead(item.id).catch(() => {});
    }
    setOpen(false);
    // 换组申请类通知直达对应页面（管理员 → 后台审批，申请人 → 个人中心看结果）
    if ((item.linkPage === 'admin' || item.linkPage === 'profile') && onNavigate) {
      // 换组申请：直达后台「换组审批」标签页。后台页可能尚未挂载（先存 sessionStorage，
      // 由 AdminPage 初始读取消费）或已打开（window 事件即时切换）。
      if (item.linkPage === 'admin' && item.type === 'group_change_request') {
        window.sessionStorage.setItem(ADMIN_FOCUS_TAB_KEY, 'requests');
        window.dispatchEvent(new CustomEvent(ADMIN_FOCUS_EVENT));
      }
      onNavigate(item.linkPage);
      return;
    }
    onSearchJump({
      page: item.linkPage === 'reports' ? 'reports' : 'history',
      query: '',
      reportId: item.linkPage === 'reports' && item.refId != null ? String(item.refId) : undefined,
    });
  };

  const deleteItem = async (item: NotifItem) => {
    const removed = item.isRead ? 0 : 1;
    setItems((prev) => prev.filter((n) => n.id !== item.id));
    if (removed) setUnreadCount((c) => Math.max(0, c - removed));
    try {
      await deleteNotif(item.id);
    } catch {
      void refresh(); // 失败回滚：从服务端重新同步
    }
  };

  const deleteRead = async () => {
    setItems((prev) => prev.filter((n) => !n.isRead));
    try {
      await deleteReadNotifs();
    } catch {
      void refresh(); // 失败回滚：从服务端重新同步
    }
  };

  const readAll = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    try {
      await markAllNotifRead();
    } catch { /* 标记失败下次打开会再次刷新 */ }
  };

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        className="icon-button"
        aria-label={unreadCount > 0 ? `消息通知（${unreadCount} 条未读）` : '消息通知'}
        aria-expanded={open}
        onClick={toggle}
      >
        {unreadCount > 0 ? <BellRing size={19} /> : <Bell size={19} />}
        {offline && <i className="notif-offline" />}
        {unreadCount > 0 && <em className="notif-badge">{unreadCount > 99 ? '99+' : unreadCount}</em>}
      </button>

      {open && (
        <div className="notif-panel" role="region" aria-label="通知列表">
          <header className="notif-head">
            <div><strong>消息通知</strong><span>{offline ? '连接已断开，重连中…' : items.length ? `${unreadCount} 条未读` : '暂无消息'}</span></div>
            <div className="notif-head-actions">
              <button className="notif-action" onClick={() => void readAll()} disabled={unreadCount === 0}><Check size={13} />全部已读</button>
              <button className="notif-action danger" onClick={() => void deleteRead()} disabled={!items.some((n) => n.isRead)} title="删除所有已读通知"><Trash2 size={13} />删除已读</button>
            </div>
          </header>

          {loading ? (
            <div className="notif-state"><LoaderCircle className="spin" />正在加载通知…</div>
          ) : offline ? (
            <div className="notif-state">
              <p>实时连接中断，已自动重连</p>
              <button className="ghost-button" onClick={() => { setOffline(false); void refresh(); }}><RefreshCw size={13} />重试</button>
            </div>
          ) : items.length === 0 ? (
            <div className="notif-state"><Bell size={22} /><p>暂无通知</p></div>
          ) : (
            <ul className="notif-list">
              {items.map((item) => {
                const meta = TYPE_META[item.type] ?? TYPE_FALLBACK;
                const Icon = meta.icon;
                return (
                  <li key={item.id} className="notif-li">
                    <button className={`notif-item ${item.isRead ? '' : 'unread'}`} onClick={() => void openItem(item)}>
                      <span className="notif-icon" style={{ background: `${meta.tint}1f`, color: meta.tint }}>
                        <Icon size={16} />
                      </span>
                      <span className="notif-main">
                        <strong>{item.title}</strong>
                        {item.body && <p>{item.body}</p>}
                        <time>{timeAgo(item.createdAt)}</time>
                      </span>
                      {!item.isRead && <i className="notif-dot" />}
                    </button>
                    <button
                      className="notif-del"
                      aria-label={`删除通知：${item.title}`}
                      title="删除此通知"
                      onClick={() => void deleteItem(item)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}