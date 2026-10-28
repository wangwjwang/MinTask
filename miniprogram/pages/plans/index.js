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
 *
 * ★ 巡检健康横幅（patrol）：定时触发器失效是静默的 —— 函数不报错、
 *   用户不收通知，只能等"该有的任务没出现"才被发现。后端 list 把
 *   最近一次巡检记录递上来，这里把「从未运行 / 中断 / 有失败」翻译成
 *   人能看懂的横幅，让问题当天暴露而不是月底对账时才发现。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');

/** 上次巡检距今超过这个小时数就视为「中断」（巡检每天 00:05 跑，26h 留一天余量） */
const PATROL_STALE_HOURS = 26;

Page({
  data: {
    loading: true,
    list: [],
    /** 巡检健康状态：null（后端还没返回）/ { state, title, text } */
    patrol: null,
    /** 正在补生成的计划 _id（按钮转圈防重复点击） */
    generatingId: '',
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

      this.setData({
        list,
        patrol: this.decoratePatrol(res.lastPatrol),
        loading: false,
      });
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

  /**
   * 把后端的 lastPatrol 翻译成横幅状态。
   * state: ok（不显示）/ missing（从未运行）/ stale（中断）/ failed（有失败）
   */
  decoratePatrol(p) {
    if (!p) {
      return {
        state: 'missing',
        title: '每日巡检从未运行',
        text:
          '周期任务的自动生成依赖每天 00:05 的定时巡检，而 job_logs 里没有任何巡检记录（定时触发器未生效）。' +
          '请在开发者工具中右键 cloudfunctions/generatePeriodicTasks/config.json →「上传触发器」。',
      };
    }

    const finishedAt = p.finishedAt ? new Date(p.finishedAt) : null;
    const ago = finishedAt && !isNaN(finishedAt.getTime()) ? fmt.timeAgo(finishedAt) : '未知时间';

    if ((p.failedCount || 0) > 0) {
      return {
        state: 'failed',
        title: `上次巡检（${ago}）有 ${p.failedCount} 条计划生成失败`,
        text: '失败的期次不会自动重试，请到「云开发控制台 → 数据库 → job_logs」查看失败原因，或在本页对相应计划点「立即生成本期」。',
      };
    }

    const hours = finishedAt && !isNaN(finishedAt.getTime())
      ? (Date.now() - finishedAt.getTime()) / 3600000
      : Infinity;
    if (hours > PATROL_STALE_HOURS) {
      return {
        state: 'stale',
        title: `每日巡检已中断（上次运行 ${ago}）`,
        text: '巡检应当每天运行一次，超时中断通常意味着定时触发器失效 —— 本期任务可能不会自动生成。请到云开发控制台检查 generatePeriodicTasks 的触发器。',
      };
    }

    return {
      state: 'ok',
      title: '',
      text: '',
      _ago: ago,
      _created: p.createdCount || 0,
    };
  },

  onPlanTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/plan-edit/index?id=${id}` });
  },

  /**
   * 「立即生成本期」：对单个计划手动补跑当期生成。
   * ★ catchtap 阻止冒泡 —— 整张卡是点进编辑页的，不能让补生成顺手把人带走。
   */
  async onGenerateCurrent(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.generatingId) return;
    this.setData({ generatingId: id });
    try {
      const res = await toast.withLoading(
        () => api.templateApi.generateThisPeriod(id),
        '正在生成'
      );
      if (res && res.created && res.created.length) {
        toast.success('本期任务已生成');
      } else {
        const s = (res && res.skipped && res.skipped[0]) || {};
        toast.toast(
          s.reason === 'exists' ? '本期任务已存在，无需生成' : '本期未开始或已过期，无需生成'
        );
      }
      await this.refresh();
    } catch (err) {
      // 错误提示由 api 层统一弹出，这里只收住 loading
    } finally {
      this.setData({ generatingId: '' });
    }
  },
});
