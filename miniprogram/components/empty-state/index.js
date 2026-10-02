/**
 * components/empty-state
 * ---------------------------------------------------------------------------
 * 空状态占位。带一个可选的操作按钮，避免"列表空着但用户不知道下一步做什么"。
 * ---------------------------------------------------------------------------
 */

Component({
  options: { addGlobalClass: true },

  properties: {
    /** 主文案，如「还没有你主办的任务」 */
    title: { type: String, value: '暂无数据' },
    /** 辅助说明，告诉用户下一步能做什么 */
    hint: { type: String, value: '' },
    /** 操作按钮文案，留空则不显示按钮 */
    actionText: { type: String, value: '' },
    /** 加载中：显示加载态而不是空态，避免数据未到就闪一下"暂无数据" */
    loading: { type: Boolean, value: false },
  },

  methods: {
    onAction() {
      this.triggerEvent('action');
    },
  },
});
