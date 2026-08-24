import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

/**
 * 海瞳·生命图谱全屏包装页。
 * - iframe 加载 / haitong 初始化期间显示品牌启动屏，避免黑屏突兀；
 *   haitong 初始化完成后 postMessage 'haitong-ready' 揭幕（8s 兜底强制揭幕）；
 * - postMessage 校验 e.origin，仅接受同源消息；
 * - ESC 与 'haitong-exit' 消息均可退出。
 */
export function MarineAtlasPage({ onExit }: { onExit: () => void }) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [booted, setBooted] = useState(false);
  const [splashGone, setSplashGone] = useState(false);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data === 'haitong-exit' || e.data?.type === 'haitong-exit') {
        onExit();
      }
      if (e.data === 'haitong-ready' || e.data?.type === 'haitong-ready') {
        setBooted(true);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onExit();
      }
    };
    window.addEventListener('message', handleMessage);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onExit]);

  // iframe onload 后的兜底：旧缓存等情况未收到 ready 消息时也揭幕
  useEffect(() => {
    if (!iframeLoaded) return;
    const timer = window.setTimeout(() => setBooted(true), 6000);
    return () => window.clearTimeout(timer);
  }, [iframeLoaded]);

  // 揭幕动画结束后彻底移除启动屏节点
  useEffect(() => {
    if (!booted) return;
    const timer = window.setTimeout(() => setSplashGone(true), 700);
    return () => window.clearTimeout(timer);
  }, [booted]);

  const handleReload = useCallback(() => {
    setBooted(false);
    setSplashGone(false);
    setIframeLoaded(false);
    window.location.reload();
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 9999,
        background: '#01050c',
        overflow: 'hidden',
        margin: 0,
        padding: 0,
      }}
    >
      <iframe
        src="/haitong/index.html"
        title="海瞳 · 生命图谱"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
          margin: 0,
          padding: 0,
        }}
        allow="camera; microphone; autoplay; fullscreen"
        loading="eager"
        onLoad={() => setIframeLoaded(true)}
      />

      {!splashGone && (
        <div
          className={`atlas-boot-splash ${booted ? 'done' : ''}`}
          role="status"
          aria-live="polite"
          aria-label={booted ? '生命图谱已就绪' : '生命图谱正在加载'}
        >
          <div className="atlas-boot-core">
            <span className="atlas-boot-ring r1" />
            <span className="atlas-boot-ring r2" />
            <b>海瞳</b>
          </div>
          <p className="atlas-boot-kicker">HAITONG · BIOLUMINESCENT ATLAS</p>
          <h1 className="atlas-boot-title">生命图谱 · 守护蓝色星球</h1>
          <div className="atlas-boot-bar" aria-hidden="true">
            <i />
          </div>
          <p className="atlas-boot-hint">
            {iframeLoaded ? '正在点亮深海粒子星球的生灵之光…' : '正在连接图谱引擎…'}
          </p>
          {!booted && iframeLoaded && (
            <button type="button" className="atlas-boot-retry" onClick={handleReload}>
              加载缓慢？点击重新加载
            </button>
          )}
        </div>
      )}
    </div>
  );
}
