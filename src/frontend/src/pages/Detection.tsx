import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, FileImage, FileVideo2, LoaderCircle, RotateCcw, ScanLine, ShieldCheck, UploadCloud, WandSparkles, X } from 'lucide-react';
import { api } from '../services/api';
import type { DetectionResult, PageKey } from '../types';

const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const videoTypes = ['video/mp4', 'video/webm', 'video/quicktime'];

export function Detection({ onNavigate }: { onNavigate: (page: PageKey) => void }) {
  const [mode, setMode] = useState<'image' | 'video'>('image');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const validateAndSet = (candidate: File) => {
    const allowedTypes = mode === 'image' ? imageTypes : videoTypes;
    const maxSize = mode === 'image' ? 10 * 1024 * 1024 : 500 * 1024 * 1024;
    if (!allowedTypes.includes(candidate.type)) { setStatus('error'); setMessage(`请选择${mode === 'image' ? 'JPG、PNG 或 WebP 图片' : 'MP4、WebM 或 MOV 视频'}`); return; }
    if (candidate.size > maxSize) { setStatus('error'); setMessage(`文件不能超过 ${mode === 'image' ? '10 MB' : '500 MB'}`); return; }
    if (preview) URL.revokeObjectURL(preview);
    setFile(candidate);
    setPreview(URL.createObjectURL(candidate));
    setResult(null);
    setProgress(0);
    setStatus('idle');
    setMessage('');
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    const candidate = event.target.files?.[0];
    if (candidate) validateAndSet(candidate);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    const candidate = event.dataTransfer.files[0];
    if (candidate) validateAndSet(candidate);
  };

  const reset = () => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null); setPreview(''); setResult(null); setStatus('idle'); setMessage(''); setProgress(0);
  };

  const runDetection = async () => {
    if (!file) return;
    setStatus('processing'); setMessage('');
    try {
      if (mode === 'image') {
        const width = imageRef.current?.naturalWidth ?? 1280;
        const height = imageRef.current?.naturalHeight ?? 720;
        const payload = await api.detectImage(file, width, height);
        setResult(payload); setProgress(100); setStatus('done');
      } else {
        await api.createVideoTask(file);
        for (const value of [12, 27, 46, 68, 86, 100]) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 260));
          setProgress(value);
        }
        setStatus('done');
      }
    } catch (reason) {
      setStatus('error');
      setMessage(reason instanceof Error ? reason.message : '识别任务失败，请重试');
    }
  };

  return (
    <div className="page-stack">
      <section className="page-heading compact"><div><span className="eyebrow"><i /> AI VISION LAB</span><h1>水下垃圾智能识别</h1><p>上传水下影像，模型将自动定位垃圾、判断类别并评估污染质量。</p></div><div className="model-status glass"><span><i />模型在线</span><strong>YOLO11 · TrashCan 22 类</strong><em>平均响应 1.8s</em></div></section>
      <div className="mode-switch glass"><button className={mode === 'image' ? 'active' : ''} onClick={() => { setMode('image'); reset(); }}><FileImage />图片检测<span>单张快速识别</span></button><button className={mode === 'video' ? 'active' : ''} onClick={() => { setMode('video'); reset(); }}><FileVideo2 />视频检测<span>异步逐帧分析</span></button></div>

      <section className="detection-workspace">
        <article className="upload-panel panel glass">
          <header><div><span>01</span><h2>上传{mode === 'image' ? '图片' : '视频'}</h2></div><small>数据仅用于本次识别分析</small></header>
          {!preview ? (
            <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
              <input type="file" accept={mode === 'image' ? imageTypes.join(',') : videoTypes.join(',')} onChange={handleInput} />
              <div className="upload-orb"><UploadCloud /></div><h3>拖拽文件到此处，或 <span>浏览文件</span></h3><p>{mode === 'image' ? '支持 JPG、PNG、WebP，最大 10 MB' : '支持 MP4、WebM、MOV，最大 500 MB'}</p>
              <div className="upload-tips"><span><CheckCircle2 />自动图像增强</span><span><CheckCircle2 />22 类目标识别</span><span><CheckCircle2 />质量评估报告</span></div>
            </label>
          ) : (
            <div className="preview-stage">
              {mode === 'image' ? <><img ref={imageRef} src={preview} alt="待检测水下图片预览" /><DetectionCanvas image={imageRef.current} result={result} /></> : <video src={preview} controls />}
              {status === 'processing' && <div className="scanning-overlay"><div className="scan-beam" /><div><LoaderCircle className="spin" /><strong>AI 正在分析影像</strong><span>目标检测 · 材质判断 · 污染评级</span></div></div>}
              <button className="remove-file" onClick={reset} aria-label="移除文件"><X /></button>
              <div className="file-chip"><FileImage /><div><strong>{file?.name}</strong><small>{file ? (file.size / 1024 / 1024).toFixed(2) : 0} MB</small></div></div>
            </div>
          )}
          {status === 'error' && <div className="inline-error"><AlertCircle />{message}<button onClick={runDetection}>重试</button></div>}
          {status === 'processing' && mode === 'video' && <div className="progress-block"><div><span>正在创建异步任务</span><strong>{progress}%</strong></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div><small>页面可安全离开，任务会在后台继续处理</small></div>}
          <footer><button className="secondary-button" onClick={reset} disabled={!file || status === 'processing'}><RotateCcw />重新选择</button><button className="primary-button wide" disabled={!file || status === 'processing'} onClick={runDetection}>{status === 'processing' ? <><LoaderCircle className="spin" />正在识别</> : <><ScanLine />开始 AI 识别</>}</button></footer>
        </article>

        <article className="result-panel panel glass">
          <header><div><span>02</span><h2>识别结果</h2></div>{result && <em className="success-tag"><CheckCircle2 />分析完成</em>}</header>
          {!result && status !== 'done' ? <div className="result-empty"><div><WandSparkles /></div><h3>等待影像分析</h3><p>识别结果、置信度与环境质量建议将在这里展示。</p><ol><li><span>1</span>上传水下图片或视频</li><li><span>2</span>启动 AI 智能识别</li><li><span>3</span>生成污染质量报告</li></ol></div> : result ? <ResultDetails result={result} onNavigate={onNavigate} /> : <div className="result-empty"><div><CheckCircle2 /></div><h3>视频任务已创建</h3><p>任务已进入后台处理队列，可前往检测历史查看进度。</p><button className="primary-button" onClick={() => onNavigate('history')}>查看检测历史<ArrowRight /></button></div>}
        </article>
      </section>
      <div className="privacy-note"><ShieldCheck />上传内容通过项目内网传输；生产环境将由 FastAPI 校验文件类型、大小与权限。</div>
    </div>
  );
}

function DetectionCanvas({ image, result }: { image: HTMLImageElement | null; result: DetectionResult | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !result) return;
    const draw = () => {
      const rect = image.getBoundingClientRect();
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
    draw();
    const observer = new ResizeObserver(draw); observer.observe(image);
    return () => observer.disconnect();
  }, [image, result]);
  return <canvas ref={canvasRef} className="detection-canvas" aria-label="AI 检测标注层" />;
}

function ResultDetails({ result, onNavigate }: { result: DetectionResult; onNavigate: (page: PageKey) => void }) {
  const [creating, setCreating] = useState(false);
  const [reportError, setReportError] = useState('');
  const createReport = async () => {
    setCreating(true);
    setReportError('');
    try {
      await api.createReport(result.taskId);
      onNavigate('reports');
    } catch (reason) {
      setReportError(reason instanceof Error ? reason.message : '报告生成失败，请重试');
    } finally {
      setCreating(false);
    }
  };
  return <div className="result-details"><div className="quality-score"><div style={{ '--score': result.qualityScore } as React.CSSProperties}><strong>{result.qualityScore}</strong><span>环境质量分</span></div><section><span className={`level-badge level-${result.pollutionLevel}`}>{result.pollutionLevel}度污染</span><h3>发现 {result.objects.length} 个垃圾目标</h3><p>垃圾密度 {result.density}/㎡ · 建议安排现场复核</p></section></div><div className="object-list">{result.objects.map((object) => <div key={object.id}><span>{object.labelZh}</span><em>{object.material}</em><div><i style={{ width: `${object.confidence * 100}%` }} /></div><strong>{(object.confidence * 100).toFixed(0)}%</strong></div>)}</div><div className="suggestion-card"><ShieldCheck /><div><strong>AI 处置建议</strong><p>优先回收废弃渔网，避免海洋生物缠绕；塑料与金属垃圾建议分类转运。</p></div></div><>{reportError && <div className="inline-error"><AlertCircle />{reportError}</div>}<button className="primary-button report-button" disabled={creating} onClick={createReport}>{creating ? <LoaderCircle className="spin" /> : <FileImage />}生成质量评估报告<ArrowRight /></button></></div>;
}
