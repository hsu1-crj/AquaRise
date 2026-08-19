import { useEffect } from 'react';

export function MarineAtlasPage({ onExit }: { onExit: () => void }) {
  useEffect(() => {
    // 监听 iframe 发出的退出消息
    const handleMessage = (e: MessageEvent) => {
      if (e.data === 'haitong-exit' || e.data?.type === 'haitong-exit') {
        onExit();
      }
    };
    // 监听全局 ESC 快捷键退出
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
      />
    </div>
  );
}
