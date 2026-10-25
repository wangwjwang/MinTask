/**
 * charts/touchFix.js
 * ---------------------------------------------------------------------------
 * 移动端触摸修复：触摸屏上点按不会像鼠标那样触发 mouseout，
 * 导致切换点按第二个图形时，前一个图形的 emphasis（高亮标签）与
 * tooltip 有时残留不清（ECharts 已知问题）。
 *
 * 处理：仅在触摸设备（pointer: coarse）上，监听 zrender 的 mousedown
 * （zrender 对 touchstart 的模拟事件），先清掉上一个残留的高亮与提示；
 * 本次点按的新高亮/提示随后由 ECharts 正常施加。桌面端完全不介入。
 * ---------------------------------------------------------------------------
 */
export function fixTouchStuckEmphasis(chart) {
  if (!chart || typeof window === 'undefined' || !window.matchMedia) return;
  try {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    chart.getZr().on('mousedown', () => {
      chart.dispatchAction({ type: 'hideTip' });
      chart.dispatchAction({ type: 'downplay' });
    });
  } catch (e) { /* 忽略：不影响图表主功能 */ }
}
