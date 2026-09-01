import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowRight, Camera, CheckCircle2, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, Waves } from 'lucide-react';
import type { FormEvent } from 'react';
import { Shell } from './components/Shell';
import { SeaAreaProvider } from './context/SeaAreaContext';
import { HaitongLogo } from './components/HaitongLogo';
import { adminApi, api, clearStoredAuth, getStoredToken, storeToken } from './services/api';
import { PERMISSIONS_CHANGED_EVENT } from './services/notifications';
import { useCamera } from './services/camera';
import { OCEAN3D_PAGE_KEYS } from './types';
import type { AdminGroup, PageKey, UserInfo } from './types';
const AnalysisPage = lazy(() => import('./pages/Analysis').then((module) => ({ default: module.AnalysisPage })));
const AssistantPage = lazy(() => import('./pages/Assistant').then((module) => ({ default: module.AssistantPage })));
const CommandScreen = lazy(() => import('./pages/CommandScreen').then((module) => ({ default: module.CommandScreen })));
const Dashboard = lazy(() => import('./pages/Dashboard').then((module) => ({ default: module.Dashboard })));
const Ocean3DPage = lazy(() => import('./pages/Ocean3D').then((module) => ({ default: module.Ocean3DPage })));
const Detection = lazy(() => import('./pages/Detection').then((module) => ({ default: module.Detection })));
const HistoryPage = lazy(() => import('./pages/History').then((module) => ({ default: module.HistoryPage })));
const ReportsPage = lazy(() => import('./pages/Reports').then((module) => ({ default: module.ReportsPage })));
const ProfilePage = lazy(() => import('./pages/UtilityPages').then((module) => ({ default: module.ProfilePage })));
const MarineAtlasPage = lazy(() => import('./pages/MarineAtlas').then((module) => ({ default: module.MarineAtlasPage })));
const AdminPage = lazy(() => import('./pages/Admin').then((module) => ({ default: module.AdminPage })));
const validPages: Record<PageKey, true> = { dashboard: true, ocean3d: true, detection: true, history: true, analysis: true, screen: true, reports: true, assistant: true, atlas: true, admin: true, profile: true };

/** 权限守卫的兜底跳转顺序：无权访问当前页时落到第一个有权限的业务页 */
const PAGE_FALLBACK_ORDER: PageKey[] = ['dashboard', 'ocean3d', 'detection', 'history', 'analysis', 'screen', 'reports', 'assistant', 'atlas', 'admin', 'profile'];
/** 超管分组模拟的会话内持久化 key（sessionStorage：关标签页即恢复真实视角） */
const SIM_GROUP_KEY = 'aquarise-sim-group';

/** 启动时是否已有登录态：本次会话标记存在，或本地存有 token（保持登录） */
function hasStoredAuth(): boolean {
  return (
    sessionStorage.getItem('aquarise-session') === 'active' ||
    !!getStoredToken()
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(hasStoredAuth);
  const [page, setPage] = useState<PageKey>(() => {
    const hash = window.location.hash.slice(1) as PageKey;
    return validPages[hash] ? hash : 'dashboard';
  });
  const [user, setUser] = useState<UserInfo | null>(null);
  // 全局搜索跳转：携带查询词（及可选目标报告）到业务页，页面挂载时据此过滤/打开
  const [searchFocus, setSearchFocus] = useState<{ page: 'history' | 'reports'; query: string; reportId?: string } | null>(null);
  // ============ 超管分组模拟：以所选用户组的视角查看站点（仅视图层降级，后端权限不变） ============
  const [simGroupId, setSimGroupId] = useState<number | null>(() => {
    const raw = window.sessionStorage.getItem(SIM_GROUP_KEY);
    return raw ? Number(raw) : null;
  });
  const [simGroups, setSimGroups] = useState<AdminGroup[]>([]);
  const isSuperAdmin = !!user && (user.role === 'admin' || user.group_code === 'super_admin');

  useEffect(() => {
    if (!isSuperAdmin) { setSimGroups([]); return; }
    adminApi.getGroups().then(setSimGroups).catch(() => setSimGroups([]));
  }, [isSuperAdmin]);

  const simGroup = simGroupId != null ? simGroups.find((g) => g.id === simGroupId) ?? null : null;
  /** 生效用户：模拟视角下把权限/分组替换为目标组（导航、页面守卫、3D 模式锁定随之降级） */
  const effectiveUser: UserInfo | null = user && simGroup
    ? { ...user, permissions: simGroup.modules, group_id: simGroup.id, group_code: simGroup.code, group_name: simGroup.name }
    : user;
  const simulate = (groupId: number | null) => {
    setSimGroupId(groupId);
    if (groupId == null) window.sessionStorage.removeItem(SIM_GROUP_KEY);
    else window.sessionStorage.setItem(SIM_GROUP_KEY, String(groupId));
  };

  useEffect(() => {
    if (!authenticated) { setUser(null); return; }
    api.getCurrentUser().then(setUser).catch(() => setUser(null));
    // 用户组权限被管理员调整（SSE 瞬时事件）或标签页回焦：重拉当前用户，让功能入口即时生效；
    // 静默失败——网络抖动不清空已有会话（401 由全局 handleUnauthorized 统一登出）。
    const refreshUser = () => { api.getCurrentUser().then(setUser).catch(() => {}); };
    const onVisibility = () => { if (document.visibilityState === 'visible') refreshUser(); };
    window.addEventListener(PERMISSIONS_CHANGED_EVENT, refreshUser);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener(PERMISSIONS_CHANGED_EVENT, refreshUser);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [authenticated]);

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.slice(1) as PageKey;
      if (validPages[hash]) setPage(hash);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // ============ 用户组权限守卫：无权访问当前页时，落到第一个有权限的页面 ============
  // 个人中心对全员开放；权限未加载完成（null/undefined）前不拦截。
  // 海洋 3D 页按模式键判定：拥有任一模式（ocean3d_monitor/science）即可进入。
  // 超管模拟视角下按被模拟组的权限生效（effectiveUser），顶栏下拉可随时退出模拟。
  useEffect(() => {
    if (!authenticated || !effectiveUser?.permissions) return;
    const allowed = (target: PageKey) =>
      target === 'profile'
      || (target === 'ocean3d'
        ? effectiveUser.permissions!.some((p) => OCEAN3D_PAGE_KEYS.includes(p))
        : effectiveUser.permissions!.includes(target));
    if (allowed(page)) return;
    const fallback = PAGE_FALLBACK_ORDER.find(allowed) ?? 'profile';
    setPage(fallback);
    window.location.hash = fallback;
  }, [page, effectiveUser, authenticated]);
  const navigate = (target: PageKey) => {
    setSearchFocus(null);
    setPage(target);
    window.location.hash = target;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const searchJump = (target: { page: 'history' | 'reports'; query: string; reportId?: string }) => {
    setSearchFocus({ page: target.page, query: target.query, reportId: target.reportId });
    setPage(target.page);
    window.location.hash = target.page;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  /** 登录进入：凭证校验通过后进入工作台 */
  const login = () => {
    sessionStorage.setItem('aquarise-session', 'active');
    setAuthenticated(true);
    window.location.hash = 'dashboard';
  };
  const logout = () => { clearStoredAuth(); setAuthenticated(false); setUser(null); };

  if (!authenticated) return <LoginScreen onLogin={login} />;
  // SeaAreaProvider 覆盖全部已认证页面：指挥大屏/生命图谱等独立全屏页同样读取侧栏已选海域，
  // 其他标签页切换海域后重新进入大屏即使用最新选择。
  return (
    <SeaAreaProvider>
      {page === 'screen'
        ? <Suspense fallback={<div className="page-state"><i className="loader-orbit" />正在载入指挥大屏…</div>}><CommandScreen onExit={() => navigate('dashboard')} /></Suspense>
        : page === 'atlas'
          ? <Suspense fallback={<div className="page-state"><i className="loader-orbit" />正在载入生命图谱…</div>}><MarineAtlasPage onExit={() => navigate('dashboard')} /></Suspense>
          : (
            <Shell
              page={page}
              onNavigate={navigate}
              onSearchJump={searchJump}
              onLogout={logout}
              user={effectiveUser}
              simControl={isSuperAdmin ? { groups: simGroups, value: simGroup?.id ?? null, onChange: simulate } : undefined}
            >
              <Suspense fallback={<div className="page-state glass"><i className="loader-orbit" /><p>正在载入海洋工作台…</p></div>}>
                {page === 'dashboard' && <Dashboard onNavigate={navigate} user={effectiveUser} />}
                {page === 'ocean3d' && <Ocean3DPage user={effectiveUser} />}
                {page === 'admin' && <AdminPage user={user} />}
                {page === 'detection' && <Detection onNavigate={navigate} />}
                {page === 'history' && <HistoryPage initialQuery={searchFocus?.page === 'history' ? searchFocus.query : ''} />}
                {page === 'analysis' && <AnalysisPage />}
                {page === 'reports' && <ReportsPage initialQuery={searchFocus?.page === 'reports' ? searchFocus.query : ''} initialReportId={searchFocus?.page === 'reports' ? searchFocus.reportId : undefined} />}
                {page === 'assistant' && <AssistantPage user={effectiveUser} />}
                {page === 'profile' && <ProfilePage user={user} onUserUpdated={setUser} />}
              </Suspense>
            </Shell>
          )}
    </SeaAreaProvider>
  );
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [visible, setVisible] = useState(false);
  const [register, setRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false); // 保持登录：默认勾选
  const [phone, setPhone] = useState(''); // 注册时填写的手机号（选填）
  const [notice, setNotice] = useState(''); // 操作成功提示（如"密码已重置"）
  // 忘记密码：step1 验证账号（用户名+手机号+邮箱）→ step2 设置新密码（两次输入）
  const [forgot, setForgot] = useState(false);
  const [forgotStep, setForgotStep] = useState(1);
  const [fAccount, setFAccount] = useState('');
  const [fPhone, setFPhone] = useState('');
  const [fEmail, setFEmail] = useState('');
  const [fPwd1, setFPwd1] = useState('');
  const [fPwd2, setFPwd2] = useState('');
  // 人脸识别登录模式
  const [faceMode, setFaceMode] = useState(false);
  const [faceBusy, setFaceBusy] = useState(false);
  const faceCam = useCamera();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(''); setNotice('');
    try {
      const account = username.trim();
      const body = { username: account, password, platform: 'pc', remember_me: remember };
      if (register) {
        const res = await fetch('/api/v1/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: account, password, email: email.trim(), phone_num: phone.trim() || null }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error((payload as { detail?: string })?.detail ?? '注册失败');
        }
      }
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('用户名或密码错误');
      const data = await res.json() as { access_token: string };
      storeToken(data.access_token, remember);
      onLogin();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const enterFaceMode = () => {
    setError('');
    setFaceMode(true);
    faceCam.open().catch((reason) => setError(reason instanceof Error ? reason.message : '无法打开摄像头'));
  };
  const exitFaceMode = () => {
    setFaceMode(false);
    setError('');
    faceCam.stop();
  };
  const doFaceLogin = async () => {
    setError('');
    setFaceBusy(true);
    try {
      const file = faceCam.capture();
      const result = await api.faceLogin(file);
      storeToken(result.access_token, remember);
      onLogin();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '人脸识别失败，请重试');
    } finally {
      setFaceBusy(false);
    }
  };

  const openForgot = () => { setError(''); setNotice(''); setRegister(false); setForgot(true); setForgotStep(1); };
  const closeForgot = () => { setForgot(false); setForgotStep(1); setError(''); };
  /** 忘记密码提交：三要素（用户名+手机号+邮箱）+ 两次新密码一并交给后端校验与重置 */
  const submitReset = async (event: FormEvent) => {
    event.preventDefault();
    setError(''); setNotice('');
    if (fPwd1.length < 6) { setError('密码至少需要 6 位'); return; }
    if (fPwd1 !== fPwd2) { setError('两次输入的密码不一致'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/v1/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fAccount.trim(), phone: fPhone.trim(), email: fEmail.trim(), new_password: fPwd1, confirm_password: fPwd2 }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error((payload as { detail?: string })?.detail ?? '密码重置失败');
      }
      setForgot(false); setForgotStep(1);
      setFAccount(''); setFPhone(''); setFEmail(''); setFPwd1(''); setFPwd2('');
      setNotice('密码已重置成功，请使用新密码登录');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '密码重置失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return <main className="login-page"><div className="login-ocean" aria-hidden="true"><i /><i /><i /><div className="login-ray ray-a" /><div className="login-ray ray-b" /></div><section className="login-story"><div className="login-brand"><span className="login-brand-orb"><HaitongLogo size={28} /></span><div><div className="login-brand-title"><strong>海瞳</strong><span className="brand-sub-name">HAITONG</span></div><small>海洋全域智能感知与污染分析系统</small></div></div><div className="login-copy"><span className="eyebrow"><i /> HAITONG INTELLIGENCE</span><h1>让每一次识别<br />都成为海洋的<span>转机</span></h1><p>融合计算机视觉与环境智能分析，发现、研判并追踪每一处水下污染风险。</p><div className="login-features"><span><CheckCircle2 />22 类垃圾精准识别</span><span><CheckCircle2 />实时污染态势分析</span><span><CheckCircle2 />一键生成质量报告</span></div></div><footer>第 8 组 · 水下垃圾自动识别与海洋污染分析系统</footer></section><section className="login-card-wrap">{faceMode ? <article className="login-card glass-strong"><header><div className="mobile-login-brand"><HaitongLogo size={22} /><span>海瞳 HAITONG</span></div><span>FACE ACCESS</span><h2>人脸识别登录</h2><p>请正对摄像头，保持面部清晰</p></header><div className="face-camera-box"><video ref={faceCam.videoRef} autoPlay playsInline muted aria-label="摄像头预览" /><span className="face-camera-hint"><i /> 对准面部并保持光线充足</span></div>{error && <div className="login-error" style={{ color: '#ff6885', fontSize: 13, textAlign: 'center', marginTop: 10 }}>{error}</div>}<button className="login-submit" onClick={doFaceLogin} disabled={faceBusy || !faceCam.ready}>{faceBusy ? <span className="login-loader" /> : <><Camera />拍照识别</>}</button><button className="demo-login" onClick={exitFaceMode}><ArrowRight />返回账号密码登录</button></article> : forgot ? <article className="login-card glass-strong"><header><div className="mobile-login-brand"><HaitongLogo size={22} /><span>海瞳 HAITONG</span></div><span>PASSWORD RESET</span><h2>找回密码</h2><p>验证账号信息后设置新密码</p></header>{forgotStep === 1 ? <form onSubmit={(event) => { event.preventDefault(); setError(''); setNotice(''); setForgotStep(2); }}><label><span>用户名</span><div><Mail /><input required value={fAccount} onChange={(event) => setFAccount(event.target.value)} placeholder="请输入用户名" /></div></label><label><span>手机号</span><div><Mail /><input required value={fPhone} onChange={(event) => setFPhone(event.target.value)} placeholder="请输入注册时的手机号" /></div></label><label><span>邮箱</span><div><Mail /><input required type="email" value={fEmail} onChange={(event) => setFEmail(event.target.value)} placeholder="请输入注册时的邮箱" /></div></label>{error && <div className="login-error" style={{ color: '#ff6885', fontSize: 13, textAlign: 'center', marginTop: 10 }}>{error}</div>}<button className="login-submit">下一步<ArrowRight /></button></form> : <form onSubmit={submitReset}><label><span>新密码</span><div><LockKeyhole /><input required type={visible ? 'text' : 'password'} value={fPwd1} onChange={(event) => setFPwd1(event.target.value)} placeholder="请输入新密码（至少 6 位）" /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? '隐藏密码' : '显示密码'}>{visible ? <EyeOff /> : <Eye />}</button></div></label><label><span>确认新密码</span><div><LockKeyhole /><input required type={visible ? 'text' : 'password'} value={fPwd2} onChange={(event) => setFPwd2(event.target.value)} placeholder="请再次输入新密码" /></div></label>{error && <div className="login-error" style={{ color: '#ff6885', fontSize: 13, textAlign: 'center', marginTop: 10 }}>{error}</div>}<button className="login-submit" disabled={loading}>{loading ? <span className="login-loader" /> : <>重置密码<ArrowRight /></>}</button></form>}<footer>想起密码了？<button onClick={closeForgot}>返回登录</button></footer></article> : <article className="login-card glass-strong"><header><div className="mobile-login-brand"><HaitongLogo size={22} /><span>海瞳 HAITONG</span></div><span>SECURE ACCESS</span><h2>{register ? '创建项目账号' : '欢迎回来'}</h2><p>{register ? '加入海瞳海洋保护协作网络' : '登录后进入海洋污染监测工作台'}</p></header><form onSubmit={submit}>{register && <label><span>用户名</span><div><Mail /><input required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="请输入用户名" /></div></label>}<label><span>{register ? '邮箱' : '手机号 / 邮箱 / 用户名'}</span><div><Mail /><input required type={register ? 'email' : 'text'} value={register ? email : username} onChange={(event) => register ? setEmail(event.target.value) : setUsername(event.target.value)} placeholder={register ? '请输入邮箱' : '请输入账号'} /></div></label>{register && <label><span>手机号（选填）</span><div><Mail /><input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="请输入手机号" /></div></label>}<label><span>登录密码</span><div><LockKeyhole /><input required type={visible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? '隐藏密码' : '显示密码'}>{visible ? <EyeOff /> : <Eye />}</button></div></label>{!register && <div className="login-options"><label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />保持登录</label><button type="button" onClick={openForgot}>忘记密码？</button></div>}{notice && <div className="login-error" style={{ color: '#2ee6a8', fontSize: 13, textAlign: 'center', marginTop: 10 }}>{notice}</div>}{error && <div className="login-error" style={{ color: '#ff6885', fontSize: 13, textAlign: 'center', marginTop: 10 }}>{error}</div>}<button className="login-submit" disabled={loading}>{loading ? <span className="login-loader" /> : <>{register ? '创建并进入平台' : '登录工作台'}<ArrowRight /></>}</button></form><div className="login-divider"><span>其他方式</span></div><button className="demo-login" onClick={() => { setError(''); enterFaceMode(); }}><Camera />人脸识别登录</button><footer>{register ? '已有账号？' : '还没有账号？'}<button onClick={() => { setRegister(!register); setError(''); }}>{register ? '返回登录' : '申请加入项目'}</button></footer></article>}<p className="security-copy"><ShieldCheck />本系统仅供授权项目成员访问 · 传输全程加密</p></section></main>;
}
