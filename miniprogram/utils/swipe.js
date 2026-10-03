/**
 * utils/swipe.js —— 横向滑动切换「分段」的判定
 * ---------------------------------------------------------------------------
 * 任务看板（周期性/进行中/已完成）与人员详情（主办/协办）两处共用。
 *
 * ★ 为什么是手势判定，而不是 <swiper>：
 *   swiper 必须有一个显式高度，而几个分段的内容长度差得很远 —— 只能把高度
 *   撑到最长那段，再让每段各套一层纵向 scroll-view，那就是看板 v2 重构专门
 *   干掉的结构（横竖两个滚动方向互相抢手势）。而且 swiper-item 内部
 *   position: sticky 会失效，看板按分类吸顶的组标题会没掉。
 *   手势方案对布局零改动，代价是没有跟手拖拽的动画。
 *
 * ★ 纯函数、不碰 wx：判定规则能在 node 里直接喂坐标测（见仓库外的临时脚本），
 *   页面只负责把触摸事件的坐标递进来。
 * ---------------------------------------------------------------------------
 */

/**
 * 触发横滑的最小水平位移（px）。
 * ★ 触摸事件的 clientX/clientY 是 px，不是 rpx —— 这里别按 rpx 想。
 * 60px 约等于一个拇指在屏幕上自然的短划，再小就会与「点一下」混淆。
 */
const MIN_DX = 60;

/**
 * 横向位移要大到纵向位移的这个倍数，才算横滑。
 * ★ 页面本身是纵向滚动的：斜着划一下多半是想滚页面，不该被我们截走。
 * 1.5 表示"明显更偏横"才认。
 */
const RATIO = 1.5;

/**
 * 判一次触摸是不是横滑，是的话往哪边走。
 *
 * @param {{x:number,y:number}} start touchstart 时的坐标
 * @param {{x:number,y:number}} end   touchend 时的坐标
 * @returns {number} +1 = 看**下一段**（手指向左划）｜-1 = 看**上一段**（手指向右划）｜0 = 不是横滑
 *
 * ★ 返回值刻意是「要往哪一段走」而不是「手指往哪边划」：
 *   手指向左 = 把当前内容往左推走 = 看右边那一段 = 序号 +1。
 *   符号在这里定死一次，两个调用方都不必再做一次正负转换
 *   （少一处转换就少一处写反的机会）。
 */
function swipeStep(start, end) {
  if (!start || !end) return 0;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < MIN_DX) return 0;      // 没划够远（含原地点击）
  if (adx <= ady * RATIO) return 0; // 斜着划/竖着划：让页面照常滚
  return dx < 0 ? 1 : -1;           // 向左划看下一段，向右划看上一段
}

/**
 * 在一张有序的分段表里走一步。
 *
 * @param {string[]} list 分段顺序表（渲染顺序即切换顺序）
 * @param {string} current 当前分段
 * @param {number} delta swipeStep 的返回值
 * @returns {string|null} 目标分段；不动时返回 null
 *
 * ★ 到头就停住，**不循环**：从最后一段再往左划应该什么都不发生。
 *   循环会让人在"想再看一眼上一段"时突然跳到遥远的另一端，且没有任何提示。
 * ★ current 不在表里（脏数据/以后改了分段名）时返回 null 而不是回落到第一段：
 *   宁可不动，也别把用户莫名其妙地送到别处去。
 */
function stepIn(list, current, delta) {
  if (!delta || !list) return null;
  const i = list.indexOf(current);
  if (i === -1) return null;
  const next = list[i + delta];
  return next === undefined ? null : next;
}

module.exports = { swipeStep, stepIn, MIN_DX, RATIO };
