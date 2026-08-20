import { useEffect, useState } from 'react';
import { CheckCircle2, LockKeyhole, Save, UserRound } from 'lucide-react';
import { api } from '../services/api';
import type { UserInfo } from '../types';

export function ProfilePage({ user, onUserUpdated }: { user?: UserInfo | null; onUserUpdated?: (user: UserInfo) => void }) {
  const [email, setEmail] = useState(user?.email ?? '');
  const [phoneNum, setPhoneNum] = useState(user?.phone_num ?? '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) {
      setEmail(user.email ?? '');
      setPhoneNum(user.phone_num ?? '');
    }
  }, [user]);

  const displayName = user?.username ?? '账号';
  const isAdmin = user?.role === 'admin';
  const avatarChar = displayName.slice(0, 1).toUpperCase();

  const save = async () => {
    setError('');
    if (oldPassword || newPassword) {
      if (!oldPassword) { setError('请输入当前密码'); return; }
      if (newPassword.length < 6) { setError('新密码至少需要 6 位字符'); return; }
      if (newPassword === oldPassword) { setError('新密码不能与当前密码相同'); return; }
    }
    setSaving(true);
    try {
      if (oldPassword && newPassword) {
        await api.changePassword(oldPassword, newPassword);
        setOldPassword('');
        setNewPassword('');
        setPasswordSaved(true);
      }
      if (email.trim() !== (user?.email ?? '') || phoneNum.trim() !== (user?.phone_num ?? '')) {
        const updated = await api.updateProfile({ email, phoneNum });
        onUserUpdated?.(updated);
      }
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败，请稍后重试');
    } finally {
      setSaving(false);
      window.setTimeout(() => setSaved(false), 2500);
      window.setTimeout(() => setPasswordSaved(false), 2500);
    }
  };

  return <div className="page-stack"><section className="page-heading compact"><div><span className="eyebrow"><i /> ACCOUNT CENTER</span><h1>个人中心</h1><p>管理个人资料、安全设置和通知偏好。</p></div></section><section className="profile-grid"><aside className="panel glass profile-card"><div className="profile-avatar">{avatarChar}<span><i /></span></div><h2>{displayName}</h2><p>账号：{user?.username ?? '未登录'}</p><span className="admin-badge">{isAdmin ? '项目管理员' : '用户'}</span><dl><div><dt>参与项目</dt><dd>1</dd></div><div><dt>创建任务</dt><dd>46</dd></div><div><dt>生成报告</dt><dd>12</dd></div></dl></aside><article className="panel glass profile-form"><header><UserRound /><div><h2>基本信息</h2><span>用于项目协作与报告署名</span></div></header><div className="form-grid"><label>账号<input value={displayName} readOnly /></label><label>手机号<input type="tel" value={phoneNum} onChange={(event) => setPhoneNum(event.target.value)} placeholder="输入手机号（可用于登录）" /></label><label>电子邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="输入常用邮箱" /></label><label>团队编号<input value="第 8 组" readOnly /></label></div><header className="security-heading"><LockKeyhole /><div><h2>安全设置</h2><span>修改登录密码与会话安全配置</span></div></header><div className="form-grid"><label>当前密码<input type="password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} placeholder="输入当前密码" autoComplete="current-password" /></label><label>新密码<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 6 位字符" autoComplete="new-password" /></label></div><footer>{passwordSaved && <span className="save-success"><CheckCircle2 />密码已更新</span>}{saved && <span className="save-success"><CheckCircle2 />资料已保存</span>}{error && <span style={{ color: '#ff6885', fontSize: 13, marginRight: 'auto' }}>{error}</span>}<button className="primary-button" onClick={save} disabled={saving}>{saving ? '保存中…' : <><Save />保存修改</>}</button></footer></article></section></div>;
}
