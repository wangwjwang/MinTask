/**
 * miniprogram/utils/theme.js
 * ---------------------------------------------------------------------------
 * 前端专属的展示配色。
 *
 * ★ 刻意**不放进 `shared/`**：颜色是纯渲染问题，后台零语义。放 shared/ 会触发
 *   sync-shared.js 把 7 份云函数副本全部改脏，按项目纪律还要重新部署全部
 *   云函数 —— 为一个纯视觉改动付这个代价不值。放这里只动小程序端，
 *   `node scripts/sync-shared.js --check` 依然无差异。
 *
 * ★ 本文件的色值与 `app.wxss` 的令牌是**同一份颜色约定**，改一处必须改另一处。
 *   之所以不得不重复一份，是因为 CSS 变量够不到两个地方：
 *     1. `<slider activeColor="...">` 只吃十六进制字面量，不认 var(--xxx)
 *     2. 分类色有 11 个，用 JS 查表比在 app.wxss 里定义 11 个 class 好维护
 * ---------------------------------------------------------------------------
 */

const C = require('../shared/constants');

/**
 * 主色。改这里必须同步改三处：
 *   - app.wxss 的 --primary / --primary-soft / --primary-dark
 *   - app.json 的 tabBar.selectedColor
 *   - app.json 的 window.navigationBarBackgroundColor
 */
const PRIMARY = '#2563EB';

/**
 * 分类 → 展示色。
 *
 * 这 11 个值不是随手挑的，规则如下（**不要随意打乱**）：
 *
 *   1. 色相沿冷色弧从 190°(青) 排到 325°(紫红)，按 15° 等分，
 *      **完全避开三个色相带**：
 *        0°–60°    暖色区 —— --tone-danger(红, 0°) 与 --tone-warn(琥珀, 32°) 在那里
 *        140°–165° 绿色区 —— --tone-ok(绿, 146°) 在那里
 *        325° 这个终点是**实测调出来的**：最初取 340°，离红色只有 20°，
 *        被自检脚本判为相撞。收到 325° 后离红 35°、离琥珀 67°、离绿 44°。
 *      状态色的语义是需求写死的（红＝受阻、黄＝有风险/逾期、绿＝已完成），
 *      分类色一旦侵入这几个色域，用户就会把分类误读成状态。
 *
 *   2. 全部统一在 S≈42% / L≈40%：
 *        - 低饱和 —— 主色 #2563EB 是 83% 饱和度的鲜蓝，分类色明显发灰，
 *          即便色相接近也不可能被当成主色；
 *        - 同明度 —— 11 个分类谁也不比谁更"响"，不会凭空产生
 *          「某个分类看起来更重要」的假语义。
 *
 *   3. 顺序**跟随 CATEGORY 数组顺序**。副作用是相邻分类拿到相邻色相，
 *      「系统研发/系统运维/信创改造」自然形成一个色系 —— 白捡的收益。
 *
 *   4. 「其他」是中性灰（S=9%），刻意比其余 10 个安静 —— 它是兜底桶，
 *      不该和真实分类一样显眼。
 *
 * ★ 呈现形式是硬约束：分类色**只以小尺寸实心方块出现**（16rpx，圆角 4rpx），
 *   绝不作为卡片背景或标签底色。状态徽标是「浅底＋深字」的胶囊，分类标记是
 *   「实心小方块」—— 形式不同，所以即便色相接近也不可能混淆。
 */
const CATEGORY_COLOR = {
  系统研发: '#3B8391', // h190 青
  系统运维: '#3B6D91', // h205
  信创改造: '#3B5891', // h220  ← 与主色同色相，但饱和度 42% vs 83%、形态是小方块 vs 实心按钮
  数据提取: '#3B4291', // h235
  数据治理: '#493B91', // h250
  智能体AI开发: '#5F3B91', // h265
  安全合规: '#743B91', // h280
  监管报送: '#8A3B91', // h295
  竞赛活动: '#913B83', // h310
  培训: '#913B6D', // h325 紫红
  其他: '#6B7280', // 中性灰，S=9%，刻意比其余 10 个安静
};

/** 不在表中的分类（历史脏数据）统一回落的中性灰 */
const CATEGORY_COLOR_FALLBACK = '#6B7280';

/** 取分类展示色。表里没有的分类也返回兜底色，绝不返回空值 —— 否则方块渲染成透明 */
function categoryColor(category) {
  return CATEGORY_COLOR[category] || CATEGORY_COLOR_FALLBACK;
}

/**
 * 自检：CATEGORY_COLOR 的键必须与 shared/constants 的 CATEGORY 完全一致。
 * 漏掉一个分类只会静默回落成灰色，肉眼极难发现，所以在模块加载时就吼出来。
 * （shared/constants 以后新增分类时，这里会第一时间报警。）
 */
(function assertCoverage() {
  const missing = C.CATEGORY.filter((c) => !CATEGORY_COLOR[c]);
  if (missing.length) {
    console.error('[theme] CATEGORY_COLOR 缺少分类：' + missing.join('、'));
  }
})();

module.exports = {
  PRIMARY,
  CATEGORY_COLOR,
  CATEGORY_COLOR_FALLBACK,
  categoryColor,
};
