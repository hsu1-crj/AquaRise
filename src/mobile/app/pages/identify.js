import { api } from '../api.js';
import { el, clear, icon, toast } from '../ui.js';
import { getSelectedSeaArea, setSelectedSeaArea } from '../preferences.js';

const MAX_IMAGES = 9;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export function renderIdentify(container, ctx) {
  const { navigate, state } = ctx;
  let files = [];
  let kind = 'image';
  let objectUrls = [];
  let uploadController = null;
  let mounted = true;

  const page = el('div', { className: 'page-pad identify-page' });
  const cameraInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', className: 'sr-only' });
  const galleryInput = el('input', { type: 'file', accept: 'image/*', multiple: true, className: 'sr-only' });
  const fileInput = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, className: 'sr-only' });
  const videoInput = el('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/x-msvideo,video/x-matroska', className: 'sr-only' });
  page.append(cameraInput, galleryInput, fileInput, videoInput);

  page.append(el('section', { className: 'identify-hero glass' }, [
    el('span', { className: 'eyebrow', textContent: '移动端核心动作' }),
    el('h1', { textContent: '拍下海洋现场，立即发起识别' }),
    el('p', { textContent: '任务提交后可离开此页，服务端会继续处理。' }),
  ]));

  const sourceGrid = el('div', { className: 'capture-grid' }, [
    sourceButton('camera', '拍照识别', '调用后置摄像头', () => cameraInput.click(), true),
    sourceButton('image', '从相册选择', `最多 ${MAX_IMAGES} 张`, () => galleryInput.click()),
    sourceButton('upload', '选择图片文件', 'JPG / PNG / WebP', () => fileInput.click()),
  ]);
  page.append(el('section', { className: 'section-block' }, [
    el('h2', { className: 'section-title', textContent: '选择影像' }), sourceGrid,
  ]));

  const videoToggle = el('button', { className: 'video-entry', type: 'button' }, [
    el('span', { className: 'video-entry-icon' }, [icon('video', 21)]),
    el('span', { className: 'video-entry-copy' }, [
      el('strong', { textContent: '视频检测' }),
      el('small', { textContent: '按文件大小消耗流量，移动网络下会再次确认' }),
    ]),
    icon('chevronRight', 18),
  ]);
  videoToggle.addEventListener('click', () => videoInput.click());
  page.append(videoToggle);

  const selection = el('section', { className: 'selection-panel', style: { display: 'none' } });
  page.append(selection);

  const seaSelect = el('select', { className: 'field-select', 'aria-label': '目标海域' }, [
    el('option', { value: '', textContent: '加载海域…' }),
  ]);
  seaSelect.addEventListener('change', () => {
    const option = seaSelect.selectedOptions[0];
    const area = { id: option.value ? Number(option.value) : null, name: option.textContent };
    setSelectedSeaArea(area);
    state.selectedSeaArea = area;
  });
  page.append(el('section', { className: 'section-block sea-confirm' }, [
    el('div', {}, [
      el('h2', { className: 'section-title', textContent: '目标海域' }),
      el('p', { className: 'section-note', textContent: '识别结果、任务与报告将沿用此海域。' }),
    ]),
    seaSelect,
  ]));

  const progressPanel = el('div', { className: 'upload-panel', style: { display: 'none' } });
  const submitBtn = el('button', { type: 'button', className: 'btn-primary btn-full identify-submit', disabled: true }, [
    icon('upload', 19), '确认并创建任务',
  ]);
  submitBtn.addEventListener('click', submit);
  page.append(progressPanel, submitBtn);
  container.append(page);

  for (const input of [cameraInput, galleryInput, fileInput]) {
    input.addEventListener('change', () => selectFiles([...input.files], 'image'));
  }
  videoInput.addEventListener('change', () => selectFiles([...videoInput.files], 'video'));
  loadSeaAreas();

  async function loadSeaAreas() {
    try {
      const areas = await api.getSeaAreas();
      if (!mounted) return;
      clear(seaSelect);
      const selected = getSelectedSeaArea();
      seaSelect.append(el('option', { value: '', textContent: '未指定（全域）' }));
      for (const area of areas || []) {
        seaSelect.append(el('option', { value: String(area.id), textContent: area.name }));
      }
      seaSelect.value = selected.id ? String(selected.id) : '';
    } catch {
      clear(seaSelect);
      seaSelect.append(el('option', { value: '', textContent: '未指定（全域）' }));
    }
  }

  function selectFiles(nextFiles, nextKind) {
    if (!nextFiles.length) return;
    const valid = [];
    for (const file of nextFiles) {
      const limit = nextKind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (file.size > limit) {
        toast(`${file.name} 超过 ${nextKind === 'video' ? '500 MB' : '20 MB'} 限制`, 'warning');
      } else {
        valid.push(file);
      }
    }
    if (nextKind === 'image' && valid.length > MAX_IMAGES) {
      toast(`手机端单批最多 ${MAX_IMAGES} 张，已保留前 ${MAX_IMAGES} 张`, 'warning');
      valid.splice(MAX_IMAGES);
    }
    files = nextKind === 'video' ? valid.slice(0, 1) : valid;
    kind = nextKind;
    renderSelection();
  }

  function renderSelection() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
    clear(selection);
    if (!files.length) {
      selection.style.display = 'none';
      submitBtn.disabled = true;
      return;
    }
    selection.style.display = '';
    submitBtn.disabled = false;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    selection.append(el('div', { className: 'selection-head' }, [
      el('div', {}, [
        el('strong', { textContent: kind === 'video' ? '已选择 1 个视频' : `已选择 ${files.length} 张图片` }),
        el('small', { textContent: `总计 ${formatBytes(total)}` }),
      ]),
      el('button', { className: 'icon-btn', 'aria-label': '清除选择', onClick: () => { files = []; renderSelection(); } }, [icon('x', 18)]),
    ]));
    const previews = el('div', { className: 'selection-previews' });
    for (const file of files) {
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      previews.append(kind === 'video'
        ? el('div', { className: 'video-placeholder' }, [icon('video', 24), el('span', { textContent: file.name })])
        : el('img', { src: url, alt: file.name }));
    }
    selection.append(previews);
  }

  async function submit() {
    if (!files.length || uploadController) return;
    const connection = navigator.connection;
    if (kind === 'video' && (connection?.saveData || (connection?.type && connection.type !== 'wifi'))) {
      if (!window.confirm(`当前可能不是 Wi-Fi，上传将消耗约 ${formatBytes(files[0].size)} 流量。继续吗？`)) return;
    }

    uploadController = new AbortController();
    submitBtn.disabled = true;
    progressPanel.style.display = '';
    const bar = el('div', { className: 'upload-track' }, [el('i', { style: { transform: 'scaleX(0)' } })]);
    const status = el('strong', { textContent: '正在上传 0%' });
    const cancel = el('button', { className: 'btn-ghost btn-sm', onClick: () => uploadController?.abort() }, ['取消上传']);
    clear(progressPanel);
    progressPanel.append(el('div', { className: 'upload-status' }, [status, cancel]), bar,
      el('small', { textContent: '上传完成后将进入服务端识别阶段，请勿重复提交。' }));

    const opts = {
      signal: uploadController.signal,
      onProgress(percent) {
        status.textContent = `正在上传 ${percent}%`;
        bar.firstElementChild.style.transform = `scaleX(${percent / 100})`;
        if (percent === 100) status.textContent = '上传完成，服务端正在识别…';
      },
    };

    try {
      if (kind === 'video') {
        const result = await api.detectVideo(files[0], seaSelect.value || null, opts);
        toast('视频任务已创建，可在任务中心跟踪', 'success');
        navigate('detail', { id: result.task_id });
      } else {
        const result = await api.detectImages(files, seaSelect.value || null, opts);
        const succeeded = (result?.items || []).filter((item) => item.success && item.result?.taskId);
        if (!succeeded.length) throw new Error(result?.items?.[0]?.error || '图片识别未创建任务');
        toast(`${succeeded.length} 个识别任务已完成${result.failCount ? `，${result.failCount} 个失败` : ''}`, result.failCount ? 'warning' : 'success');
        if (succeeded.length === 1) navigate('detail', { id: succeeded[0].result.taskId });
        else navigate('tasks');
      }
    } catch (error) {
      if (error?.name === 'AbortError') toast('上传已取消', 'info');
      else toast(error?.message || '任务创建失败', 'error');
      progressPanel.style.display = 'none';
      submitBtn.disabled = false;
    } finally {
      uploadController = null;
    }
  }

  return {
    unmount() {
      mounted = false;
      uploadController?.abort();
      for (const url of objectUrls) URL.revokeObjectURL(url);
    },
  };
}

function sourceButton(iconName, title, subtitle, onClick, primary = false) {
  return el('button', { type: 'button', className: `capture-option${primary ? ' primary' : ''}`, onClick }, [
    el('span', { className: 'capture-icon' }, [icon(iconName, 23)]),
    el('strong', { textContent: title }),
    el('small', { textContent: subtitle }),
  ]);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
