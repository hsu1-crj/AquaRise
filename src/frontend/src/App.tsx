import { lazy, Suspense, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, CheckCircle2, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, Waves } from 'lucide-react';
import { Shell } from './components/Shell';
import type { PageKey } from './types';
const AnalysisPage = lazy(() => import('./pages/Analysis').then((module) => ({ default: module.AnalysisPage })));
const AssistantPage = lazy(() => import('./pages/Assistant').then((module) => ({ default: module.AssistantPage })));
const CommandScreen = lazy(() => import('./pages/CommandScreen').then((module) => ({ default: module.CommandScreen })));
const Dashboard = lazy(() => import('./pages/Dashboard').then((module) => ({ default: module.Dashboard })));
const Detection = lazy(() => import('./pages/Detection').then((module) => ({ default: module.Detection })));
const HistoryPage = lazy(() => import('./pages/History').then((module) => ({ default: module.HistoryPage })));
const ReportsPage = lazy(() => import('./pages/Reports').then((module) => ({ default: module.ReportsPage })));
const KnowledgePage = lazy(() => import('./pages/UtilityPages').then((module) => ({ default: module.KnowledgePage })));
const ProfilePage = lazy(() => import('./pages/UtilityPages').then((module) => ({ default: module.ProfilePage })));

const validPages: Record<PageKey, true> = { dashboard: true, detection: true, history: true, analysis: true, screen: true, reports: true, assistant: true, knowledge: true, profile: true };

export default function App() {
  const [authenticated, setAuthenticated] = useState(() => sessionStorage.getItem('aquarise-session') === 'active');
  const [page, setPage] = useState<PageKey>(() => {
    const hash = window.location.hash.slice(1) as PageKey;
    return validPages[hash] ? hash : 'dashboard';
  });

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.slice(1) as PageKey;
      if (validPages[hash]) setPage(hash);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (target: PageKey) => {
    setPage(target);
    window.location.hash = target;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const login = () => { sessionStorage.setItem('aquarise-session', 'active'); setAuthenticated(true); window.location.hash = 'dashboard'; };
  const logout = () => { sessionStorage.removeItem('aquarise-session'); setAuthenticated(false); };

  if (!authenticated) return <LoginScreen onLogin={login} />;
  if (page === 'screen') return <Suspense fallback={<div className="page-state"><i className="loader-orbit" />正在载入指挥大屏…</div>}><CommandScreen onExit={() => navigate('dashboard')} /></Suspense>;

  return <Shell page={page} onNavigate={navigate} onLogout={logout}>
    <Suspense fallback={<div className="page-state glass"><i className="loader-orbit" /><p>正在载入海洋工作台…</p></div>}>
      {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
      {page === 'detection' && <Detection onNavigate={navigate} />}
      {page === 'history' && <HistoryPage />}
      {page === 'analysis' && <AnalysisPage />}
      {page === 'reports' && <ReportsPage />}
      {page === 'assistant' && <AssistantPage />}
      {page === 'knowledge' && <KnowledgePage />}
      {page === 'profile' && <ProfilePage />}
    </Suspense>
  </Shell>;
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [visible, setVisible] = useState(false);
  const [register, setRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault(); setLoading(true);
    window.setTimeout(() => { setLoading(false); onLogin(); }, 650);
  };

  return <main className="login-page"><div className="login-ocean" aria-hidden="true"><i /><i /><i /><div className="login-ray ray-a" /><div className="login-ray ray-b" /></div><section className="login-story"><div className="login-brand"><span><Waves /></span><div><strong>AQUARISE</strong><small>海洋智守平台</small></div></div><div className="login-copy"><span className="eyebrow"><i /> OCEAN INTELLIGENCE</span><h1>让每一次识别<br />都成为海洋的<span>转机</span></h1><p>融合计算机视觉与环境智能分析，发现、研判并追踪每一处水下污染风险。</p><div className="login-features"><span><CheckCircle2 />22 类垃圾精准识别</span><span><CheckCircle2 />实时污染态势分析</span><span><CheckCircle2 />一键生成质量报告</span></div></div><footer>第 8 组 · 水下垃圾自动识别与海洋污染分析系统</footer></section><section className="login-card-wrap"><article className="login-card glass-strong"><header><div className="mobile-login-brand"><Waves />AQUARISE</div><span>SECURE ACCESS</span><h2>{register ? '创建项目账号' : '欢迎回来'}</h2><p>{register ? '加入 AQUARISE 海洋保护协作网络' : '登录后进入海洋污染监测工作台'}</p></header><form onSubmit={submit}>{register && <label><span>姓名</span><div><Mail /><input required placeholder="请输入姓名" /></div></label>}<label><span>邮箱 / 用户名</span><div><Mail /><input required defaultValue="admin@aquarise.local" placeholder="请输入账号" /></div></label><label><span>登录密码</span><div><LockKeyhole /><input required type={visible ? 'text' : 'password'} defaultValue="aquarise2026" placeholder="请输入密码" /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? '隐藏密码' : '显示密码'}>{visible ? <EyeOff /> : <Eye />}</button></div></label><div className="login-options"><label><input type="checkbox" defaultChecked />保持登录</label><button type="button">忘记密码？</button></div><button className="login-submit" disabled={loading}>{loading ? <span className="login-loader" /> : <>{register ? '创建并进入平台' : '登录工作台'}<ArrowRight /></>}</button></form><div className="login-divider"><span>演示环境</span></div><button className="demo-login" onClick={onLogin}><ShieldCheck />免认证进入项目演示</button><footer>{register ? '已有账号？' : '还没有账号？'}<button onClick={() => setRegister(!register)}>{register ? '返回登录' : '申请加入项目'}</button></footer></article><p className="security-copy"><ShieldCheck />本系统仅供授权项目成员访问 · 传输全程加密</p></section></main>;
}
