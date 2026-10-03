/**
 * pages/plans —— 管理我的计划（子页面）
 * ---------------------------------------------------------------------------
 * 列出我建的周期性计划（periodic_templates），点一行进 pages/plan-edit 改或删。
 *
 * ★ 这里展示的是**计划**，不是任务。计划本身不产生任何任务 ——
 *   到了每期的开始日，generatePeriodicTasks 才生成当期任务。所以每行
 *   必须回答"这个计划现在处于什么状态、本期从哪天到哪天"，
 *   否则用户看到的只是一堆没有时间感的名字。
 *
 * ★ 状态判定一律走 shared/periodic.evaluate —— 与云函数是同一个函数。
 *   前端自己写一套"到没到开始日"的判断，迟早会和服务端不一致，
 *   然后用户就会看到一个说"待开始"、另一个已经生成了任务。
 *
 * ★ 云函数 list 的可见范围：管理员看到全部，其他人只看得到自己建的。
 *   本页不额外过滤 —— 「管理我的计划」对管理员显示的"我的"是宽口径的，
 *   而他确实管得了这些计划（canManageTemplate 认管理员）。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');

Page({
  data: {
    loading: true,
    list: [],
  },

  onLoad() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      await auth.requireClaimed();
      this.setData({ loading: true });

      const res = await api.templateApi.list();
      // 派生字段（排期/本期/状态）统一由 utils/format 算 —— 任务看板的
      // 「周期性计划」段用的是同一个函数，两页的显示口径不会再各走各的。
      // 「今天」也由它自己取（dates.todayStr），本页不再各取一次。
      const list = fmt.decoratePlans(res.list);

      this.setData({ list, loading: false });
    } catch (e) {
      // NEED_CLAIM 由 auth 层接管跳认领页，这里不必再提示
      if (e.code !== 'NEED_CLAIM') {
        this.setData({ loading: false });
        // ★ 不能只是 loading:false 收场：那样 list 仍是空的，界面会显示
        //   「还没有计划」并引导用户去建 —— 用假前提指路。
        toast.error('加载失败，请下拉重试');
      }
    }
  },

  onPlanTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/plan-edit/index?id=${id}` });
  },
});
