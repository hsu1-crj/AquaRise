import type { SVGProps } from 'react';

export function DigitalHumanIcon({
  size = 20,
  className = '',
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`digital-human-icon-svg ${className}`}
      {...props}
    >
      <defs>
        <linearGradient id="dhGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#5cf2ae" />
          <stop offset="100%" stopColor="#2bdcff" />
        </linearGradient>
      </defs>

      {/* 全息波形光环 / AI 意识冕 */}
      <path
        d="M 4 10 C 4 5.58 7.58 2 12 2 C 16.42 2 20 5.58 20 10"
        stroke="url(#dhGrad)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeDasharray="2 1.5"
        opacity="0.85"
      />

      {/* 数字人头部轮廓 */}
      <path
        d="M 12 4.5 C 9.5 4.5 7.5 6.5 7.5 9 C 7.5 11.5 9.5 13.5 12 13.5 C 14.5 13.5 16.5 11.5 16.5 9 C 16.5 6.5 14.5 4.5 12 4.5 Z"
        stroke="url(#dhGrad)"
        strokeWidth="1.6"
        fill="rgba(92, 242, 174, 0.12)"
      />

      {/* 头部核心智能双眸与意识中心 */}
      <circle cx="12" cy="8.5" r="1.3" fill="#5cf2ae" />
      <circle cx="9.8" cy="8.2" r="0.6" fill="#2bdcff" />
      <circle cx="14.2" cy="8.2" r="0.6" fill="#2bdcff" />

      {/* 数字人流线双肩躯干 */}
      <path
        d="M 5 21 C 5 17 8 15.5 12 15.5 C 16 15.5 19 17 19 21"
        stroke="url(#dhGrad)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />

      {/* 左右实时声纹与交互节点 */}
      <line x1="2" y1="12" x2="4" y2="12" stroke="#5cf2ae" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="20" y1="12" x2="22" y2="12" stroke="#2bdcff" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
