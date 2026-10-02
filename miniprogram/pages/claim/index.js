/**
 * pages/claim —— 启动页 / 成员认领页
 * ---------------------------------------------------------------------------
 * 放在 app.json 的 pages 首位，因此是小程序的启动页。
 *
 * 两条分支：
 *   已认领 → 直接 switchTab 进 Tab1「报任务」，用户几乎无感
 *   未认领 → 展示未认领名单，用户选自己的名字完成绑定
 *
 * ★ 为什么用 reLaunch/switchTab 而不是把 Tab1 设为首页：
 *   用户可能从分享卡片直接进入任意子页面，那条路径绕过了启动页。
 *   所以每个页面 onLoad 里也会调 auth.requireClaimed() 兜底，
 *   本页只是"正常路径"上的入口。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const toast = require('../../utils/toast');

Page({
  data: {
    loading: true,
    /** 未认领的成员列表 */
    list: [],
    /** 当前选中的成员 _id */
    selectedId: '',
    submitting: false,
    /** 身份拉取失败的提示 */
    errorMsg: '',
  },

  onLoad() {
    // Tab 页不能用 redirectTo 跳转，所以注册一个用 reLaunch 的处理器
    api.setClaimHandler(() => auth.gotoClaim(true));
    this.bootstrap();
  },

  onPullDownRefresh() {
    this.bootstrap().finally(() => wx.stopPullDownRefresh());
  },

  /** 拉身份 → 已认领则放行，未认领则拉名单 */
  async bootstrap() {
    this.setData({ loading: true, errorMsg: '' });
    try {
      const session = await auth.refresh();

      if (session.member) {
        // 已认领，直接进入主页面
        wx.switchTab({ url: '/pages/report/index' });
        return;
      }

      // 环境未配置时不要再发请求 —— app.onLaunch 已经弹窗说明了原因，
      // 这里只需把提示留在页面上，供用户关掉弹窗后仍能看到。
      if (session.envMissing) {
        this.setData({
          loading: false,
          errorMsg: '云开发环境未配置：请把 miniprogram/config.js 的 envId 改成真实的环境 ID。',
        });
        return;
      }

      const res = await api.memberApi.listClaimable();
      this.setData({ list: res.list || [], loading: false });

      if (!res.list || !res.list.length) {
        // 名单为空：要么管理员还没导入成员，要么都已被认领完
        this.setData({
          errorMsg: '没有可认领的成员。请联系管理员在云数据库 members 集合中导入团队名单。',
        });
      }
    } catch (e) {
      // getMe 失败通常是云环境未配置，这个错误必须说清楚，否则用户完全无从下手
      this.setData({
        loading: false,
        errorMsg: e.message || '无法连接云环境，请检查 config.js 中的 envId 是否填写正确',
      });
    }
  },

  onSelect(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ selectedId: id === this.data.selectedId ? '' : id });
  },

  async onConfirm() {
    const memberId = this.data.selectedId;
    if (!memberId) {
      toast.toast('请先选择你的姓名');
      return;
    }

    const member = this.data.list.find((m) => m._id === memberId);
    const ok = await toast.confirm(
      `确认你是「${member ? member.name : ''}」吗？认领后管理员才能帮你解绑。`,
      '确认身份'
    );
    if (!ok) return;

    this.setData({ submitting: true });
    try {
      await api.memberApi.claim(memberId);
      toast.success('认领成功');
      // 认领成功必须刷新身份缓存，否则全局还认为"未认领"
      await auth.refresh();
      setTimeout(() => {
        wx.switchTab({ url: '/pages/report/index' });
      }, 800);
    } catch (e) {
      this.setData({ submitting: false });
      // MEMBER_TAKEN 说明被别人抢先了，重新拉名单
      if (e.code === 'MEMBER_TAKEN') {
        setTimeout(() => this.bootstrap(), 1200);
      }
    }
  },
});
