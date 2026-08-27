import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowRight, Camera, CheckCircle2, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, Waves } from 'lucide-react';
import type { FormEvent } from 'react';
import { Shell } from './components/Shell';
import { SeaAreaProvider } from './context/SeaAreaContext';
import { HaitongLogo } from './components/HaitongLogo';
import { api, clearStoredAuth, enterDemoMode, getStoredToken, storeToken } from './services/api';
import { useCamera } from './services/camera';
import { OCEAN3D_PAGE_KEYS } from './types';
import type { PageKey, UserInfo } from './types';
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

  useEffect(() => {
    if (!authenticated) { setUser(null); return; }
    api.getCurrentUser().then(setUser).catch(() => setUser(null));
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
  // 个人中心对全员开放；user.permissions 未加载完成（null/undefined）前不拦截。
  // 海洋 3D 页按模式键判定：拥有任一模式（ocean3d_monitor/science）即可进入。
  useEffect(() => {
    if (!authenticated || !user?.permissions) return;
    const allowed = (target: PageKey) =>
      target === 'profile'
      || (target === 'ocean3d'
        ? user.permissions!.some((p) => OCEAN3D_PAGE_KEYS.includes(p))
        : user.permissions!.includes(target));
    if (allowed(page)) return;
    const fallback = PAGE_FALLBACK_ORDER.find(allowed) ?? 'profile';
    setPage(fallback);
    window.location.hash = fallback;
  }, [page, user, authenticated]);
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
  /** 登录进入；demo=true 为免认证演示进入（全站 mock 数据，仅当前标签页） */
  const login = (demo = false) => {
    sessionStorage.setItem('aquarise-session', 'active');
    if (demo) enterDemoMode();
    setAuthenticated(true);
    window.location.hash = 'dashboard';
  };
  const logout = () => { clearStoredAuth(); setAuthenticated(false); setUser(null); };

  if (!authenticated) return <LoginScreen onLogin={login} />;
  if (page === 'screen') return <Suspense fallback={<div className="page-state"><i className="loader-orbit" />正在载入指挥大屏…</div>}><CommandScreen onExit={() => navigate('dashboard')} /></Suspense>;
  if (page === 'atlas') return <Suspense fallback={<div className="page-state"><i className="loader-orbit" />正在载入生命图谱…</div>}><MarineAtlasPage onExit={() => navigate('dashboard')} /></Suspense>;
  return <SeaAreaProvider><Shell page={page} onNavigate={navigate} onSearchJump={searchJump} onLogout={logout} user={user}>
    <Suspense fallback={<div className="page-state glass"><i className="loader-orbit" /><p>正在载入海洋工作台…</p></div>}>
      {page === 'dashboard' && <Dashboard onNavigate={navigate} user={user} />}
      {page === 'ocean3d' && <Ocean3DPage user={user} />}
      {page === 'admin' && <AdminPage user={user} />}
      {page === 'detection' && <Detection onNavigate={navigate} />}
      {page === 'history' && <HistoryPage initialQuery={searchFocus?.page === 'history' ? searchFocus.query : ''} />}
      {page === 'analysis' && <AnalysisPage />}
      {page === 'reports' && <ReportsPage initialQuery={searchFocus?.page === 'reports' ? searchFocus.query : ''} initialReportId={searchFocus?.page === 'reports' ? searchFocus.reportId : undefined} />}
      {page === 'assistant' && <AssistantPage user={user} />}
      {page === 'profile' && <ProfilePage user={user} onUserUpdated={setUser} />}
    </Suspense>
  </Shell></SeaAreaProvider>;
}

function LoginScreen({ onLogin }: { onLogin: (demo?: boolean) => void }) {
  const [visible, setVisible] = useState(false);
  const [register, setRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('admin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('123456');
  const [remember, setRemember] = useState(true); // 保持登录：默认勾选
  // 人脸识别登录模式
  const [faceMode, setFaceMode] = useState(false);
  const [faceBusy, setFaceBusy] = useState(false);
  const faceCam = useCamera();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const account = username.trim();
      const body = { username: account, password, platform: 'pc', remember_me: remember };
      if (register) {
        const res = await fetch('/api/v1/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: account, password, email: email.trim() }),
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

  return <main className="login-page"><div className="login-ocean" aria-hidden="true"><i /><i /><i /><div className="login-ray ray-a" /><div className="login-ray ray-b" /></div><section className="login-story"><div className="login-brand"><span className="login-brand-orb"><HaitongLogo size={28} /></span><div><div className="login-brand-title"><strong>海瞳</strong><span className="brand-sub-name">HAITONG</span></div><small>海洋全域智能感知与污染分析系统</small></div></div><div className="login-copy"><span className="eyebrow"><i /> HAITONG INTELLIGENCE</span><h1>让每一次识别<br />都成为海洋的<span>转机</span></h1><p>融合计算机视觉与环境智能分析，发现、研判并追踪每一处水下污染风险。</p><div className="login-features"><span><CheckCircle2 />22 类垃圾精准识别</span><span><CheckCircle2 />实时污染态势分析</span><span><CheckCircle2 />一键生成质量报告</span></div></div><footer>第 8 组 · 水下垃圾自动识别与海洋污染分析系统</footer></section><section className="login-card-wrap">{faceMode ? <article className="login-card glass-strong"><header><div className="mobile-login-brand"><HaitongLogo size={22} /><span>海瞳 HAITONG</span></div><span>FACE ACCESS</span><h2>人脸识别登录</h2><p>请正对摄像头，保持面部清晰</p></header><div className="face-camera-box"><video ref={faceCam.videoRef} autoPlay playsInline muted aria-label="摄像头预览" /><span className="face-camera-hint"><i /> 对准面部并保持光线充足</span></div>{error && <div className="login-error" style={{ color: '#ff6885', fontSize: 13, textAlign: 'center', marginTop: 10 }}>{error}</div>}<button className="login-submit" onClick={doFaceLogin} disabled={faceBusy || !faceCam.ready}>{faceBusy ? <span className="login-loader" /> : <><Camera />拍照识别</>}</button><button className="demo-login" onClick={exitFaceMode}><ArrowRight />返回账号密码登录</button></article> : <article className="login-card glass-strong"><header><div className="mobile-login-brand"><HaitongLogo size={22} /><span>海瞳 HAITONG</span></div><span>SECURE ACCESS</span><h2>{register ? '创建项目账号' : '欢迎回来'}</h2><p>{register ? '加入海瞳海洋保护协作网络' : '登录后进入海洋污染监测工作台'}</p></header><form onSubmit={submit}>{register && <label><span>用户名</span><div><Mail /><input required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="请输入用户名" /></div></label>}<label><span>{register ? '邮箱' : '手机号 / 邮箱 / 用户名'}</span><div><Mail /><input required value={register ? email : username} onChange={(event) => register ? setEmail(event.target.value) : setUsername(event.target.value)} placeholder={register ? '请输入邮箱' : '请输入账号'} /></div></label><label><span>登录密码</span><div><LockKeyhole /><input required type={visible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? '隐藏密码' : '显示密码'}>{visible ? <EyeOff /> : <Eye />}</button></div></label><div className="login-options"><label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />保持登录</label><button type="button">忘记密码？</button></div>{error && <div className="login-error" style={{ color: '#ff6885', fontSize: 13, textAlign: 'center', marginTop: 10 }}>{error}</div>}<button className="login-submit" disabled={loading}>{loading ? <span className="login-loader" /> : <>{register ? '创建并进入平台' : '登录工作台'}<ArrowRight /></>}</button></form><div className="login-divider"><span>其他方式</span></div><button className="demo-login" onClick={() => { setError(''); enterFaceMode(); }}><Camera />人脸识别登录</button><button className="demo-login" onClick={() => onLogin(true)}><ShieldCheck />免认证进入项目演示</button><footer>{register ? '已有账号？' : '还没有账号？'}<button onClick={() => { setRegister(!register); setError(''); }}>{register ? '返回登录' : '申请加入项目'}</button></footer></article>}<p className="security-copy"><ShieldCheck />本系统仅供授权项目成员访问 · 传输全程加密</p></section></main>;
}
