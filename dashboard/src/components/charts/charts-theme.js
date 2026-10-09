/**
 * charts-theme.js — 读取当前主题 CSS 变量，供 ECharts 取色。
 * 这样图表颜色随三套皮肤（暖纸/冷静蓝/蓝图）自动变化。
 */
export function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  return {
    accent: g('--c-accent') || '#2563EB',
    ok: g('--c-ok') || '#12A150',
    warn: g('--c-warn') || '#D97706',
    danger: g('--c-danger') || '#DC2626',
    done: g('--c-done') || '#2563EB',
    link: g('--c-link') || '#1a67fd',
    text: g('--c-text-strong') || '#111',
    muted: g('--c-text-muted') || '#666',
    faint: g('--c-text-faint') || '#999',
    border: g('--c-border') || '#eee',
    surface: g('--c-surface') || '#fff',
  };
}

export const CATEGORY_PALETTE = [
  '#2563EB', '#dc2626', '#d97706', '#12a150', '#7c3aed',
  '#0891b2', '#db2777', '#ca8a04', '#0d9488', '#9333ea', '#64748b',
];
