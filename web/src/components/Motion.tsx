// 轻量零依赖动效容器与筛选选中药丸背景（替代重型 motion/react 运行时，大幅缩小首屏 JS 包体积）。
import type { ReactNode } from "react";

export function MotionRoot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** 筛选选中态背景药丸（纯 CSS 过渡，零运行时依赖）。 */
export function SpringPill({ className }: { layoutId?: string; className: string }) {
  return <span className={className} aria-hidden="true" />;
}
