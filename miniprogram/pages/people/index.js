/**
 * pages/people —— Tab4「人员看板」
 * ---------------------------------------------------------------------------
 * 展示全员名单 + 每人的任务负载（主办数 / 协办数 / 其中已完成数），
 * 点卡片下钻到 person-detail 看这个人的具体任务。
 *
 * ★ 计数为什么在前端算：
 *   若每人各查一次（10 人 = 20 次查询：主办 10 次 + 协办 10 次），
 *   不仅有 N+1 问题，更危险的是**每次查询都受 20 条上限静默截断**，
 *   任务一多计数就偏低 —— 而且是静默的，看不出来。
 *   改为"一次拉全量任务 → 内存里按 id 归并"，查询次数恒为 1，且不受分页影响。
 *
 * ★ 席位顺序：管理员在前，然后按主办任务数降序，同数量按姓名。
 *   让"谁最忙"排在上面，一眼看出负载分布。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');

/** 本页在 custom-tab-bar 的 TABS 里的路径（见 custom-tab-bar/index.js） */
const TAB_PATH = '/pages/people/index';
const { ROLE } = require('../../shared/constants');

Page({
  data: {
    loading: true,
    /** [{ _id, name, dept, role, openid, claimed, led, joined, done, open, recent, _recentText, _isMe }] */
    members: [],
    /** 汇总：未认领人数，提醒管理员处理 */
    unclaimedCount: 0,
    /** 已认领人数 —— 为 0 时关联按钮没有意义，不显示 */
    claimedCount: 0,
    myOpenid: '',
    /** 只有管理员能看到「重新关联历史数据」入口 */
    isAdmin: false,
  },

  onLoad() {
    api.setClaimHandler(() => auth.gotoClaim(true));
  },

  /** 把选中态告诉自定义 tabBar（传路径，不传下标 —— 见 custom-tab-bar/index.js 的 sync） */
  syncTabBar() {
    const bar = this.getTabBar && this.getTabBar();
    if (bar && bar.sync) bar.sync(TAB_PATH);
  },

  onShow() {
    this.syncTabBar();
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      const session = await auth.requireClaimed();

      // 身份到手后再同步一次：onShow 那刻 bootstrap 可能还没回来
      this.syncTabBar();

      // 三个查询并发：成员名单 + 全量任务（含未完成与已完成，计数要分开）
      // + 近两周的进展记录（卡片上「近两周 N 条」小字用）
      const [members, tasks, recent] = await Promise.all([
        db.allMembers(),
        db.allTasks(),
        db.progressSince(fmt.twoWeekWindow().since),
      ]);

      // 近两周每条进展按上报人计数 —— 与任务计数同一套路：一次遍历建映射
      const recentStat = {};
      recent.forEach((r) => {
        if (!r.updaterId) return;   // 导入的老记录可能没有上报人
        recentStat[r.updaterId] = (recentStat[r.updaterId] || 0) + 1;
      });

      // 一次遍历建立 openid → 计数 的映射，避免对每个成员都扫一遍任务数组
      const stat = {};
      const bump = (openid, field, finished) => {
        if (!openid) return;
        if (!stat[openid]) stat[openid] = { led: 0, joined: 0, done: 0 };
        stat[openid][field] += 1;
        if (finished) stat[openid].done += 1;
      };

      tasks.forEach((t) => {
        const finished = t.stage === '已完成';
        bump(t.leaderId, 'led', finished);
        const ids = t.collaboratorIds;
        if (Array.isArray(ids)) ids.forEach((id) => bump(id, 'joined', finished));
      });

      const list = members
        .map((m) => {
          const s = stat[m.openid] || { led: 0, joined: 0, done: 0 };
          const open = s.led + s.joined - s.done;
          const recentCount = recentStat[m.openid] || 0;
          return {
            _id: m._id,
            name: m.name,
            dept: m.dept || '',
            role: m.role,
            openid: m.openid || '',
            claimed: !!m.openid,
            led: s.led,
            joined: s.joined,
            done: s.done,
            // 未完成的任务数 —— 比"总任务数"更能反映当前负载
            open,
            // 近两周上报的进展条数。与上面的"总量"口径不同（那是历史累计），
            // 所以文案里带上"近两周"，并在 WXML 里单独占一行
            recent: recentCount,
            _recentText: recentCount ? `近两周 ${recentCount} 条进展` : '近两周无进展',
            _isMe: m.openid === session.openid,
          };
        })
        .sort((a, b) => {
          // 管理员置顶，其余按在办任务数降序，再按姓名
          const aAdmin = a.role === ROLE.ADMIN ? 1 : 0;
          const bAdmin = b.role === ROLE.ADMIN ? 1 : 0;
          if (aAdmin !== bAdmin) return bAdmin - aAdmin;
          if (b.open !== a.open) return b.open - a.open;
          return String(a.name).localeCompare(String(b.name), 'zh');
        });

      const claimed = list.filter((m) => m.claimed).length;
      this.setData({
        members: list,
        unclaimedCount: list.length - claimed,
        claimedCount: claimed,
        isAdmin: auth.isAdmin(),
        myOpenid: session.openid,
        loading: false,
      });
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        console.error('[people] 加载失败', e);
        this.setData({ loading: false });
        toast.error('加载人员列表失败，请下拉重试');
      }
    }
  },

  onMemberTap(e) {
    const { openid, name } = e.currentTarget.dataset;
    if (!openid) {
      toast.toast('该成员还没认领账号，暂无任务数据');
      return;
    }
    // 点自己：直接跳到"我主办的"更实用，但仍走统一的人员下钻页保持行为一致
    wx.navigateTo({
      url: `/pages/person-detail/index?openid=${openid}&name=${encodeURIComponent(name)}`,
    });
  },

  /**
   * 管理员：把历史任务表里的姓名归属补成 openid。
   *
   * 用于导入旧任务表之后的收尾 —— 导入时 openid 还不存在，
   * 所以 leaderId / collaboratorIds / updaterId 都是空的，
   * 表现是「我主办的」列表为空、看板计数全是 0、没人能编辑任务。
   *
   * 幂等，只补空缺不覆盖已有归属，多点几次没有副作用。
   */
  onRelink() {
    const { claimedCount } = this.data;
    wx.showModal({
      title: '关联历史任务',
      content: `把已经认领的 ${claimedCount} 位同事，与历史任务表里同名的主办/协办对应起来。\n\n只补空缺，不会改动已有的归属，可以反复执行。`,
      confirmText: '开始',
      success: (res) => {
        if (res.confirm) this.doRelink();
      },
    });
  },

  async doRelink() {
    wx.showLoading({ title: '关联中…', mask: true });
    try {
      const r = await api.memberApi.adminRelinkMembers();
      wx.hideLoading();
      await this.refresh();
      wx.showModal({
        title: '关联完成',
        content: `已认领 ${r.claimed} 人\n补上主办/协办归属的任务：${r.tasks} 个\n补上上报人的进展记录：${r.records} 条`,
        showCancel: false,
      });
    } catch (e) {
      wx.hideLoading();
      console.error('[people] 关联历史数据失败', e);
      // 交给统一错误处理（网络错误、权限不足等都有自己的文案）
      api.showError(e);
    }
  },

  /** 复制未认领名单，方便发给同事催认领 */
  onCopyUnclaimed() {
    const names = this.data.members.filter((m) => !m.claimed).map((m) => m.name);
    if (!names.length) {
      toast.toast('所有人都已认领');
      return;
    }
    wx.setClipboardData({
      data: `还未认领 TeamPulse 账号：${names.join('、')}`,
    });
  },
});
