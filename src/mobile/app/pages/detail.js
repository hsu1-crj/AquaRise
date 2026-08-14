/**
 * detail.js — 任务详情页（全屏）
 * ============================================================
 * 用户友好设计：
 *   - 全屏沉浸式，带返回按钮
 *   - 任务概要卡（类型 / 状态 / 耗时 / 污染等级 / 质量评分）
 *   - 材质分布可视化（条形比例）
 *   - 识别目标列表（类别 / 置信度 / 材质）
 *   - 加载 / 错误 / 空状态完善
 *   - 下拉刷新
 */

import { api, getApiBase, isLoggedIn } from '../api.js';
import { el, clear, icon, toast, levelBadge, statusBadge, emptyState, errorState, timeAgo } from '../ui.js';

// 污染等级 → 环境质量分（与后端 POLLUTION_SCORE 对齐）
const LEVEL_SCORE = { '优': 95, '良': 80, '中': 68, '差': 50, '严重': 30 };
const LEVEL_COLORS = { '优': 'green', '良': 'cyan', '中': 'amber', '差': 'orange', '严重': 'red' };

export function renderDetail(container, ctx) {
  const { navigate, id } = ctx;
  let isMounted = true;
  let abortController = new AbortController();

  const page = el('div', { className: 'detail-page' });
  container.append(page);

  // ---- 返回栏 ----
  const backBar = el('header', { className: 'detail-topbar glass' }, [
    el('button', {
      className: 'btn-icon-circle',
      'aria-label': '返回',
      onClick: () => window.history.back(),
    }, [icon('arrowLeft', 20)]),
    el('h2', { textContent: '检测详情' }),
    el('button', {
      className: 'btn-icon-circle',
      'aria-label': '刷新',
      onClick: () => loadDetail(),
    }, [icon('refresh', 18)]),
  ]);
  page.append(backBar);

  // ---- 内容区 ----
  const content = el('div', { className: 'page-pad' });
  page.append(content);
  content.append(el('div', { className: 'detail-skeleton' }, [
    el('div', { className: 'skeleton-card' }),
    el('div', { className: 'skeleton-card' }),
  ]));

  async function loadDetail() {
    if (!isLoggedIn()) {
      clear(content);
      content.append(emptyState('fileChart', '演示模式下无详情数据', '请在主机端登录后查看检测结果'));
      return;
    }

    clear(content);
    content.append(el('div', { className: 'detail-skeleton' }, [
      el('div', { className: 'skeleton-card' }),
    ]));

    try {
      const [result, statusInfo] = await Promise.allSettled([
        api.getTaskResult(id, { signal: abortController.signal }),
        api.getTaskStatus(id, { signal: abortController.signal }),
      ]);
      if (!isMounted) return;

      if (result.status !== 'fulfilled') throw result.reason;
      renderDetailContent(content, result.value, statusInfo.status === 'fulfilled' ? statusInfo.value : null, navigate);
    } catch (err) {
      if (!isMounted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      clear(content);
      content.append(errorState(err.message || '加载详情失败', () => loadDetail()));
    }
  }

  loadDetail();

  return {
    unmount() {
      isMounted = false;
      abortController.abort();
    },
  };
}

function renderDetailContent(content, data, statusInfo, navigate) {
  clear(content);

  const isFinished = data.status === 'completed';
  const level = data.pollution_level
    ? levelFromEn(data.pollution_level)
    : (isFinished ? '未评估' : null);
  const score = level ? (LEVEL_SCORE[level] ?? 68) : null;
  const elapsed = statusInfo?.processing_time ?? data.processing_time;
  const colorClass = LEVEL_COLORS[level || ''] || 'cyan';

  // ---- 概要卡 ----
  content.append(el('div', { className: `detail-hero detail-hero-${colorClass} glass` }, [
    el('div', { className: 'detail-hero-top' }, [
      el('div', { className: `detail-type-icon type-${data.task_type}` },
        [icon(data.task_type === 'video' ? 'video' : 'image', 24)]),
      el('div', { className: 'detail-hero-title' }, [
        el('div', { className: 'detail-hero-row' }, [
          el('strong', { textContent: `${data.task_type === 'video' ? '视频' : '图片'}检测` }),
          statusBadge(statusZh(data.status)),
        ]),
        el('small', { textContent: data.file_name || `任务 #${data.task_id}` }),
      ]),
    ]),
    el('div', { className: 'detail-score-ring' }, [
      el('div', { className: 'score-ring-inner' }, [
        el('strong', { textContent: score ?? '—' }),
        el('small', { textContent: score != null ? '质量分' : '分析中' }),
      ]),
    ]),
  ]));

  // ---- 关键指标 ----
  content.append(el('div', { className: 'detail-metrics' }, [
    buildMetric('识别目标', isFinished ? `${data.total_objects ?? 0}` : '—', 'target'),
    buildMetric('污染等级', level || '分析中', 'droplet'),
    buildMetric('处理耗时', elapsed != null ? `${elapsed.toFixed(1)}s` : '—', 'clock'),
  ]));

  // 未完成任务：显示分析中提示，不渲染结果区
  if (!isFinished) {
    content.append(el('div', { className: 'detail-processing-hint' }, [
      el('span', { className: 'spinner-mini' }),
      el('span', { textContent: '主机端正在分析中，完成后将显示完整结果' }),
    ]));
    return;
  }

  // ---- 识别媒体（视频预览帧 / 标注视频 / 图片标注图） ----
  const mediaSection = buildMediaSection(data);
  if (mediaSection) content.append(mediaSection);

  // ---- 材质分布 ----
  const materials = data.material_breakdown || {};
  const materialKeys = Object.keys(materials);
  if (materialKeys.length) {
    const maxVal = Math.max(...Object.values(materials), 1);
    const matSection = el('section', { className: 'section-block' }, [
      el('h3', { className: 'section-title', textContent: '材质分布' }),
    ]);
    for (const [mat, count] of Object.entries(materials).sort((a, b) => b[1] - a[1])) {
      matSection.append(el('div', { className: 'material-row' }, [
        el('span', { className: 'material-label', textContent: mat }),
        el('div', { className: 'material-bar-track' }, [
          el('div', { className: 'material-bar-fill', style: { width: `${(count / maxVal) * 100}%` } }),
        ]),
        el('span', { className: 'material-count', textContent: count }),
      ]));
    }
    content.append(matSection);
  }

  // ---- 目标列表 ----
  const results = data.results || [];
  const objSection = el('section', { className: 'section-block' }, [
    el('h3', { className: 'section-title', textContent: `识别目标 (${results.length})` }),
  ]);
  if (!results.length) {
    objSection.append(emptyState('target', '未检测到目标', '该任务未识别到水下垃圾目标'));
  } else {
    const list = el('div', { className: 'object-list' });
    for (const r of results.slice(0, 100)) {
      list.append(el('div', { className: 'object-row glass' }, [
        el('div', { className: 'object-icon' }, [icon('target', 16)]),
        el('div', { className: 'object-info' }, [
          el('strong', { textContent: r.class_name || '未知' }),
          el('small', { textContent: r.material_type ? `材质：${r.material_type}` : '材质：未知' }),
        ]),
        el('div', { className: 'object-conf' }, [
          el('div', { className: 'conf-ring',
            style: { background: `conic-gradient(var(--cyan) ${(r.confidence ?? 0) * 360}deg, rgba(92,218,255,.12) 0)` } }, [
            el('span', { textContent: `${Math.round((r.confidence ?? 0) * 100)}%` }),
          ]),
        ]),
      ]));
    }
    objSection.append(list);
  }
  content.append(objSection);

  // ---- 生成报告按钮 ----
  if (data.status === 'completed' || statusZh(data.status) === '已完成') {
    content.append(el('button', {
      className: 'btn-primary btn-full detail-report-btn',
      onClick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.replaceChildren(el('span', { className: 'spinner-mini' }), '生成中…');
        try {
          await api.createReport(data.task_id);
          toast('报告已生成，可在主机端查看', 'success');
        } catch (err) {
          toast(err.message || '报告生成失败', 'error');
        } finally {
          btn.disabled = false;
          btn.replaceChildren(icon('fileChart', 18), '生成检测报告');
        }
      },
    }, [icon('fileChart', 18), '生成检测报告']));
  }
}

// ============ 工具 ============

function buildMetric(label, value, iconName) {
  return el('div', { className: 'detail-metric glass' }, [
    el('div', { className: 'detail-metric-icon' }, [icon(iconName, 18)]),
    el('div', {}, [
      el('strong', { textContent: String(value) }),
      el('small', { textContent: label }),
    ]),
  ]);
}

function levelFromEn(en) {
  const map = { excellent: '优', good: '良', moderate: '中', poor: '差', severe: '严重' };
  return map[en] || en || '优';
}

function statusZh(en) {
  const map = { pending: '处理中', processing: '处理中', completed: '已完成', failed: '失败' };
  return map[en] || en || '处理中';
}

/** 相对路径媒体 URL 拼接 API base：移动端从静态服务器(8080)访问后端(局域网 8000)时，
 *  后端返回的 /uploads/... 必须指向 API 基址，否则会被解析到静态服务器导致 404。 */
function resolveMediaUrl(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `${getApiBase()}${url}`;
}

/** 识别媒体区：视频 → 预览帧画廊 + 标注视频；图片 → 标注图（与主机端「查看详情」对齐）。
 *  无任何媒体时返回 null，不渲染空区块。 */
function buildMediaSection(data) {
  const isVideo = data.task_type === 'video';
  const urls = (data.preview_urls || []).filter(Boolean);
  const annotatedUrl = data.annotated_video_url;
  const imageUrl = data.media_url;

  if (isVideo) {
    if (!urls.length && !annotatedUrl) return null;
    const section = el('section', { className: 'section-block detail-media' }, [
      el('h3', { className: 'section-title', textContent: '识别预览' }),
    ]);

    if (urls.length) {
      // ---- 预览帧画廊：大图 + 缩略图条 ----
      let active = 0;
      const main = el('img', { className: 'media-gallery-main', src: resolveMediaUrl(urls[0]), alt: '预览帧 1', loading: 'lazy' });
      section.append(main);

      if (urls.length > 1) {
        const strip = el('div', { className: 'media-thumb-strip' });
        urls.forEach((url, i) => {
          strip.append(el('button', {
            className: `media-thumb${i === 0 ? ' active' : ''}`,
            'aria-label': `预览帧 ${i + 1}`,
            onClick: () => {
              active = i;
              main.src = resolveMediaUrl(url);
              main.alt = `预览帧 ${i + 1}`;
              strip.querySelectorAll('.media-thumb').forEach((t, j) => t.classList.toggle('active', j === active));
            },
          }, [el('img', { src: resolveMediaUrl(url), alt: `预览 ${i + 1}`, loading: 'lazy' })]));
        });
        section.append(strip);
      }
    } else {
      section.append(el('div', { className: 'media-empty' }, ['暂无标注预览']));
    }

    // ---- 标注视频（逐帧画框后回放） ----
    if (annotatedUrl) {
      section.append(el('div', { className: 'media-video-wrap' }, [
        el('video', { className: 'media-video', src: resolveMediaUrl(annotatedUrl), controls: true, playsInline: true, preload: 'metadata' }),
      ]));
    }
    return section;
  }

  // ---- 图片任务：标注图（已入库检测框画回原图） ----
  if (!imageUrl) return null;
  return el('section', { className: 'section-block detail-media' }, [
    el('h3', { className: 'section-title', textContent: '标注图' }),
    el('img', { className: 'media-image', src: resolveMediaUrl(imageUrl), alt: '标注图', loading: 'lazy' }),
  ]);
}
