import { useCallback, useEffect, useState } from 'react';
import { ArrowLeftRight, Camera, CheckCircle2, LoaderCircle, LockKeyhole, Save, ScanFace, Trash2, UserRound } from 'lucide-react';
import { api } from '../services/api';
import { useCamera } from '../services/camera';
import type { FaceInfo, GroupOption, GroupSwitchRequestInfo, ProfileStats, UserInfo } from '../types';

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
  // 最高管理员（种子 admin 或超级管理员组成员）：分组被锁定，不提供换组申请入口
  const isSuperAdmin = isAdmin || user?.group_code === 'super_admin';
  const avatarChar = displayName.slice(0, 1).toUpperCase();

  // ============ 头像卡三项统计（按当前账号真实工作量，替代硬编码） ============
  const [stats, setStats] = useState<ProfileStats | null>(null);
  useEffect(() => {
    api.getProfileStats().then(setStats).catch(() => setStats(null));
  }, [user?.id]);

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

  // ============ 人脸识别注册 ============
  const [faces, setFaces] = useState<FaceInfo[]>([]);
  const [faceCapturing, setFaceCapturing] = useState(false);
  const [faceBusy, setFaceBusy] = useState(false);
  const [faceError, setFaceError] = useState('');
  const [faceSaved, setFaceSaved] = useState(false);
  const faceCam = useCamera();

  const loadFaces = () => {
    api.listFaces().then(setFaces).catch(() => setFaces([]));
  };
  useEffect(loadFaces, []);

  const startFaceCapture = () => {
    setFaceError('');
    setFaceCapturing(true);
    faceCam.open().catch((reason) => {
      setFaceError(reason instanceof Error ? reason.message : '无法打开摄像头');
      setFaceCapturing(false);
    });
  };
  const cancelFaceCapture = () => {
    setFaceCapturing(false);
    setFaceError('');
    faceCam.stop();
  };
  const enrollFace = async () => {
    setFaceError('');
    setFaceBusy(true);
    try {
      const file = faceCam.capture();
      await api.enrollFace(file, displayName);
      faceCam.stop();
      setFaceCapturing(false);
      setFaceSaved(true);
      loadFaces();
    } catch (reason) {
      setFaceError(reason instanceof Error ? reason.message : '录入失败，请重试');
    } finally {
      setFaceBusy(false);
      window.setTimeout(() => setFaceSaved(false), 2500);
    }
  };
  const removeFace = async (id: number) => {
    setFaceError('');
    try {
      await api.deleteFace(id);
      loadFaces();
    } catch (reason) {
      setFaceError(reason instanceof Error ? reason.message : '删除失败，请重试');
    }
  };

  const maxFaces = 3;
  const full = faces.length >= maxFaces;
  const faceList = (
    <div className="face-record-list">{faces.length === 0
      ? <p className="face-record-empty">还未录入人脸，添加后即可使用「人脸识别登录」。</p>
      : faces.map((item) => (
        <article key={item.id} className="face-record-item">
          <div className="face-record-avatar"><ScanFace /></div>
          <div><strong>{item.name}</strong><span>{item.created_at ? `录入于 ${item.created_at.slice(0, 10)}` : '已录入'}</span></div>
          <button className="face-record-delete" onClick={() => removeFace(item.id)} aria-label={`删除人脸 ${item.name}`}><Trash2 /></button>
        </article>
      ))}</div>
  );

  // ============ 换组申请（最高管理员以外可用）：浏览各组职能 → 提交申请 → 超管在后台审批 ============
  const [groupOptions, setGroupOptions] = useState<GroupOption[]>([]);
  const [myRequests, setMyRequests] = useState<GroupSwitchRequestInfo[]>([]);
  const [gsLoading, setGsLoading] = useState(!isSuperAdmin);
  const [gsGroupId, setGsGroupId] = useState(0);
  const [gsReason, setGsReason] = useState('');
  const [gsBusy, setGsBusy] = useState(false);
  const [gsError, setGsError] = useState('');

  const loadGroupData = useCallback(() => {
    if (isSuperAdmin) return;
    setGsLoading(true);
    Promise.all([api.getPublicGroups(), api.getMyGroupRequests()])
      .then(([groups, requests]) => {
        setGroupOptions(groups);
        setMyRequests(requests);
        // 默认选中第一个非当前组的目标
        setGsGroupId((prev) => prev || groups.find((g) => g.id !== user?.group_id)?.id || 0);
      })
      .catch(() => { setGroupOptions([]); setMyRequests([]); })
      .finally(() => setGsLoading(false));
  }, [isSuperAdmin, user?.group_id]);

  useEffect(loadGroupData, [loadGroupData]);

  const pendingRequest = myRequests.find((r) => r.status === 'pending') ?? null;
  const latestHandled = myRequests.find((r) => r.status !== 'pending') ?? null;
  const selectedGroup = groupOptions.find((g) => g.id === gsGroupId) ?? null;

  const submitGroupRequest = async () => {
    setGsError('');
    if (!gsGroupId) { setGsError('请选择要申请加入的用户组'); return; }
    setGsBusy(true);
    try {
      await api.requestGroupSwitch(gsGroupId, gsReason);
      setGsReason('');
      loadGroupData();
    } catch (reason) {
      setGsError(reason instanceof Error ? reason.message : '提交失败，请稍后重试');
    } finally {
      setGsBusy(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="page-heading compact">
        <div><span className="eyebrow"><i /> ACCOUNT CENTER</span><h1>个人中心</h1><p>管理个人资料、安全设置和通知偏好。</p></div>
      </section>
      <section className="profile-grid">
        <aside className="panel glass profile-card">
          <div className="profile-avatar">{avatarChar}<span><i /></span></div>
          <h2>{displayName}</h2>
          <p>账号：{user?.username ?? '未登录'}</p>
          <span className="admin-badge">{isAdmin ? '项目管理员' : '用户'}</span>
          <dl>
            <div><dt>参与项目</dt><dd>{stats ? stats.project_count : '—'}</dd></div>
            <div><dt>创建任务</dt><dd>{stats ? stats.task_count : '—'}</dd></div>
            <div><dt>生成报告</dt><dd>{stats ? stats.report_count : '—'}</dd></div>
          </dl>
        </aside>
        <article className="panel glass profile-form">
          <header><UserRound /><div><h2>基本信息</h2><span>用于项目协作与报告署名</span></div></header>
          <div className="form-grid">
            <label>账号<input value={displayName} readOnly /></label>
            <label>手机号<input type="tel" value={phoneNum} onChange={(event) => setPhoneNum(event.target.value)} placeholder="输入手机号（可用于登录）" /></label>
            <label>电子邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="输入常用邮箱" /></label>
            <label>团队编号<input value="第 8 组" readOnly /></label>
          </div>
          <header className="security-heading"><LockKeyhole /><div><h2>安全设置</h2><span>修改登录密码与会话安全配置</span></div></header>
          <div className="form-grid">
            <label>当前密码<input type="password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} placeholder="输入当前密码" autoComplete="current-password" /></label>
            <label>新密码<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 6 位字符" autoComplete="new-password" /></label>
          </div>
          <footer>
            {passwordSaved && <span className="save-success"><CheckCircle2 />密码已更新</span>}
            {saved && <span className="save-success"><CheckCircle2 />资料已保存</span>}
            {error && <span style={{ color: '#ff6885', fontSize: 13, marginRight: 'auto' }}>{error}</span>}
            <button className="primary-button" onClick={save} disabled={saving}>{saving ? '保存中…' : <><Save />保存修改</>}</button>
          </footer>

          {!isSuperAdmin && (
            <>
              <header className="security-heading"><ArrowLeftRight /><div><h2>用户组与换组申请</h2><span>查看各用户组的职能与可用功能，可申请换组，由最高管理员审批</span></div></header>
              <div className="group-switch-section">
                {gsLoading ? (
                  <div className="page-state"><LoaderCircle className="spin" />正在加载用户组…</div>
                ) : (
                  <>
                    <p className="group-switch-current">当前用户组：<strong>{user?.group_name ?? '未分组'}</strong></p>
                    {pendingRequest ? (
                      <div className="admin-notice">
                        <LoaderCircle size={14} className="spin" />
                        换组申请审批中：申请加入「{pendingRequest.to_group_name ?? '目标用户组'}」，最高管理员处理后会通过铃铛通知你
                      </div>
                    ) : (
                      <>
                        <div className="form-grid">
                          <label>申请加入的用户组
                            <select value={gsGroupId || ''} onChange={(event) => setGsGroupId(Number(event.target.value))}>
                              <option value="" disabled>请选择用户组</option>
                              {groupOptions.map((g) => (
                                <option key={g.id} value={g.id} disabled={g.id === user?.group_id}>
                                  {g.name}{g.id === user?.group_id ? '（当前所在组）' : ''}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>申请理由（选填）
                            <input value={gsReason} onChange={(event) => setGsReason(event.target.value)} placeholder="简述申请原因，供管理员参考" maxLength={200} />
                          </label>
                        </div>
                        {selectedGroup && (
                          <div className="group-switch-detail">
                            <p className="group-switch-desc">{selectedGroup.description || '该组暂无职能说明'}</p>
                            <div className="admin-module-matrix readonly">
                              {selectedGroup.module_names.map((name, index) => (
                                <span key={selectedGroup.modules[index] ?? name} className="admin-module-chip on">{name}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        {gsError && <span className="admin-form-error">{gsError}</span>}
                        <button className="primary-button" onClick={submitGroupRequest} disabled={gsBusy || !gsGroupId || gsGroupId === user?.group_id}>
                          {gsBusy ? '提交中…' : <><ArrowLeftRight />提交换组申请</>}
                        </button>
                      </>
                    )}
                    {latestHandled && (
                      <p className="group-switch-history">
                        上次申请加入「{latestHandled.to_group_name ?? '目标用户组'}」：
                        {latestHandled.status === 'approved' ? '已批准' : '未通过'}
                        {latestHandled.handled_at ? `（${latestHandled.handled_at.slice(0, 16).replace('T', ' ')}）` : ''}
                      </p>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          <header className="security-heading"><ScanFace /><div><h2>人脸识别</h2><span>录入人脸后可在登录页使用人脸识别登录，一个账号最多 {maxFaces} 张</span></div></header>
          <div className="face-section">
            <div className="face-count">
              <span>已录入 <strong>{faces.length} / {maxFaces}</strong></span>
              {faceSaved && <span className="save-success"><CheckCircle2 />人脸已录入</span>}
            </div>
            {faceCapturing ? (
              <div className="face-camera-box">
                <video ref={faceCam.videoRef} autoPlay playsInline muted aria-label="摄像头预览" />
                <div className="face-camera-actions">
                  <button className="primary-button" onClick={enrollFace} disabled={faceBusy || !faceCam.ready}>{faceBusy ? '录入中…' : <><Camera />拍照录入</>}</button>
                  <button className="ghost-button" onClick={cancelFaceCapture}>取消</button>
                </div>
              </div>
            ) : (
              <>
                {faceList}
                <button className="primary-button" onClick={startFaceCapture} disabled={full} style={{ marginTop: 12 }}>
                  <Camera />{full ? '已达上限（3 张）' : '录入人脸'}
                </button>
              </>
            )}
            {faceError && <p style={{ color: '#ff6885', fontSize: 11, marginTop: 10 }}>{faceError}</p>}
          </div>
        </article>
      </section>
    </div>
  );
}
