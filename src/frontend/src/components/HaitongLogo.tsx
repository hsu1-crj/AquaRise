import type { SVGProps } from 'react';

export function HaitongLogo({
  size = 24,
  glow = true,
  className = '',
  ...props
}: SVGProps<SVGSVGElement> & { size?: number; glow?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`haitong-logo-svg ${className}`}
      {...props}
    >
      <defs>
        <linearGradient id="htGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38f8d4" />
          <stop offset="100%" stopColor="#1be7ff" />
        </linearGradient>
        <linearGradient id="irisGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#5cf2ae" />
          <stop offset="100%" stopColor="#2bdcff" />
        </linearGradient>
        {glow && (
          <filter id="htGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.2" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        )}
      </defs>

      {/* 外层天体轨道与高亮极点 */}
      <circle cx="24" cy="24" r="21" stroke="rgba(56, 248, 212, 0.4)" strokeWidth="1.2" strokeDasharray="3 2" />
      <circle cx="39" cy="13" r="2" fill="#1be7ff" filter={glow ? 'url(#htGlow)' : undefined} />
      <circle cx="9" cy="35" r="2" fill="#38f8d4" filter={glow ? 'url(#htGlow)' : undefined} />

      {/* 海瞳眼睛流线外轮廓 */}
      <path
        d="M 6 24 Q 24 9 42 24 Q 24 39 6 24 Z"
        fill="rgba(56, 248, 212, 0.12)"
        stroke="url(#htGrad)"
        strokeWidth="2"
        strokeLinejoin="round"
        filter={glow ? 'url(#htGlow)' : undefined}
      />

      {/* 虹膜层 */}
      <circle cx="24" cy="24" r="8" fill="rgba(43, 220, 255, 0.25)" stroke="#1be7ff" strokeWidth="1.2" />

      {/* 生命核心瞳孔 */}
      <circle cx="24" cy="24" r="4.5" fill="url(#irisGrad)" filter={glow ? 'url(#htGlow)' : undefined} />
      <circle cx="22.5" cy="22.5" r="1.5" fill="#ffffff" />
    </svg>
  );
}
