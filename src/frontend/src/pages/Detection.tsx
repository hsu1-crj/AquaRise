import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, FileImage, FileText, FileVideo2, LoaderCircle, MapPinned, RotateCcw, ScanLine, ShieldCheck, UploadCloud, WandSparkles, X } from 'lucide-react';
import { api } from '../services/api';
import { useSeaArea } from '../context/SeaAreaContext';
import type { DetectionResult, MultiImageDetectItem, MultiImageDetectResponse, PageKey, SiteStat, VideoDetectResult, VideoTaskStatus } from '../types';
import { PreviewGallery, VideoResultCard, levelZh, QUALITY_SCORE } from '../components/resultViews';

const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const videoTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
const MAX_IMAGES = 50; // 一次最多选择的图片数（与后端 MAX_BATCH_IMAGES 一致）
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_SIZE = 500 * 1024 * 1024;

export function Detection({ onNavigate }: { onNavigate: (page: PageKey) => void }) {
  const [mode, setMode] = useState<'image' | 'video'>('image');
  // files / previews 一一对应；图片模式可多张，视频模式固定 0 或 1 张
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [result, setResult] = useState<MultiImageDetectResponse | null>(null);
  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoStatus, setVideoStatus] = useState<VideoTaskStatus | null>(null); // 视频实时进度轮询结果
  const [videoResult, setVideoResult] = useState<VideoDetectResult | null>(null); // 视频完成后去重目标列表
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [creatingReport, setCreatingReport] = useState(false); // 唯一"生成质量评估报告"按钮状态
  const [reportError, setReportError] = useState('');
  // 全局海域（侧边栏选择）：驱动本页站点筛选与上传归属；空值=全部海域
  const { seaAreaId } = useSeaArea();
  // 监测站点（F0）：上传时可选归属站点，写入任务 sea_area_id（侧边栏海域决定可选范围）；空值=不归属
  const [sites, setSites] = useState<SiteStat[]>([]);
  const [siteId, setSiteId] = useState<number | ''>('');
  useEffect(() => {
    let mounted = true;
    api.getSiteStats().then((list) => { if (mounted) setSites(list); }).catch(() => { /* 站点列表失败不阻塞上传 */ });
    return () => { mounted = false; };
  }, [seaAreaId]);
  // 仅展示所选海域下的站点（全部海域时展示全部）
  const visibleSites = sites.filter((s) => seaAreaId === '' || s.seaAreaId === seaAreaId);

  // 预览 object URL 生命周期：
  // 仅在真正移除/替换/卸载时回收，避免误回收仍被后续 previews 引用的 URL
  const previewsRef = useRef<string[]>([]);
  useEffect(() => { previewsRef.current = previews; }, [previews]);
  // 视频进度轮询定时器：卸载/重置时清除，避免状态更新泄漏
  const pollingRef = useRef<number | null>(null);
  const stopPolling = () => {
    if (pollingRef.current !== null) { window.clearTimeout(pollingRef.current); pollingRef.current = null; }
  };
  useEffect(() => {
    previewsRef.current.forEach((url) => URL.revokeObjectURL(url));
    stopPolling();
  }, []);

  const acceptTypes = mode === 'image' ? imageTypes : videoTypes;
  const maxSize = mode === 'image' ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE;

  const validateFile = (candidate: File): string | null => {
    if (!acceptTypes.includes(candidate.type)) {
      return mode === 'image' ? '仅支持 JPG、PNG、WebP 图片' : '仅支持 MP4、WebM、MOV 视频';
    }
    if (candidate.size > maxSize) {
      return `文件不能超过 ${mode === 'image' ? '10 MB' : '500 MB'}`;
    }
    return null;
  };

  const reset = () => {
    stopPolling();
    previews.forEach((url) => URL.revokeObjectURL(url));
    setFiles([]); setPreviews([]); setResult(null);
    setStatus('idle'); setMessage(''); setVideoProgress(0); setVideoStatus(null); setVideoResult(null); setBatchProgress(null);
    setCreatingReport(false); setReportError('');
  };

  const addFiles = (candidates: File[]) => {
    setResult(null); setStatus('idle'); setMessage(''); setBatchProgress(null);
    if (candidates.length === 0) return;

    if (mode === 'video') {
      const candidate = candidates[0];
      const err = validateFile(candidate);
      if (err) { setStatus('error'); setMessage(err); return; }
      if (previews[0]) URL.revokeObjectURL(previews[0]); // 替换视频，先回收旧预览
      setFiles([candidate]);
      setPreviews([URL.createObjectURL(candidate)]);
      setVideoProgress(0);
      return;
    }

    // 图片模式：逐张校验，跳过重复，追加合法文件
    const valid: File[] = [];
    let invalidMsg = '';
    for (const candidate of candidates) {
      if (files.some((f) => f.name === candidate.name && f.size === candidate.size)) continue;
      const err = validateFile(candidate);
      if (err) { invalidMsg = err; continue; }
      if (files.length + valid.length >= MAX_IMAGES) { invalidMsg = `一次最多选择 ${MAX_IMAGES} 张图片`; break; }
      valid.push(candidate);
    }
    if (valid.length === 0) {
      if (invalidMsg) { setStatus('error'); setMessage(invalidMsg); }
      return;
    }
    setFiles((prev) => [...prev, ...valid]);
    setPreviews((prev) => [...prev, ...valid.map((f) => URL.createObjectURL(f))]);
  };

  const removeFile = (index: number) => {
    URL.revokeObjectURL(previews[index]); // 仅回收被移除的这一张
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
    setResult(null); setStatus('idle'); setMessage('');
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(Array.from(event.target.files));
    event.target.value = ''; // 允许重复选择同一文件
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files) addFiles(Array.from(event.dataTransfer.files));
  };

  const runDetection = async () => {
    if (files.length === 0) return;
    setStatus('processing'); setMessage(''); setResult(null); setVideoResult(null);
    setCreatingReport(false); setReportError('');

    if (mode === 'image') {
      setBatchProgress({ current: 0, total: files.length });
      try {
        const res = await api.detectImages(files, (current, total) => setBatchProgress({ current, total }), seaAreaId === '' ? undefined : seaAreaId);
        setResult(res);
        if (res.successCount === 0 && res.failCount > 0) {
          setStatus('error');
          setMessage(res.items[0]?.error || '识别失败，请检查图片格式');
        } else {
          setStatus('done');
        }
      } catch (reason) {
        setStatus('error');
        setMessage(reason instanceof Error ? reason.message : '识别任务失败，请重试');
      } finally {
        setBatchProgress(null);
      }
    } else {
      try {
        const { taskId } = await api.createVideoTask(files[0], seaAreaId === '' ? undefined : seaAreaId);
        if (!taskId) { throw new Error('未获取到任务编号'); }
        setVideoProgress(0); setVideoStatus(null);
        // 轮询实时进度：展示真实帧处理进度 + 标注预览帧，直到完成/失败
        const poll = async () => {
          const statusInfo = await api.getVideoStatus(taskId);
          setVideoStatus(statusInfo);
          setVideoProgress(statusInfo.progress);
          if (statusInfo.status === 'completed' || statusInfo.status === 'failed') {
            if (statusInfo.status === 'failed') { setStatus('error'); setMessage('视频识别失败，请重试'); }
            else {
              setStatus('done');
              // 拉取去重后的垃圾目标列表，供结果卡片展示
              try {
                const resultInfo = await api.getVideoResult(taskId);
                setVideoResult(resultInfo);
              } catch { /* 列表拉取失败不阻塞完成态，仅少展示清单 */ }
            }
            return;
          }
          pollingRef.current = window.setTimeout(poll, 1200);
        };
        await poll();
      } catch (reason) {
        stopPolling();
        setStatus('error');
        setMessage(reason instanceof Error ? reason.message : '识别任务失败，请重试');
      }
    }
  };

  /** 为当前视频识别任务生成质量报告（与多图"生成报告"同一后端接口） */
  const createVideoReport = async () => {
    const taskId = videoStatus?.taskId;
    if (taskId == null) return;
    setCreatingReport(true); setReportError('');
    try {
      await api.createReport(String(taskId));
      onNavigate('reports');
    } catch (reason) {
      setReportError(reason instanceof Error ? reason.message : '报告生成失败，请重试');
    } finally {
      setCreatingReport(false);
    }
  };

  /** 基于本次批量识别的全部成功图片，聚合生成一份报告 */
  const createBatchReport = async () => {
    if (!result) return;
    const taskIds = result.items
      .filter((i) => i.success && i.result?.taskId)
      .map((i) => i.result!.taskId);
    if (taskIds.length === 0) return;
    setCreatingReport(true); setReportError('');
    try {
      await api.createBatchReport(taskIds);
      onNavigate('reports');
    } catch (reason) {
      setReportError(reason instanceof Error ? reason.message : '报告生成失败，请重试');
    } finally {
      setCreatingReport(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="page-heading compact"><div><span className="eyebrow"><i /> AI VISION LAB</span><h1>水下垃圾智能识别</h1><p>上传水下影像，模型将自动定位垃圾、判断类别并评估污染质量。</p></div><div className="model-status glass"><span><i />模型在线</span><strong>YOLO11 · TrashCan 22 类</strong><em>平均响应 1.8s</em></div></section>
      <div className="mode-switch glass"><button className={mode === 'image' ? 'active' : ''} onClick={() => { setMode('image'); reset(); }}><FileImage />图片检测<span>多图批量识别</span></button><button className={mode === 'video' ? 'active' : ''} onClick={() => { setMode('video'); reset(); }}><FileVideo2 />视频检测<span>异步逐帧分析</span></button></div>

      <section className="detection-workspace">
        <article className="upload-panel panel glass">
          <header><div><span>01</span><h2>上传{mode === 'image' ? '图片' : '视频'}</h2></div><small>{mode === 'image' && files.length > 0 ? `已选择 ${files.length} 张图片` : '数据仅用于本次识别分析'}</small></header>
          {mode === 'image' ? (
            files.length === 0 ? (
              <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
                <input type="file" accept={imageTypes.join(',')} multiple onChange={handleInput} />
                <div className="upload-orb"><UploadCloud /></div><h3>拖拽文件到此处，或 <span>浏览文件</span></h3><p>支持 JPG、PNG、WebP，最大 10 MB，可一次选择多张</p>
                <div className="upload-tips"><span><CheckCircle2 />自动图像增强</span><span><CheckCircle2 />22 类目标识别</span><span><CheckCircle2 />质量评估报告</span></div>
              </label>
            ) : (
              <div className="thumb-grid">
                {previews.map((url, index) => (
                  <div className="thumb-item" key={url}>
                    <img src={url} alt={files[index]?.name ?? ''} />
                    <button className="remove-file" onClick={() => removeFile(index)} aria-label={`移除 ${files[index]?.name ?? '图片'}`}><X /></button>
                    <span>{files[index]?.name}</span>
                  </div>
                ))}
                {files.length < MAX_IMAGES && (
                  <label className="thumb-add" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
                    <input type="file" accept={imageTypes.join(',')} multiple onChange={handleInput} />
                    <UploadCloud />添加图片
                  </label>
                )}
              </div>
            )
          ) : (
            !previews[0] ? (
              <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
                <input type="file" accept={videoTypes.join(',')} onChange={handleInput} />
                <div className="upload-orb"><UploadCloud /></div><h3>拖拽文件到此处，或 <span>浏览文件</span></h3><p>支持 MP4、WebM、MOV，最大 500 MB</p>
                <div className="upload-tips"><span><CheckCircle2 />自动图像增强</span><span><CheckCircle2 />22 类目标识别</span><span><CheckCircle2 />质量评估报告</span></div>
              </label>
            ) : (
              <div className="preview-stage">
                {videoStatus?.previewUrl ? <img className="live-preview" src={videoStatus.previewUrl} alt="AI 实时检测预览" /> : <video src={previews[0]} controls />}
                {status === 'processing' && <div className="scanning-overlay"><div className="scan-beam" /><div><LoaderCircle className="spin" /><strong>AI 正在分析影像</strong><span>逐帧检测 · 材质判断 · 污染评级</span></div></div>}
                <button className="remove-file" onClick={reset} aria-label="移除文件"><X /></button>
                <div className="file-chip"><FileVideo2 /><div><strong>{files[0]?.name}</strong><small>{files[0] ? (files[0].size / 1024 / 1024).toFixed(2) : 0} MB</small></div></div>
              </div>
            )
          )}
          {status === 'error' && <div className="inline-error"><AlertCircle />{message}<button onClick={runDetection}>重试</button></div>}
          {status === 'processing' && mode === 'image' && (
            <div className="progress-block">
              <div><span>{batchProgress ? `正在识别 ${batchProgress.current}/${batchProgress.total} 张图片` : `正在识别 ${files.length} 张图片`}</span>{batchProgress && <strong>{Math.round((batchProgress.current / batchProgress.total) * 100)}%</strong>}</div>
              {batchProgress && <div className="progress-track"><i style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }} /></div>}
              <small>图片逐张识别，请稍候</small>
            </div>
          )}
          {status === 'processing' && mode === 'video' && (
            <div className="progress-block">
              <div><span>{videoStatus?.processedFrames != null && videoStatus?.totalFrames ? `已处理 ${videoStatus.processedFrames}/${videoStatus.totalFrames} 帧` : '正在逐帧识别'}</span><strong>{videoProgress}%</strong></div>
              <div className="progress-track"><i style={{ width: `${videoProgress}%` }} /></div>
              <small>页面可安全离开，任务会在后台继续处理</small>
            </div>
          )}
          <footer><div className="site-select-row"><label className="period-select" title="任务归属的监测站点（可选），用于分海域统计与对比；范围由侧边栏所选海域决定"><MapPinned /><select value={siteId} onChange={(event) => setSiteId(event.target.value === '' ? '' : Number(event.target.value))} disabled={status === 'processing'}><option value="">不指定监测点</option>{visibleSites.map((site) => <option key={site.id} value={site.id}>{site.code} · {site.name}</option>)}</select></label>{visibleSites.length === 0 && <small className="site-select-hint">当前海域暂无监测点，任务将按所选海域归属</small>}</div><button className="secondary-button" onClick={reset} disabled={files.length === 0 || status === 'processing'}><RotateCcw />重新选择</button><button className="primary-button wide" disabled={files.length === 0 || status === 'processing'} onClick={runDetection}>{status === 'processing' ? <><LoaderCircle className="spin" />正在识别</> : mode === 'image' ? <><ScanLine />识别 {files.length} 张图片</> : <><ScanLine />开始 AI 识别</>}</button></footer>
        </article>

        <article className="result-panel panel glass">
          <header><div><span>02</span><h2>识别结果</h2></div>{status === 'done' && mode === 'image' && <em className="success-tag"><CheckCircle2 />分析完成{result && result.failCount > 0 ? ` · ${result.successCount} 成功 / ${result.failCount} 失败` : ''}</em>}{status === 'done' && mode === 'video' && <em className="success-tag"><CheckCircle2 />分析完成</em>}</header>
          {mode === 'image' ? (
            !result ? (
              <ResultEmpty />
            ) : (
              <>
                <div className="result-card-list">
                  {result.items.map((item, index) => (
                    <ResultCard key={`${item.fileName}-${index}`} item={item} preview={previews[index] ?? ''} />
                  ))}
                </div>
                {result.successCount > 0 && (
                  <footer className="result-panel-footer">
                    <button className="primary-button wide" disabled={creatingReport} onClick={createBatchReport}>
                      {creatingReport ? <LoaderCircle className="spin" /> : <FileImage />}生成质量评估报告{result.successCount > 1 ? `（${result.successCount} 张）` : ''}
                    </button>
                    {reportError && <div className="inline-error"><AlertCircle />{reportError}</div>}
                  </footer>
                )}
              </>
            )
          ) : mode === 'video' && status === 'processing' ? (
            <div className="result-empty video-live-gallery">
              <div><LoaderCircle className="spin" /></div>
              <h3>正在逐帧分析</h3>
              <p>{videoStatus?.processedFrames != null && videoStatus?.totalFrames ? `已处理 ${videoStatus.processedFrames}/${videoStatus.totalFrames} 帧 · 已捕获 ${videoStatus?.previewUrls?.length ?? 0} 个画面` : '检测到新画面时自动追加预览图'}</p>
              <PreviewGallery urls={videoStatus?.previewUrls ?? []} />
            </div>
          ) : status === 'done' ? (
            <>
              <div className="result-card-list">
                <VideoResultCard fileName={files[0]?.name ?? '视频'} status={videoStatus} result={videoResult} />
              </div>
              <footer className="result-panel-footer">
                <button className="primary-button wide" disabled={creatingReport} onClick={createVideoReport}>
                  {creatingReport ? <LoaderCircle className="spin" /> : <FileText />}生成质量评估报告
                </button>
                <button className="secondary-button" onClick={() => onNavigate('history')}>查看检测历史<ArrowRight /></button>
                {reportError && <div className="inline-error"><AlertCircle />{reportError}</div>}
              </footer>
            </>
          ) : (
            <ResultEmpty />
          )}
        </article>
      </section>
      <div className="privacy-note"><ShieldCheck />上传内容通过项目内网传输；生产环境将由 FastAPI 校验文件类型、大小与权限。</div>
    </div>
  );
}

function ResultEmpty() {
  return <div className="result-empty"><div><WandSparkles /></div><h3>等待影像分析</h3><p>识别结果、置信度与环境质量建议将在这里展示。</p><ol><li><span>1</span>上传水下图片或视频</li><li><span>2</span>启动 AI 智能识别</li><li><span>3</span>生成污染质量报告</li></ol></div>;
}

/** 单张图片的结果卡片：缩略图 + 检测框 canvas + 统计 + 可展开目标列表 */
function ResultCard({ item, preview }: { item: MultiImageDetectItem; preview: string }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [expanded, setExpanded] = useState(true); // 默认展开目标列表，与单图模式一致

  if (!item.success || !item.result) {
    return (
      <div className="result-card failed">
        {preview && <img src={preview} alt={item.fileName} />}
        <div className="result-card-info"><strong>{item.fileName}</strong><span className="error-text">{item.error || '识别失败'}</span></div>
      </div>
    );
  }

  const result = item.result;

  return (
    <div className="result-card">
      <div className="result-card-media">
        <img ref={imageRef} src={preview} alt={item.fileName} onLoad={() => setImgLoaded(true)} />
        {imgLoaded && <DetectionCanvas image={imageRef.current} result={result} />}
      </div>
      <div className="result-card-info">
        <strong title={item.fileName}>{item.fileName}</strong>
        <div className="result-card-tags">
          <span className={`level-badge level-${result.pollutionLevel}`}>{result.pollutionLevel}度污染</span>
          <span>质量分 {result.qualityScore}</span>
        </div>
        <p>发现 {result.objects.length} 个垃圾目标 · 密度 {result.density}/㎡</p>
        <button className="secondary-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起目标列表' : `目标列表${result.objects.length > 0 ? `（${result.objects.length}）` : ''}`}</button>
        {expanded && (
          <div className="object-list">
            {result.objects.length === 0 && <p style={{ fontSize: 9, color: 'var(--muted)', margin: 0 }}>本图未检出垃圾目标</p>}
            {result.objects.map((object) => (
              <div key={object.id}><span>{object.labelZh}</span><em>{object.material}</em><div><i style={{ width: `${object.confidence * 100}%` }} /></div><strong>{(object.confidence * 100).toFixed(0)}%</strong></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DetectionCanvas({ image, result }: { image: HTMLImageElement | null; result: DetectionResult | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !result) return;
    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      const rect = image.getBoundingClientRect();
      if (!rect.width || !rect.height) return; // 图片尚未布局，等 ResizeObserver 触发后重画
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
      canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.scale(ratio, ratio);
      const scaleX = rect.width / result.sourceWidth; const scaleY = rect.height / result.sourceHeight;
      result.objects.forEach((object, index) => {
        const [x, y, width, height] = object.bbox;
        const color = ['#21e6ff', '#65ffb2', '#ffbd66'][index % 3];
        context.strokeStyle = color; context.lineWidth = 2; context.shadowColor = color; context.shadowBlur = 8;
        context.strokeRect(x * scaleX, y * scaleY, width * scaleX, height * scaleY);
        const label = `${object.labelZh} ${(object.confidence * 100).toFixed(0)}%`;
        context.font = '600 12px sans-serif';
        const labelWidth = context.measureText(label).width + 16;
        context.fillStyle = color; context.shadowBlur = 0; context.fillRect(x * scaleX, Math.max(0, y * scaleY - 24), labelWidth, 24);
        context.fillStyle = '#032233'; context.fillText(label, x * scaleX + 8, Math.max(16, y * scaleY - 8));
      });
    };
    // 图片可能已加载完成（浏览器缓存），也可能仍在加载——两种情况都要能绘制
    if (image.complete && image.naturalWidth > 0) {
      draw();
    } else {
      image.addEventListener('load', draw);
    }
    const observer = new ResizeObserver(draw); observer.observe(image);
    return () => { cancelled = true; observer.disconnect(); image.removeEventListener('load', draw); };
  }, [image, result]);
  return <canvas ref={canvasRef} className="detection-canvas" aria-label="AI 检测标注层" />;
}
