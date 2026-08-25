/**
 * profile.js — 个人中心
 * ============================================================
 * 用户友好设计：
 *   - 用户信息卡（头像首字母 / 用户名 / 角色）
 *   - 账号资料编辑（邮箱 / 手机号）
 *   - 修改密码（带强度提示）
 *   - API 服务器地址管理（手机端核心配置）
 *   - 连接测试
 *   - 退出登录（二次确认）
 */

import { api, isLoggedIn, setToken, getApiBase, setApiBase, resetApiBase, pingBase } from '../api.js';
import { el, clear, icon, toast } from '../ui.js';
import { clearMobileCache, getPreference, setPreference } from '../preferences.js';

export function renderProfile(container, ctx) {
  const { navigate, state } = ctx;
  let isMounted = true;

  const page = el('div', { className: 'page-pad' });
  container.append(page);

  // ---- 用户卡 ----
  const userName = state.user?.username || '用户';
  const userRole = state.user?.role === 'admin' ? '管理员' : '普通用户';
  const initial = userName.slice(0, 1).toUpperCase();

  page.append(el('div', { className: 'profile-hero glass' }, [
    el('div', { className: 'profile-avatar' }, [el('span', { textContent: initial })]),
    el('div', { className: 'profile-info' }, [
      el('strong', { textContent: userName }),
      el('div', { className: 'profile-role' }, [
        el('span', { className: `role-badge ${state.user?.role || 'user'}` }),
        el('span', { textContent: userRole }),
      ]),
      state.user?.email && el('small', { textContent: state.user.email }),
    ]),
  ]));

  // ---- 账号设置 ----
  const emailInput = el('input', {
    type: 'email', placeholder: '未设置邮箱',
    value: state.user?.email || '', autocomplete: 'email',
  });
  const phoneInput = el('input', {
    type: 'tel', placeholder: '未设置手机号',
    value: state.user?.phone_num || '', autocomplete: 'tel',
  });

  const profileSection = buildSection('账号资料', 'user', [
    el('div', { className: 'form-field' }, [
      el('label', { textContent: '邮箱地址' }),
      el('div', { className: 'input-wrap' }, [emailInput]),
    ]),
    el('div', { className: 'form-field' }, [
      el('label', { textContent: '手机号码' }),
      el('div', { className: 'input-wrap' }, [phoneInput]),
    ]),
    el('button', {
      className: 'btn-primary btn-sm',
      onClick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '保存中…';
        try {
          const updated = await api.updateProfile({
            email: emailInput.value.trim() || null,
            phoneNum: phoneInput.value.trim() || null,
          });
          if (state) state.user = updated;
          toast('资料已保存', 'success');
        } catch (err) {
          toast(err.message || '保存失败', 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '保存资料';
        }
      },
    }, ['保存资料']),
  ]);
  page.append(profileSection);

  // ---- 修改密码 ----
  const oldPwd = el('input', { type: 'password', placeholder: '当前密码', autocomplete: 'current-password' });
  const newPwd = el('input', { type: 'password', placeholder: '新密码（至少 6 位）', autocomplete: 'new-password' });
  const confirmPwd = el('input', { type: 'password', placeholder: '确认新密码', autocomplete: 'new-password' });

  const pwdHint = el('p', { className: 'pwd-strength-hint', style: { display: 'none' } });
  newPwd.addEventListener('input', () => {
    const v = newPwd.value;
    if (!v) { pwdHint.style.display = 'none'; return; }
    pwdHint.style.display = 'block';
    if (v.length < 6) {
      pwdHint.textContent = '密码至少 6 位';
      pwdHint.className = 'pwd-strength-hint weak';
    } else if (v.length < 10) {
      pwdHint.textContent = '密码强度：中';
      pwdHint.className = 'pwd-strength-hint medium';
    } else {
      pwdHint.textContent = '密码强度：强';
      pwdHint.className = 'pwd-strength-hint strong';
    }
  });

  page.append(buildSection('修改密码', 'lock', [
    el('div', { className: 'input-wrap' }, [oldPwd]),
    el('div', { className: 'input-wrap' }, [newPwd]),
    pwdHint,
    el('div', { className: 'input-wrap' }, [confirmPwd]),
    el('button', {
      className: 'btn-primary btn-sm',
      onClick: async (e) => {
        if (newPwd.value !== confirmPwd.value) {
          toast('两次输入的新密码不一致', 'error');
          return;
        }
        if (newPwd.value.length < 6) {
          toast('新密码至少 6 位', 'error');
          return;
        }
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '修改中…';
        try {
          await api.changePassword(oldPwd.value, newPwd.value);
          toast('密码修改成功', 'success');
          oldPwd.value = ''; newPwd.value = ''; confirmPwd.value = '';
          pwdHint.style.display = 'none';
        } catch (err) {
          toast(err.message || '修改失败', 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '确认修改';
        }
      },
    }, ['确认修改']),
  ]));

  // ---- API 服务器设置 ----
  const serverInput = el('input', {
    type: 'url', placeholder: 'http://192.168.1.100:8000',
    value: getApiBase(), autocapitalize: 'none', spellcheck: false,
  });

  const serverCard = buildSection('后端服务器', 'server', [
    el('p', { className: 'section-desc', textContent: '手机需指向运行后端的主机局域网 IP 地址' }),
    el('div', { className: 'input-wrap' }, [serverInput]),
    el('div', { className: 'profile-actions' }, [
      el('button', {
        className: 'btn-ghost btn-sm',
        onClick: () => {
          resetApiBase();
          serverInput.value = getApiBase();
          toast('已重置为默认地址', 'info');
        },
      }, [icon('refresh', 15), '重置']),
      el('button', {
        className: 'btn-ghost btn-sm',
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.replaceChildren(el('span', { className: 'spinner-mini' }), '测试中…');
          try {
            const url = serverInput.value.trim();
            const ok = await pingBase(url);
            if (ok) {
              setApiBase(url);
              toast('连接成功！已识别为 AQUARISE 后端', 'success');
            } else {
              toast('无法连接或非 AQUARISE 后端，请检查地址', 'error');
            }
          } catch (err) {
            toast(err.message || '地址格式不正确', 'error');
          } finally {
            btn.disabled = false;
            btn.replaceChildren(icon('wifi', 15), '测试连接');
          }
        },
      }, [icon('wifi', 15), '测试连接']),
      el('button', {
        className: 'btn-primary btn-sm',
        onClick: async (e) => {
          const btn = e.currentTarget;
          const url = serverInput.value.trim();
          btn.disabled = true;
          btn.replaceChildren(el('span', { className: 'spinner-mini' }), '验证中…');
          try {
            const ok = await pingBase(url);
            if (ok) {
              setApiBase(url);
              toast('地址已验证并保存', 'success');
            } else {
              toast('无法连接或非 AQUARISE 后端，未保存', 'error');
            }
          } catch (err) {
            toast(err.message || '地址格式不正确', 'error');
          } finally {
            btn.disabled = false;
            btn.replaceChildren(icon('check', 15), '保存');
          }
        },
      }, [icon('check', 15), '保存']),
    ]),
  ]);
  page.append(serverCard);

  // ---- 移动端偏好 ----
  const dataSaver = el('input', { type: 'checkbox', checked: getPreference('dataSaver'), 'aria-label': '省流模式' });
  const reducedMotion = el('input', { type: 'checkbox', checked: getPreference('reducedMotion'), 'aria-label': '减少动效' });
  dataSaver.addEventListener('change', () => {
    setPreference('dataSaver', dataSaver.checked);
    toast(dataSaver.checked ? '已开启省流模式' : '已关闭省流模式', 'success');
  });
  reducedMotion.addEventListener('change', () => setPreference('reducedMotion', reducedMotion.checked));
  const preferences = buildSection('移动设置', 'settings', [
    preferenceRow('省流模式', '减少非必要媒体与视觉资源', dataSaver),
    preferenceRow('减少动效', '关闭页面转场与进度动画', reducedMotion),
    el('div', { className: 'profile-actions' }, [
      el('button', {
        className: 'btn-ghost btn-sm',
        onClick: async () => {
          if (!('Notification' in window)) {
            toast('当前浏览器不支持系统通知', 'warning');
            return;
          }
          const permission = await Notification.requestPermission();
          toast(permission === 'granted' ? '任务完成通知已开启' : '未获得通知权限', permission === 'granted' ? 'success' : 'warning');
        },
      }, [icon('bell', 15), '任务通知']),
      el('button', {
        className: 'btn-ghost btn-sm',
        onClick: () => {
          clearMobileCache();
          toast('移动端临时缓存已清理', 'success');
        },
      }, [icon('trash', 15), '清理缓存']),
    ]),
  ]);
  page.append(preferences);

  // ---- 退出登录 ----
  let confirmLogout = false;
  const logoutBtn = el('button', {
    className: 'btn-logout',
    onClick: (e) => {
      if (!confirmLogout) {
        confirmLogout = true;
        e.currentTarget.textContent = '再次点击确认退出';
        e.currentTarget.classList.add('confirm');
        setTimeout(() => {
          confirmLogout = false;
          if (isMounted) {
            e.currentTarget.textContent = '退出登录';
            e.currentTarget.classList.remove('confirm');
          }
        }, 3000);
      } else {
        setToken(null);
        if (state) state.user = null;
        toast('已安全退出', 'info');
        navigate('login');
      }
    },
  }, ['退出登录']);
  page.append(logoutBtn);

  page.append(el('p', { className: 'profile-foot', textContent: '海瞳 HAITONG · 移动端 v2.0' }));

  return {
    unmount() { isMounted = false; },
    onShow() {
      // 刷新用户信息
      if (isLoggedIn()) {
        api.getMe().then((u) => {
          if (!isMounted) return;
          if (state) state.user = u;
          emailInput.value = u.email || '';
          phoneInput.value = u.phone_num || '';
        }).catch(() => {});
      }
    },
  };
}

// ============ 工具 ============

function buildSection(title, iconName, children) {
  return el('section', { className: 'section-block profile-section' }, [
    el('h3', { className: 'section-title' }, [icon(iconName, 16), title]),
    ...children,
  ]);
}

function preferenceRow(title, subtitle, control) {
  return el('label', { className: 'preference-row' }, [
    el('span', {}, [el('strong', { textContent: title }), el('small', { textContent: subtitle })]),
    el('span', { className: 'switch-control' }, [control, el('i')]),
  ]);
}
