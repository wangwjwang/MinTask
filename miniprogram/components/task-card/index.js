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
