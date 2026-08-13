import { useEffect, useState } from 'react';
import type { VideoDetectResult, VideoTaskStatus } from '../types';

/**
 * 识别结果共享视图：常量映射 + 结果卡片（智能识别页 / 检测历史「查看详情」复用）。
 * 约定：卡片统一用「标注媒体区 + 统计标签 + 可展开目标列表」布局。
 */

/** 后端英文污染等级 → 前端中文（/detect/status、/detect/result 返回原始枚举值） */
export const POLLUTION_LEVEL_ZH: Record<string, string> = {
  excellent: '优', good: '良', moderate: '中', poor: '差', severe: '严重',
};
export const levelZh = (level?: string | null) => (level ? POLLUTION_LEVEL_ZH[level] ?? level : '');

/** 后端英文污染等级 → 环境质量分（与后端 POLLUTION_SCORE 演示推导值一致） */
export const QUALITY_SCORE: Record<string, number> = {
  excellent: 92, good: 82, moderate: 68, poor: 48, severe: 28,
};

/** 视频预览帧画廊：大图 + 缩略图条；后端每检测到"新画面"即追加一张 */
export function PreviewGallery({ urls }: { urls: string[] }) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    // 预览帧累积时：正停在末尾则跟随最新一张，否则保持用户当前查看的帧
    setActive((prev) => (prev >= urls.length - 1 ? Math.max(0, urls.length - 1) : prev));
  }, [urls.length]);
  if (urls.length === 0) return <div className="result-card-media-empty">暂无标注预览</div>;
  const idx = Math.min(active, urls.length - 1);
  return (
    <>
      <img className="video-gallery-main" src={urls[idx]} alt={`预览帧 ${idx + 1}`} />
      {urls.length > 1 && (
        <div className="video-preview-strip">
          {urls.map((url, i) => (
            <button key={url} className={i === idx ? 'active' : ''} onClick={() => setActive(i)} aria-label={`预览帧 ${i + 1}`}>
              <img src={url} alt={`预览 ${i + 1}`} loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** 视频结果卡片：与多图识别结果卡片同一布局（标注预览图 + 统计 + 可展开目标列表）。
 * 媒体区展示全部场景预览帧画廊（每次检测到新画面追加一张）；目标列表为去重后的垃圾清单。
 * status 可为 null（检测历史详情直接以 result 为准时），预览帧/标注视频从 result 兜底读取。 */
export function VideoResultCard({ fileName, status, result }: { fileName: string; status: VideoTaskStatus | null; result: VideoDetectResult | null }) {
  const [expanded, setExpanded] = useState(true); // 默认展开目标列表，与图片卡片一致
  const level = result?.pollutionLevel || status?.pollutionLevel || '';
  const levelLabel = levelZh(level);
  const objects = result?.results ?? [];
  const count = result?.totalObjects ?? status?.totalObjects ?? 0;
  const seconds = result?.processingTime ?? status?.processingTime;
  const score = QUALITY_SCORE[level] ?? 68;
  const previews = status?.previewUrls?.length
    ? status.previewUrls
    : status?.previewUrl
      ? [status.previewUrl]
      : result?.previewUrls?.length
        ? result.previewUrls
        : [];
  const annotatedUrl = status?.annotatedVideoUrl ?? result?.annotatedVideoUrl;

  return (
    <div className="result-card">
      <div className="result-card-media">
        <PreviewGallery urls={previews} />
      </div>
      {annotatedUrl && (
        <div className="annotated-video-block">
          <video src={annotatedUrl} controls playsInline preload="metadata" />
        </div>
      )}
      <div className="result-card-info">
        <strong title={fileName}>{fileName}</strong>
        <div className="result-card-tags">
          <span className={`level-badge level-${levelLabel}`}>{levelLabel ? `${levelLabel}度污染` : '未评级'}</span>
          <span>质量分 {score}</span>
        </div>
        <p>发现 {count} 个垃圾目标{seconds != null ? ` · 耗时 ${seconds}s` : ''}</p>
        <button className="secondary-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起目标列表' : `目标列表${objects.length > 0 ? `（${objects.length}）` : ''}`}</button>
        {expanded && (
          <div className="object-list">
            {objects.length === 0 && <p style={{ fontSize: 9, color: 'var(--muted)', margin: 0 }}>未检出垃圾目标</p>}
            {objects.map((object, index) => (
              <div key={`v-${index}`}><span>{object.className}</span><em>{object.materialType ?? '未知'}</em><div><i style={{ width: `${object.confidence * 100}%` }} /></div><strong>{(object.confidence * 100).toFixed(0)}%</strong></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 图片结果详情卡片：标注图（media_url，把已入库检测框画回原图）+ 统计 + 可展开目标列表。
 * 用于检测历史「查看详情」的图片任务，布局与视频结果卡片保持一致。 */
export function ImageDetailCard({ detail }: { detail: VideoDetectResult | null }) {
  const [expanded, setExpanded] = useState(true);
  const level = detail?.pollutionLevel || '';
  const levelLabel = levelZh(level);
  const objects = detail?.results ?? [];
  const score = QUALITY_SCORE[level] ?? 68;

  return (
    <div className="result-card">
      <div className="result-card-media">
        {detail?.mediaUrl ? (
          <img className="video-gallery-main" src={detail.mediaUrl} alt="标注图" />
        ) : (
          <div className="result-card-media-empty">暂无标注图</div>
        )}
      </div>
      <div className="result-card-info">
        <strong title={detail?.fileName ?? ''}>{detail?.fileName ?? '图片'}</strong>
        <div className="result-card-tags">
          <span className={`level-badge level-${levelLabel}`}>{levelLabel ? `${levelLabel}度污染` : '未评级'}</span>
          <span>质量分 {score}</span>
        </div>
        <p>发现 {detail?.totalObjects ?? 0} 个垃圾目标{detail?.processingTime != null ? ` · 耗时 ${detail.processingTime}s` : ''}</p>
        <button className="secondary-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起目标列表' : `目标列表${objects.length > 0 ? `（${objects.length}）` : ''}`}</button>
        {expanded && (
          <div className="object-list">
            {objects.length === 0 && <p style={{ fontSize: 9, color: 'var(--muted)', margin: 0 }}>未检出垃圾目标</p>}
            {objects.map((object, index) => (
              <div key={`i-${index}`}><span>{object.className}</span><em>{object.materialType ?? '未知'}</em><div><i style={{ width: `${object.confidence * 100}%` }} /></div><strong>{(object.confidence * 100).toFixed(0)}%</strong></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
