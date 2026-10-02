/**
 * pages/join —— 加入协办页（子页面）
 * ---------------------------------------------------------------------------
 * 列出「他人主办、且协办名单里没有我、且未完成」的任务，点击即可自由加入。
 *
 * 需求第 4 节明确：加入协办**无需主办审批**，所以这里不做二次确认弹窗，
 * 点一下直接加入，加入后卡片从列表消失（因为它已经变成"我协办的"了）。
 *
 * 云函数侧 taskService.join 会：
 *   - 用 addToSet 原子写入（并发加入不丢更新）
 *   - 校验不能是自己主办的任务
 *   - 校验任务未完成
 *   - 回读重建 collaborator 姓名快照
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');

Page({
  data: {
    loading: true,
    list: [],
    /** 正在加入的任务 _id，用于按钮 loading 态 */
    joiningId: '',
  },

  onLoad() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      const session = await auth.requireClaimed();
      this.setData({ loading: true });

      const list = await db.joinableTasks(session.openid);

      this.setData({
        list: fmt.decorateTasks(list),
        loading: false,
      });
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        this.setData({ loading: false });
      }
    }
  },

  async onJoin(e) {
    const task = e.currentTarget.dataset.task;
    if (!task || !task._id || this.data.joiningId) return;

    this.setData({ joiningId: task._id });

    try {
      const res = await api.taskApi.join(task._id);
      if (res.idempotent) {
        toast.toast('你已在该任务的协办名单中');
      } else {
        toast.success('已加入');
      }
      // 加入成功后从列表移除，不用整页重拉
      this.setData({
        list: this.data.list.filter((t) => t._id !== task._id),
      });
    } catch (e) {
      // 任务可能刚被标为已完成，或已被他人删除 —— 重拉一次让列表回到真实状态
      if (e.code === 'INVALID_PARAM' || e.code === 'TASK_NOT_FOUND') {
        setTimeout(() => this.refresh(), 800);
      }
    } finally {
      this.setData({ joiningId: '' });
    }
  },
});
