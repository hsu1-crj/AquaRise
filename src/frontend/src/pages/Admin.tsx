import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Boxes,
  Check,
  Database,
  FileBarChart,
  KeyRound,
  LayoutGrid,
  LoaderCircle,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  UserRound,
  UserRoundPlus,
  Users,
  X,
} from 'lucide-react';
import { adminApi, clearStoredAuth } from '../services/api';
import type { AdminGroup, AdminOverview, AdminUserRow, GroupSwitchRequestInfo, ModuleMeta, UserInfo } from '../types';

/** 模块中文名兜底表（接口失败时矩阵仍可渲染） */
const FALLBACK_MODULES: ModuleMeta[] = [
  { key: 'dashboard', name: '态势总览', desc: '' },
  { key: 'ocean3d_monitor', name: '海洋 3D · 监测模式', desc: '' },
  { key: 'ocean3d_science', name: '海洋 3D · 科普模式', desc: '' },
  { key: 'detection', name: '智能识别', desc: '' },
  { key: 'history', name: '检测历史', desc: '' },
  { key: 'analysis', name: '污染分析', desc: '' },
  { key: 'screen', name: '指挥大屏', desc: '' },
  { key: 'reports', name: '质量报告', desc: '' },
  { key: 'assistant', name: '海洋守护者', desc: '' },
  { key: 'atlas', name: '海瞳 · 生命图谱', desc: '' },
  { key: 'admin', name: '后台管理', desc: '' },
];

/* ============ 项目风格弹窗（替代浏览器原生 confirm/prompt/alert，页面居中、风格统一） ============ */

interface ConfirmDialogOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  /** 危险操作（删除/注销/设为超管）：确认按钮与图标用珊瑚色强调 */
  danger?: boolean;
}

function ConfirmDialog({ title, message, confirmLabel = '确认', danger, onSettle }: ConfirmDialogOptions & { onSettle: (confirmed: boolean) => void }) {
  return (
    <div className="admin-confirm-mask" role="presentation" onClick={() => onSettle(false)}>
      <div className="admin-confirm-modal" role="dialog" aria-modal="true" aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') onSettle(false); }}
        tabIndex={-1} ref={(el) => el?.focus()}>
        <div className={`admin-confirm-icon${danger ? '' : ' info'}`}>{danger ? <ShieldAlert size={26} /> : <ShieldCheck size={26} />}</div>
        <h3>{title}</h3>
        {message && <p>{message}</p>}
        <footer>
          <button className="ghost-button" onClick={() => onSettle(false)}>取消</button>
          <button className={`primary-button${danger ? ' admin-confirm-danger' : ''}`} onClick={() => onSettle(true)}>{confirmLabel}</button>
        </footer>
      </div>
    </div>
  );
}

/** 确认弹窗驱动 hook：open() 返回 Promise<boolean>，弹窗点确认/取消/遮罩/Esc 时结算 */
function useConfirmDialog() {
  const [options, setOptions] = useState<ConfirmDialogOptions | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const open = (opts: ConfirmDialogOptions) => new Promise<boolean>((resolve) => {
    resolverRef.current = resolve;
    setOptions(opts);
  });
  const settle = (confirmed: boolean) => {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
    setOptions(null);
  };
  const dialog = options ? <ConfirmDialog {...options} onSettle={settle} /> : null;
  return { open, dialog };
}

interface PromptDialogOptions {
  title: string;
  message?: string;
  placeholder?: string;
  /** 输入最小长度（trim 后）；不满足时弹窗内联报错，不关闭 */
  minLength?: number;
  minLengthError?: string;
  confirmLabel?: string;
}

function PromptDialog({ title, message, placeholder, minLength, minLengthError, confirmLabel = '确认', onSettle }: PromptDialogOptions & { onSettle: (value: string | null) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const submit = () => {
    const trimmed = value.trim();
    if (minLength != null && trimmed.length < minLength) {
      setError(minLengthError ?? `至少 ${minLength} 个字符`);
      return;
    }
    onSettle(trimmed);
  };
  return (
    <div className="admin-confirm-mask" role="presentation" onClick={() => onSettle(null)}>
      <div className="admin-confirm-modal" role="dialog" aria-modal="true" aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') onSettle(null); }}>
        <h3>{title}</h3>
        {message && <p>{message}</p>}
        <input className="admin-confirm-input" type="password" autoFocus value={value} placeholder={placeholder}
          onChange={(event) => { setValue(event.target.value); setError(''); }}
          onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} />
        {error && <div className="admin-confirm-error" role="alert">{error}</div>}
        <footer>
          <button className="ghost-button" onClick={() => onSettle(null)}>取消</button>
          <button className="primary-button" onClick={submit}>{confirmLabel}</button>
        </footer>
      </div>
    </div>
  );
}

/** 输入弹窗驱动 hook：open() 返回 Promise<string | null>（取消为 null，确认为 trim 后的输入） */
function usePromptDialog() {
  const [options, setOptions] = useState<PromptDialogOptions | null>(null);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);
  const open = (opts: PromptDialogOptions) => new Promise<string | null>((resolve) => {
    resolverRef.current = resolve;
    setOptions(opts);
  });
  const settle = (value: string | null) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOptions(null);
  };
  const dialog = options ? <PromptDialog {...options} onSettle={settle} /> : null;
  return { open, dialog };
}

type AdminTab = 'overview' | 'users' | 'groups' | 'requests';

interface AdminPageProps {
  user?: UserInfo | null;
}


export function AdminPage({ user }: AdminPageProps) {
  const [tab, setTab] = useState<AdminTab>('overview');

  const tabs: Array<{ id: AdminTab; label: string; icon: typeof LayoutGrid }> = [
    { id: 'overview', label: '概览', icon: LayoutGrid },
    { id: 'users', label: '用户管理', icon: Users },
    { id: 'groups', label: '用户组管理', icon: Boxes },
    { id: 'requests', label: '换组审批', icon: UserRoundPlus },
  ];

  return (
    <div className="page-stack">
      <section className="page-heading compact">
        <div>
          <span className="eyebrow"><i /> ADMIN CONSOLE</span>
          <h1>后台管理</h1>
          <p>用户与用户组管理：按职能把功能模块下放给不同用户组，用户归组即获得对应功能。</p>
        </div>
        <span className="admin-console-badge"><ShieldCheck size={16} />{user?.group_name ?? '管理员'} 控制台</span>
      </section>

      <div className="admin-tabs" role="tablist" aria-label="后台管理分区">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`admin-tab ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'users' && <UsersTab currentUserId={user?.id ?? -1} />}
      {tab === 'groups' && <GroupsTab />}
      {tab === 'requests' && <RequestsTab />}
    </div>
  );
}


/* ============ 概览 ============ */
function OverviewTab() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    adminApi.getOverview()
      .then(setData)
      .catch((reason: Error) => setError(reason.message || '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const stats = data ? [
    { label: '系统用户', value: data.user_count, icon: Users, tint: 'cyan' },
    { label: '用户组', value: data.group_count, icon: Boxes, tint: 'violet' },
    { label: '检测任务', value: `${data.completed_task_count}/${data.task_count}`, icon: Database, tint: 'green' },
    { label: '质量报告', value: data.report_count, icon: FileBarChart, tint: 'amber' },
  ] : [];
  const maxMembers = Math.max(1, ...(data?.group_members.map((g) => g.member_count) ?? [1]));

  return (
    <div className="admin-overview">
      {loading && <div className="page-state glass"><LoaderCircle className="spin" />正在加载后台概览…</div>}
      {!loading && error && (
        <div className="page-state glass">
          <p>{error}</p>
          <button className="ghost-button" onClick={load}><RefreshCw size={14} />重试</button>
        </div>
      )}
      {!loading && !error && data && (
        <>
          <div className="admin-stat-grid">
            {stats.map(({ label, value, icon: Icon, tint }) => (
              <div key={label} className={`panel glass admin-stat tint-${tint}`}>
                <Icon size={20} />
                <div><strong>{value}</strong><span>{label}</span></div>
              </div>
            ))}
          </div>
          <div className="admin-overview-grid">
            <section className="panel glass admin-panel">
              <header><Users size={17} /><div><h2>用户组规模</h2><span>各用户组成员分布（把用户划入组即下放对应功能）</span></div></header>
              {data.group_members.length === 0 ? <div className="admin-empty">暂无用户组</div> : (
                <div className="admin-member-bars">
                  {data.group_members.map((g) => (
                    <div key={g.id} className="admin-member-row">
                      <span className="admin-member-name" title={g.description ?? ''}>{g.name}{g.is_system && <em>内置</em>}</span>
                      <div className="admin-member-bar"><i style={{ width: `${Math.round((g.member_count / maxMembers) * 100)}%` }} /></div>
                      <b>{g.member_count} 人 · {g.modules.length} 模块</b>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="panel glass admin-panel">
              <header><UserRound size={17} /><div><h2>最近注册</h2><span>最新的用户账号与所属用户组</span></div></header>
              {data.recent_users.length === 0 ? <div className="admin-empty">暂无用户</div> : (
                <table className="admin-mini-table">
                  <thead><tr><th>用户</th><th>用户组</th><th>注册时间</th></tr></thead>
                  <tbody>
                    {data.recent_users.map((u) => (
                      <tr key={u.id}>
                        <td><strong>{u.username}</strong>{u.is_super_admin && <span className="admin-lock-badge"><Lock size={11} />超管</span>}</td>
                        <td>{u.group_name ?? '未分组'}</td>
                        <td>{u.created_at?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}


/* ============ 用户管理 ============ */
function UsersTab({ currentUserId }: { currentUserId: number }) {
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [notice, setNotice] = useState('');
  // 新建用户表单
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', email: '', groupId: 0 });
  const [formError, setFormError] = useState('');
  const [formBusy, setFormBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      adminApi.getUsers({ query, groupId: groupFilter ? Number(groupFilter) : undefined }),
      adminApi.getGroups(),
    ])
      .then(([users, groupList]) => {
        setRows(users.items);
        setGroups(groupList);
        setForm((prev) => ({ ...prev, groupId: prev.groupId || groupList.find((g) => g.code !== 'super_admin')?.id || groupList[0]?.id || 0 }));
      })
      .catch((reason: Error) => setError(reason.message || '加载失败'))
      .finally(() => setLoading(false));
  }, [query, groupFilter]);

  useEffect(load, [load]);
  /** 调组：立即生效（后端按组实时计算权限，用户下次请求即受新权限约束）。
      设为超级管理员组前二次确认：一旦设为其分组再也无法改变（返回 false 表示已取消，调用方还原下拉框）。
      所有二次确认/输入均走项目风格居中弹窗（替代浏览器原生 confirm/prompt/alert） */
  const { open: confirmDialog, dialog: confirmModal } = useConfirmDialog();
  const { open: promptDialog, dialog: promptModal } = usePromptDialog();

  const changeGroup = async (row: AdminUserRow, groupId: number): Promise<boolean> => {
    setNotice('');
    const target = groups.find((g) => g.id === groupId);
    if (target?.code === 'super_admin') {
      const confirmed = await confirmDialog({
        title: '确认设为超级管理员？',
        message: `即将把「${row.username}」设置为超级管理员。设置后该账号的分组再也无法改变（不可调组、不可注销，密码仅本人可修改），请谨慎操作。`,
        confirmLabel: '确认设置',
        danger: true,
      });
      if (!confirmed) return false;
    }
    try {
      const updated = await adminApi.updateUser(row.id, { group_id: groupId });
      setRows((prev) => prev.map((r) => (r.id === row.id ? updated : r)));
      setNotice(`已把 ${row.username} 调整到「${updated.group_name}」，其可用功能即时生效`);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '调组失败');
      return false;
    }
  };

  const resetPassword = async (row: AdminUserRow) => {
    const next = await promptDialog({
      title: `重置「${row.username}」的密码`,
      message: '为该账号设置新密码（至少 6 位）。重置后该账号将全部下线，需重新登录。',
      placeholder: '输入新密码',
      minLength: 6,
      minLengthError: '密码至少 6 位',
      confirmLabel: '确认重置',
    });
    if (next === null) return;
    try {
      const { message } = await adminApi.resetPassword(row.id, next);
      setNotice(`${message}（该账号已全部下线，需重新登录）`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重置失败');
    }
  };

  const deleteUser = async (row: AdminUserRow) => {
    const self = row.id === currentUserId;
    const confirmed = await confirmDialog({
      title: self ? `确认注销自己的账号「${row.username}」？` : `确认注销「${row.username}」？`,
      message: self ? '销号后将立即退出登录，名下数据一并删除，不可恢复。' : '其名下的检测任务、报告与对话记录将一并删除，不可恢复。',
      confirmLabel: '确认注销',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const { message } = await adminApi.deleteUser(row.id);
      if (self) {
        // 注销自己：清空本地登录态并回到登录页（token 对应的用户已不存在）
        clearStoredAuth();
        window.location.hash = '';
        window.location.reload();
        return;
      }
      setNotice(message);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '注销失败');
    }
  };

  const submitCreate = async () => {
    setFormError('');
    if (form.username.trim().length < 2) { setFormError('用户名至少 2 个字符'); return; }
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(form.username.trim())) { setFormError('用户名仅支持字母、数字、下划线或中文（不含 - 等符号）'); return; }
    if (form.password.length < 6) { setFormError('密码至少 6 位'); return; }
    if (!form.groupId) { setFormError('请选择用户组'); return; }
    setFormBusy(true);
    try {
      await adminApi.createUser({
        username: form.username.trim(),
        password: form.password,
        email: form.email.trim() || null,
        group_id: form.groupId,
      });
      setCreating(false);
      setForm({ username: '', password: '', email: '', groupId: form.groupId });
      setNotice(`已创建用户并划入所选用户组`);
      load();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : '创建失败');
    } finally {
      setFormBusy(false);
    }
  };

  return (
    <div className="admin-users">
      <div className="panel glass admin-panel">
        <div className="admin-toolbar">
          <label className="admin-search"><Search size={14} /><input
            value={query}
            placeholder="搜索用户名 / 邮箱…"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索用户"
          /></label>
          <label className="admin-select">用户组
            <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} aria-label="按用户组过滤">
              <option value="">全部用户组</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}（{g.member_count}）</option>)}
            </select>
          </label>
          <span className="admin-toolbar-spacer" />
          <button className="ghost-button" onClick={load}><RefreshCw size={14} />刷新</button>
          <button className="primary-button" onClick={() => setCreating((open) => !open)}>
            {creating ? <X size={14} /> : <UserPlus size={14} />}{creating ? '取消新建' : '新建用户'}
          </button>
        </div>

        {creating && (
          <div className="admin-create-form">
            <div className="form-grid">
              <label>用户名<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="2-50 位字母/数字/下划线/中文" /></label>
              <label>初始密码<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="至少 6 位，创建后可自行修改" autoComplete="new-password" /></label>
              <label>电子邮箱<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="选填" /></label>
              <label>所属用户组
                <select value={form.groupId} onChange={(event) => setForm({ ...form, groupId: Number(event.target.value) })}>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
            </div>
            <footer>
              {formError && <span className="admin-form-error">{formError}</span>}
              {form.groupId === groups.find((g) => g.code === 'super_admin')?.id && (
                <span className="admin-form-error">提示：超级管理员组成员即成为最高管理员（不可注销、不可调组），请确认后再创建</span>
              )}
              <button className="primary-button" onClick={submitCreate} disabled={formBusy}>
                {formBusy ? '创建中…' : <><Save size={14} />创建用户</>}
              </button>
            </footer>
          </div>
        )}

        {notice && <div className="admin-notice"><Check size={14} />{notice}</div>}
        {error && !loading && <div className="admin-notice error"><X size={14} />{error}</div>}
        {loading && <div className="page-state"><LoaderCircle className="spin" />正在加载用户…</div>}
        {!loading && (
          <div className="table-wrap admin-table-wrap">
            <table>
              <thead>
                <tr><th>用户</th><th>所属用户组（职能）</th><th>可用模块</th><th>联系方式</th><th>注册时间</th><th>操作</th></tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={6} className="admin-empty">没有匹配的用户</td></tr>}
                {rows.map((row) => {
                  const self = row.id === currentUserId;
                  const locked = row.is_super_admin;
                  return (
                    <tr key={row.id} className={self ? 'admin-row-self' : ''}>
                      <td>
                        <div className="admin-user-cell">
                          <strong>{row.username}</strong>
                          {self && <span className="admin-tag tag-self">本人</span>}
                          {locked && <span className="admin-lock-badge"><Lock size={11} />最高管理员</span>}
                        </div>
                      </td>
                      <td>
                        {locked ? (
                          <span className="admin-group-name">{row.group_name}</span>
                        ) : (
                          <select
                            className="admin-group-select"
                            value={row.group_id ?? ''}
                            onChange={(event) => {
                              const nextId = Number(event.target.value);
                              void changeGroup(row, nextId).then((applied) => {
                                // 取消/失败的调组：还原下拉框到原分组（受控值未变，DOM 已被用户改动）
                                if (!applied) event.target.value = String(row.group_id ?? '');
                              });
                            }}
                            aria-label={`调整 ${row.username} 的用户组`}
                          >
                            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                        )}
                      </td>
                      <td><span className="admin-module-count" title={(row.permissions ?? []).join('、')}>{row.permissions?.length ?? 0} 个</span></td>
                      <td>{row.email ?? row.phone_num ?? '—'}</td>
                      <td>{row.created_at?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                      <td>
                        <div className="admin-row-actions">
                          <button className="admin-action" onClick={() => resetPassword(row)} disabled={locked || self} title={locked ? '最高管理员密码仅可由本人修改' : self ? '请前往个人中心修改自己的密码' : '重置密码'}><KeyRound size={14} />重置密码</button>
                          <button className="admin-action danger" onClick={() => deleteUser(row)} disabled={locked} title={locked ? '最高管理员账号不可注销' : self ? '将注销自己的账号并退出登录' : '注销该账号'}><Trash2 size={14} />注销</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="admin-hint">保护规则：只有最高管理员（种子 admin 与超级管理员组成员）不可被注销、不可调组、密码仅由本人修改；其余账号均可注销——包括注销自己（销号后自动退出登录）。</p>
      </div>
      {/* 二次确认/输入弹窗：项目风格居中渲染（替代浏览器原生 confirm/prompt/alert） */}
      {confirmModal}
      {promptModal}
    </div>
  );
}


/* ============ 用户组管理 ============ */
function GroupsTab() {
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [modules, setModules] = useState<ModuleMeta[]>(FALLBACK_MODULES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<{ name: string; description: string; modules: string[] }>({ name: '', description: '', modules: [] });
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState({ name: '', description: '', modules: [] as string[] });

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([adminApi.getGroups(), adminApi.getModules().catch(() => FALLBACK_MODULES)])
      .then(([groupList, moduleList]) => { setGroups(groupList); setModules(moduleList); })
      .catch((reason: Error) => setError(reason.message || '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const startEdit = (group: AdminGroup) => {
    setNotice('');
    setEditingId(group.id);
    setEditDraft({ name: group.name, description: group.description ?? '', modules: [...group.modules] });
  };

  const toggleEditModule = (key: string) =>
    setEditDraft((prev) => ({
      ...prev,
      modules: prev.modules.includes(key) ? prev.modules.filter((m) => m !== key) : [...prev.modules, key],
    }));

  const toggleCreateModule = (key: string) =>
    setCreateDraft((prev) => ({
      ...prev,
      modules: prev.modules.includes(key) ? prev.modules.filter((m) => m !== key) : [...prev.modules, key],
    }));

  const saveEdit = async (groupId: number) => {
    setBusy(true);
    setError('');
    try {
      const updated = await adminApi.updateGroup(groupId, {
        name: editDraft.name.trim(),
        description: editDraft.description.trim() || null,
        modules: editDraft.modules,
      });
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...updated, member_count: g.member_count } : g)));
      setEditingId(null);
      setNotice(`用户组「${updated.name}」已更新，组内成员权限即时生效`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async () => {
    setError('');
    if (createDraft.name.trim().length < 2) { setError('用户组名称至少 2 个字符'); return; }
    setBusy(true);
    try {
      const created = await adminApi.createGroup({
        name: createDraft.name.trim(),
        description: createDraft.description.trim() || null,
        modules: createDraft.modules,
      });
      setGroups((prev) => [...prev, created]);
      setCreating(false);
      setCreateDraft({ name: '', description: '', modules: [] });
      setNotice(`用户组「${created.name}」已创建，可在用户管理中把用户划入`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const { open: confirmDialog, dialog: confirmModal } = useConfirmDialog();

  const removeGroup = async (group: AdminGroup) => {
    const confirmed = await confirmDialog({
      title: `确认删除用户组「${group.name}」？`,
      message: '删除操作不可恢复，请谨慎操作。',
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await adminApi.deleteGroup(group.id);
      setGroups((prev) => prev.filter((g) => g.id !== group.id));
      setNotice(`已删除用户组「${group.name}」`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除失败');
    }
  };

  const moduleMatrix = (selected: string[], onToggle: (key: string) => void) => (
    <div className="admin-module-matrix">
      {modules.map((m) => (
        <label key={m.key} className={`admin-module-chip ${selected.includes(m.key) ? 'on' : ''}`}>
          <input type="checkbox" checked={selected.includes(m.key)} onChange={() => onToggle(m.key)} />
          <span>{m.name}</span>
          {selected.includes(m.key) && <Check size={12} />}
        </label>
      ))}
    </div>
  );

  return (
    <div className="admin-groups">
      <div className="admin-toolbar standalone">
        <span className="admin-toolbar-hint"><Boxes size={15} />一个用户组 = 一批功能模块。勾选即下放，用户归组后获得组内全部功能。</span>
        <span className="admin-toolbar-spacer" />
        <button className="ghost-button" onClick={load}><RefreshCw size={14} />刷新</button>
        <button className="primary-button" onClick={() => setCreating((open) => !open)}>
          {creating ? <X size={14} /> : <Plus size={14} />}{creating ? '取消' : '新建用户组'}
        </button>
      </div>

      {creating && (
        <div className="panel glass admin-panel admin-group-create">
          <header><Plus size={17} /><div><h2>新建用户组</h2><span>命名并勾选该组可用的功能模块</span></div></header>
          <div className="form-grid">
            <label>组名称<input value={createDraft.name} onChange={(event) => setCreateDraft({ ...createDraft, name: event.target.value })} placeholder="如：沿岸巡查组" /></label>
            <label>职能说明<input value={createDraft.description} onChange={(event) => setCreateDraft({ ...createDraft, description: event.target.value })} placeholder="该组的定位与职责（选填）" /></label>
          </div>
          <div className="admin-matrix-label">功能模块（勾选即下放）</div>
          {moduleMatrix(createDraft.modules, toggleCreateModule)}
          <footer>
            <span className="admin-form-error">{error && creating ? error : ''}</span>
            <button className="primary-button" onClick={submitCreate} disabled={busy}>{busy ? '创建中…' : <><Save size={14} />创建用户组</>}</button>
          </footer>
        </div>
      )}

      {notice && <div className="admin-notice"><Check size={14} />{notice}</div>}
      {error && !creating && !loading && <div className="admin-notice error"><X size={14} />{error}</div>}
      {loading && <div className="page-state glass"><LoaderCircle className="spin" />正在加载用户组…</div>}

      {!loading && (
        <div className="admin-group-grid">
          {groups.length === 0 && <div className="admin-empty panel glass">暂无用户组</div>}
          {groups.map((group) => {
            const editing = editingId === group.id;
            const immutable = group.code === 'super_admin';
            return (
              <section key={group.id} className={`panel glass admin-group-card ${immutable ? 'immutable' : ''}`}>
                <header>
                  <Boxes size={18} />
                  <div className="admin-group-head">
                    <h3>{group.name}</h3>
                    <span>{group.member_count} 名成员 · {group.modules.length} 个模块{group.is_system ? ' · 系统内置' : ''}</span>
                  </div>
                  {!editing && !immutable && (
                    <div className="admin-row-actions">
                      <button className="admin-action" onClick={() => startEdit(group)}>编辑</button>
                      <button className="admin-action danger" onClick={() => removeGroup(group)} disabled={group.is_system || group.member_count > 0} title={group.is_system ? '系统内置用户组不可删除' : group.member_count > 0 ? '组内仍有成员，请先移出' : '删除该用户组'}>删除</button>
                    </div>
                  )}
                  {immutable && <span className="admin-lock-badge"><Lock size={11} />内置保护</span>}
                </header>
                <p className="admin-group-desc">{group.description ?? '—'}</p>
                {!group.is_system && group.member_count > 0 && (
                  <p className="admin-group-member-hint">组内仍有 {group.member_count} 名成员，移出后方可删除</p>
                )}

                {editing ? (
                  <div className="admin-group-editor">
                    <div className="form-grid">
                      <label>组名称<input value={editDraft.name} onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })} /></label>
                      <label>职能说明<input value={editDraft.description} onChange={(event) => setEditDraft({ ...editDraft, description: event.target.value })} /></label>
                    </div>
                    <div className="admin-matrix-label">功能模块（勾选即下放）</div>
                    {moduleMatrix(editDraft.modules, toggleEditModule)}
                    <footer>
                      <button className="ghost-button" onClick={() => setEditingId(null)} disabled={busy}>取消</button>
                      <button className="primary-button" onClick={() => saveEdit(group.id)} disabled={busy}>{busy ? '保存中…' : <><Save size={14} />保存</>}</button>
                    </footer>
                  </div>
                ) : (
                  <div className="admin-module-matrix readonly">
                    {modules.map((m) => (
                      <span key={m.key} className={`admin-module-chip ${group.modules.includes(m.key) ? 'on' : 'off'}`}>
                        {group.modules.includes(m.key) ? <Check size={12} /> : <X size={12} />}{m.name}
                      </span>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      {/* 删除用户组二次确认弹窗 */}
      {confirmModal}
    </div>
  );
}


/* ============ 换组审批（个人中心申请 → 此处批准/驳回，双方收铃铛通知） ============ */
function RequestsTab() {
  const [items, setItems] = useState<GroupSwitchRequestInfo[]>([]);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'all'>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    adminApi.getGroupRequests(statusFilter)
      .then(setItems)
      .catch((reason: Error) => setError(reason.message || '加载失败'))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(load, [load]);

  const { open: confirmDialog, dialog: confirmModal } = useConfirmDialog();

  const handle = async (req: GroupSwitchRequestInfo, action: 'approve' | 'reject') => {
    setNotice('');
    setError('');
    if (action === 'approve' && !(await confirmDialog({
      title: `确认批准「${req.username}」加入「${req.to_group_name}」？`,
      message: '批准后其可用功能即时生效，双方均收到铃铛通知。',
      confirmLabel: '确认批准',
    }))) return;
    setBusyId(req.id);
    try {
      const { message } = action === 'approve'
        ? await adminApi.approveGroupRequest(req.id)
        : await adminApi.rejectGroupRequest(req.id);
      setNotice(`${message}（申请人已收到铃铛通知）`);
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="admin-users">
      <div className="panel glass admin-panel">
        <div className="admin-toolbar">
          <span className="admin-toolbar-hint"><UserRoundPlus size={15} />用户在个人中心提交的换组申请；批准后其可用功能即时生效，双方均收到铃铛通知。</span>
          <span className="admin-toolbar-spacer" />
          <label className="admin-select">状态
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'pending' | 'all')} aria-label="按状态过滤">
              <option value="pending">待审批</option>
              <option value="all">全部</option>
            </select>
          </label>
          <button className="ghost-button" onClick={load}><RefreshCw size={14} />刷新</button>
        </div>

        {notice && <div className="admin-notice"><Check size={14} />{notice}</div>}
        {error && !loading && <div className="admin-notice error"><X size={14} />{error}</div>}
        {loading && <div className="page-state"><LoaderCircle className="spin" />正在加载换组申请…</div>}
        {!loading && (
          <div className="table-wrap admin-table-wrap">
            <table>
              <thead>
                <tr><th>申请人</th><th>当前用户组</th><th>申请加入</th><th>申请理由</th><th>申请时间</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody>
                {items.length === 0 && <tr><td colSpan={7} className="admin-empty">{statusFilter === 'pending' ? '暂无待审批的换组申请' : '暂无换组申请记录'}</td></tr>}
                {items.map((req) => (
                  <tr key={req.id}>
                    <td><strong>{req.username ?? '—'}</strong></td>
                    <td>{req.from_group_name ?? '未分组'}</td>
                    <td><span className="admin-group-name">{req.to_group_name ?? '（组已删除）'}</span></td>
                    <td>{req.reason || '—'}</td>
                    <td>{req.created_at?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                    <td>
                      {req.status === 'pending'
                        ? <span className="admin-tag">待审批</span>
                        : req.status === 'approved'
                          ? <span className="admin-tag tag-self">已批准</span>
                          : <span className="admin-tag">已驳回</span>}
                    </td>
                    <td>
                      {req.status === 'pending' ? (
                        <div className="admin-row-actions">
                          <button className="admin-action" onClick={() => void handle(req, 'approve')} disabled={busyId === req.id}><Check size={14} />批准</button>
                          <button className="admin-action danger" onClick={() => void handle(req, 'reject')} disabled={busyId === req.id}><X size={14} />驳回</button>
                        </div>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {/* 批准换组申请二次确认弹窗 */}
      {confirmModal}
    </div>
  );
}
