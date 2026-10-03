/**
 * components/plan-schedule —— 计划排期编辑器
 * ---------------------------------------------------------------------------
 * 「多久一次 + 每期从几号到几号」的整块编辑区，含实时预览。
 * 新建计划（pages/task-create）和修改计划（pages/plan-edit）共用。
 *
 * ★ 为什么做成组件而不是各页抄一份：这不只是几十行 WXML 的重复 ——
 *   真正会漂的是**预览**。预览必须是"服务端将要生成的东西"的忠实投影，
 *   抄一份就等于有两份渲染规则，改了云函数忘了改某页，用户看到的
 *   就是要落库的内容的反面。做成组件后，renderName/describeOffsets/
 *   periodDates 只在这一个文件里被调用。
 *
 * ★ 本组件是**受控**的：自己不持有排期状态，只把用户的选择通过
 *   change 事件抛给父页，由父页 setData 回 properties 再驱动渲染。
 *   父页始终是唯一真源，提交时不用去组件里掏数据。
 *
 * 事件：change → { periodTypeIdx, startMonthIdx, startDay, endMonthIdx, endDay }
 * ---------------------------------------------------------------------------
 */

const periodic = require('../../shared/periodic');
const dates = require('../../shared/dates');

const PERIOD_TYPE_OPTIONS = ['每月', '每季', '每年'];
const PERIOD_TYPE_VALUES = ['monthly', 'quarterly', 'yearly'];

const DAY_OPTIONS = (() => {
  const out = [];
  for (let i = 1; i <= 31; i++) out.push(`${i} 日`);
  return out;
})();

/** 月度只有 1 个月可选，季度 3 个，年度 12 个 */
function monthIdxOptions(periodType) {
  const span = periodic.MONTHS_PER_PERIOD[periodType] || 1;
  const out = [];
  for (let i = 1; i <= span; i++) {
    out.push(periodType === 'yearly' ? `${i} 月` : `第 ${i} 个月`);
  }
  return out;
}

Component({
  properties: {
    /** 计划名称（裸名字），只用于预览任务名 */
    name: { type: String, value: '' },
    /** 周期类型在 PERIOD_TYPE_VALUES 里的下标 */
    periodTypeIdx: { type: Number, value: 0 },
    /** 期内偏移，全部从 1 起 */
    startMonthIdx: { type: Number, value: 1 },
    startDay: { type: Number, value: 1 },
    endMonthIdx: { type: Number, value: 1 },
    endDay: { type: Number, value: 31 },
  },

  data: {
    periodTypeOptions: PERIOD_TYPE_OPTIONS,
    dayOptions: DAY_OPTIONS,
    monthIdxOptions: monthIdxOptions('monthly'),
    planScheduleText: '',
    planPreviewName: '',
    planPreviewDates: '',
  },

  observers: {
    'name, periodTypeIdx, startMonthIdx, startDay, endMonthIdx, endDay': function () {
      this.recompute();
    },
  },

  methods: {
    /**
     * 重算预览。
     *
     * ★ 渲染用的是 shared/periodic.js —— 与云函数同一份文件，
     *   所以「预览里叫什么名字」和「生成出来叫什么名字」不可能不一致。
     *   前端自己拼一遍字符串才是会漂的做法。
     */
    recompute() {
      const d = this.data;
      const periodType = PERIOD_TYPE_VALUES[d.periodTypeIdx] || 'monthly';
      const tpl = {
        periodType,
        startMonthIdx: d.startMonthIdx,
        startDay: d.startDay,
        endMonthIdx: d.endMonthIdx,
        endDay: d.endDay,
      };

      // 拿「当前这一期」试算，让人看到的就是这个月/季/年真实会生成的日期
      const periodKey = periodic.periodKeyFor(periodType, dates.todayStr());
      const span = periodic.periodDates(tpl, periodKey);

      this.setData({
        monthIdxOptions: monthIdxOptions(periodType),
        planScheduleText: periodic.describeOffsets(tpl),
        planPreviewName: periodic.renderName(
          periodic.NAME_PREFIX[periodType] + String(d.name || '').trim(),
          { periodKey, deadline: '' }
        ),
        planPreviewDates: `${span.startDate} — ${span.dueDate}`,
      });
    },

    onPeriodTypeChange(e) {
      const idx = Number(e.detail.value);
      const periodType = PERIOD_TYPE_VALUES[idx];
      const span = periodic.MONTHS_PER_PERIOD[periodType];
      // ★ 换周期类型时把月份序号重置成「整期」（第 1 个月 → 最后 1 个月）。
      //   沿用旧值会得到「第 1 个月到第 1 个月」这种季度计划，
      //   用户几乎不可能是这个意思，改起来还得先猜为什么。
      this.triggerEvent('change', {
        periodTypeIdx: idx,
        startMonthIdx: 1,
        startDay: this.data.startDay,
        endMonthIdx: span,
        endDay: this.data.endDay,
      });
    },

    /** 四个偏移 picker 共用：dataset.field 指出改的是哪一项，值给的是下标 */
    onOffsetChange(e) {
      const field = e.currentTarget.dataset.field;
      if (!field) return;
      const next = {
        periodTypeIdx: this.data.periodTypeIdx,
        startMonthIdx: this.data.startMonthIdx,
        startDay: this.data.startDay,
        endMonthIdx: this.data.endMonthIdx,
        endDay: this.data.endDay,
      };
      next[field] = Number(e.detail.value) + 1;
      this.triggerEvent('change', next);
    },
  },
});
