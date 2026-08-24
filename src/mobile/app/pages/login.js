/**
 * login.js — 登录页
 * ============================================================
 * 功能：
 *   - 账号密码登录（JWT）
 *   - 密码显示切换
 *   - API 服务器地址配置（手机需填主机局域网 IP）
 *   - 连接测试
 */

import { api, setApiBase, getApiBase, resetApiBase, pingBase } from '../api.js';
import { el, icon, toast } from '../ui.js';

export function renderLogin(container, ctx) {
  const { navigate, state } = ctx;
  let passwordVisible = false;
  let loading = false;
  let showServerConfig = false;

  // ---- 海洋背景 ----
  const ocean = el('div', { className: 'login-ocean-bg', 'aria-hidden': 'true' }, [
    el('div', { className: 'login-ray ray-a' }),
  ]);

  // ---- 品牌区 ----
  const brand = el('div', { className: 'login-brand-area' }, [
    el('div', { className: 'login-logo-ring' }, [icon('waves', 32)]),
    el('h1', { textContent: '海瞳 HAITONG' }),
    el('p', { textContent: '海洋全域智守平台 · 移动端' }),
  ]);

  // ---- 表单字段 ----
  const usernameInput = el('input', {
    type: 'text', placeholder: '用户名', 'aria-label': '用户名',
    autocomplete: 'username', autocapitalize: 'none', spellcheck: false,
  });

  const passwordInput = el('input', {
    type: 'password', placeholder: '登录密码', 'aria-label': '登录密码',
    autocomplete: 'current-password',
  });

  const eyeBtn = el('button', {
    type: 'button', className: 'input-trailing', 'aria-label': '显示密码',
  }, [icon('eye', 18)]);

  const passwordWrap = el('div', { className: 'input-wrap' }, [
    el('span', { className: 'input-leading' }, [icon('lock', 18)]),
    passwordInput,
    eyeBtn,
  ]);

  eyeBtn.addEventListener('click', () => {
    passwordVisible = !passwordVisible;
    passwordInput.type = passwordVisible ? 'text' : 'password';
    eyeBtn.replaceChildren(icon(passwordVisible ? 'eyeOff' : 'eye', 18));
  });

  const usernameWrap = el('div', { className: 'input-wrap' }, [
    el('span', { className: 'input-leading' }, [icon('user', 18)]),
    usernameInput,
  ]);

  const rememberInput = el('input', { type: 'checkbox', checked: true });
  const rememberRow = el('label', { className: 'remember-row' }, [
    rememberInput,
    el('span', { textContent: '保持登录 30 天' }),
  ]);

  const errorBox = el('div', { className: 'login-error-msg', style: { display: 'none' } });

  const submitBtn = el('button', {
    type: 'submit', className: 'btn-primary btn-full',
  }, [
    el('span', { className: 'btn-text', textContent: '登录工作台' }),
    el('span', { className: 'btn-icon' }, [icon('chevronRight', 20)]),
  ]);

  const form = el('form', { className: 'login-form', autocomplete: 'on' }, [
    usernameWrap, passwordWrap, rememberRow, errorBox, submitBtn,
  ]);

  // ---- 服务器配置 ----
  const serverInput = el('input', {
    type: 'url', placeholder: 'http://192.168.1.100:8000',
    value: getApiBase(), autocapitalize: 'none', spellcheck: false,
  });

  const resetBtn = el('button', { type: 'button', className: 'btn-ghost btn-sm' },
    [icon('refresh', 15), '重置']);
  resetBtn.addEventListener('click', () => {
    resetApiBase();
    serverInput.value = getApiBase();
    toast('已重置为默认地址', 'info');
  });

  const testBtn = el('button', { type: 'button', className: 'btn-ghost btn-sm' },
    [icon('wifi', 15), '测试连接']);
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.replaceChildren(el('span', { className: 'spinner-mini' }), '测试中…');
    try {
      const url = serverInput.value.trim();
      const ok = await pingBase(url);
      if (ok) {
        setApiBase(url);
        toast('连接成功，已识别为海瞳后端', 'success');
      } else {
        toast('无法连接或服务身份不匹配，请检查地址', 'error');
      }
    } catch (err) {
      toast(err.message || '地址格式不正确', 'error');
    } finally {
      testBtn.disabled = false;
      testBtn.replaceChildren(icon('wifi', 15), '测试连接');
    }
  });

  const serverSection = el('div', { className: 'server-config', style: { display: 'none' } }, [
    el('p', { className: 'server-hint',
      textContent: '手机需填写运行后端的主机局域网 IP，如 http://192.168.1.100:8000' }),
    el('div', { className: 'input-wrap' }, [
      el('span', { className: 'input-leading' }, [icon('server', 18)]),
      serverInput,
    ]),
    el('div', { className: 'server-actions' }, [resetBtn, testBtn]),
  ]);

  const toggleArrow = el('span', { className: 'server-toggle-arrow' }, [icon('chevronRight', 16)]);
  const serverToggle = el('button', { type: 'button', className: 'server-toggle' }, [
    el('span', { className: 'server-toggle-icon' }, [icon('server', 16)]),
    el('span', { textContent: '高级连接设置' }),
    toggleArrow,
  ]);
  serverToggle.addEventListener('click', () => {
    showServerConfig = !showServerConfig;
    serverSection.style.display = showServerConfig ? 'block' : 'none';
    toggleArrow.replaceChildren(icon(showServerConfig ? 'chevronDown' : 'chevronRight', 16));
  });

  // ---- 组装 ----
  const card = el('div', { className: 'login-card glass-strong' }, [
    el('div', { className: 'login-card-header' }, [
      el('span', { className: 'login-eyebrow', textContent: 'SECURE MOBILE ACCESS' }),
      el('h2', { textContent: '欢迎回来' }),
      el('p', { textContent: '登录后进入随身监测与快速处置终端' }),
    ]),
    form,
    serverToggle,
    serverSection,
    el('p', { className: 'login-foot', textContent: '本系统仅供授权项目成员访问 · 请在受信任的网络环境下使用' }),
  ]);

  const page = el('div', { className: 'login-screen' }, [ocean, brand, card]);
  container.append(page);
  // ---- 登录提交 ----
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (loading) return;
    errorBox.style.display = 'none';
    loading = true;
    submitBtn.disabled = true;
    submitBtn.querySelector('.btn-text').textContent = '正在连接…';
    submitBtn.querySelector('.btn-icon').replaceChildren(el('span', { className: 'spinner-mini' }));

    try {
      // 地址变更时先探测连通性，通过后才保存（防止错误 IP 覆盖旧地址）
      const candidate = serverInput.value.trim();
      if (candidate !== getApiBase()) {
        const ok = await pingBase(candidate);
        if (!ok) {
          errorBox.textContent = '无法连接到该服务器，请确认地址、IP 和端口正确';
          errorBox.style.display = 'block';
          return;
        }
        setApiBase(candidate);
      }

      submitBtn.querySelector('.btn-text').textContent = '正在登录…';
      await api.login(usernameInput.value.trim(), passwordInput.value, rememberInput.checked);
      toast('登录成功', 'success');
      try { if (state) state.user = await api.getMe(); } catch { /* 忽略 */ }
      navigate('dashboard');
    } catch (err) {
      errorBox.textContent = err.message || '登录失败，请检查账号密码';
      errorBox.style.display = 'block';
      if (navigator.vibrate) navigator.vibrate([40, 20, 40]);
    } finally {
      loading = false;
      submitBtn.disabled = false;
      submitBtn.querySelector('.btn-text').textContent = '登录工作台';
      submitBtn.querySelector('.btn-icon').replaceChildren(icon('chevronRight', 20));
    }
  });

  return {};
}
