/**
 * pages/leave —— 退出协办页（子页面）
 * ---------------------------------------------------------------------------
 * 列出「我参与协办」的任务，点一下即可退出。与 pages/join 对偶：
 * join 是「他人主办、我还没参与」，leave 是「我已在协办名单里」。
 *
 * ★ 与 join 页两处刻意的不同：
 *   1. **不过滤已完成。** join 页排除已完成是因为云函数拒绝加入已完成任务；
 *      退出没有这个限制，而且已完成的协办关系恰恰是最想清掉的那一批，
 *      滤掉反而留下一个在界面上够不着的尾巴。
 *   2. **要滤掉我主办的任务。** db.myJoinedTasks 只按 collaboratorIds 查，
 *      而一个任务可能既是我主办、又把我列进了协办（见 report/index.js 注释）。
 *      主办人"退出"自己的任务是荒谬的，云函数 perm.canLeave 也会拒。
 *      行过滤直接用 perm.canLeave —— 与云函数是同一个函数，不另写规则。
 *
 * 云函数侧 taskService.leave 会 pull 掉我的 openid，再回读重建姓名快照
 * （快照重建已修成 mergeCollaboratorSnapshot，不会抹掉未认领的姓名）。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');
const perm = require('../../shared/perm');

Page({
  data: {
    loading: true,
    list: [],
    /** 正在退出的任务 _id，用于按钮 loading 态 */
    leavingId: '',
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

      const joined = await db.myJoinedTasks(session.openid);
      // 去掉我主办的任务（见文件头第 2 条）
      const list = joined.filter((t) => perm.canLeave(t, session.openid));

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

  async onLeave(e) {
    const task = e.currentTarget.dataset.task;
    if (!task || !task._id || this.data.leavingId) return;

    this.setData({ leavingId: task._id });

    try {
      await api.taskApi.leave(task._id);
      toast.success('已退出协办');
      // 退出成功后从列表移除，不用整页重拉
      this.setData({
        list: this.data.list.filter((t) => t._id !== task._id),
      });
    } catch (e) {
      // 名单可能刚被主办人改过 —— 重拉一次让列表回到真实状态
      if (e.code === 'INVALID_PARAM' || e.code === 'TASK_NOT_FOUND') {
        setTimeout(() => this.refresh(), 800);
      }
    } finally {
      this.setData({ leavingId: '' });
    }
  },
});
