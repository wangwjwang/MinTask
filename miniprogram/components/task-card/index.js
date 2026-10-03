/**
 * components/task-card
 * ---------------------------------------------------------------------------
 * 任务卡片。Tab1 两个列表、Tab2、Tab3 看板、人员下钻页都用它。
 *
 * 卡片显示的字段口径集中在 utils/format.js 的 decorateTask 里，
 * 本组件只负责渲染，不做格式化 —— 否则各页面会慢慢显示得不一致。
 * ---------------------------------------------------------------------------
 */

Component({
  options: {
    // 允许外部页面通过 class 覆盖样式（页面里的间距调整）
    addGlobalClass: true,
  },

  properties: {
    /** 已经过 format.decorateTask 处理的 task 对象 */
    task: {
      type: Object,
      value: null,
    },

    /** 显示模式：full（默认，带全部信息）/ compact（紧凑，用于人员下钻） */
    mode: {
      type: String,
      value: 'full',
    },

    /** 是否显示进度条 */
    showProgress: {
      type: Boolean,
      value: true,
    },

    /** 是否显示协办人 */
    showCollaborators: {
      type: Boolean,
      value: true,
    },

    /** 是否显示主办人（人员下钻页看别人的任务时需要） */
    showLeader: {
      type: Boolean,
      value: false,
    },

    /**
     * 周期语境：右上角显示周期频率而不是任务来源，且第二行不再挂「周期」标签。
     * ★ 两个效果合成一个开关，因为它们出自同一个判断 ——「这张卡在按周期看」。
     *   拆成两个 prop 会让调用方每次都得记得同时传，漏一个就出现半截状态。
     * ★ 默认 false：全仓 9 处用法里只有看板的「周期性」段传 true，
     *   其余仍按来源显示（那些页面按阶段看，来源才是它们要的信息）。
     */
    recurMode: {
      type: Boolean,
      value: false,
    },
  },

  methods: {
    onTap() {
      const task = this.data.task;
      if (!task) return;
      // 把点击事件抛给页面，由页面决定跳详情还是跳语音上报
      this.triggerEvent('tap', { task });
    },
  },
});
