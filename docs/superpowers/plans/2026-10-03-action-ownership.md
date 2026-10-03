# 动作归属重排实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「浏览他人任务」的页面（任务看板 → 任务详情）彻底只读，把上报进展留在报任务、把删除与退出协办集中到改任务。

**Architecture:** 纯前端改动。新增一个与 `pages/join` 对偶的 `pages/leave` 页；把 `task-edit` 加一个底部危险区承接删除；把 `task-detail` 底部那一整块操作栏摘掉。云函数、权限规则、数据库、`shared/`、`utils/` 全部零改动。

**Tech Stack:** 微信小程序原生（WXML/WXSS/CommonJS），零构建步骤，无 npm 依赖。测试靠仓库外的 node 桩脚本驱动真实页面方法 + `scripts/selfcheck.js`。

**Spec:** `docs/superpowers/specs/2026-10-03-action-ownership-design.md`

## Global Constraints

- **零构建步骤** —— 改完必须能直接在微信开发者工具里编译运行。不引入 npm、不引入打包器、不写 ES Module 语法，一律 CommonJS `require` / `module.exports`。
- **不碰 `shared/`** —— `shared/` 的任何改动都会经 `scripts/sync-shared.js` 污染 7 份云函数副本，按项目纪律还要重新部署全部云函数。本计划一行都不动它。
- **不碰 `cloudfunctions/`、`scripts/`、数据库** —— 不加字段、不加枚举值、不改权限规则。所有权限判据一律调用 `shared/perm.js` 里已有的函数，**禁止在前端另写一条规则**。
- **不硬编码颜色** —— WXSS 里一律 `var(--xxx)`（令牌在 `miniprogram/app.wxss` 的 `page {}` 块里）。`app.wxss` 文件头明令禁止写死色值。
- **页面 WXSS 不跨页** —— 页面自己的 `.wxss` 只对本页生效；要跨页复用的类必须放进 `app.wxss`。
- **`git` 只提交到本地** —— 本仓库刻意不配远程（含真实同事姓名）。**不要 `git push`**。
- 分支：`ui-beautify`。

## Review Focus

以下几类输入是 spec 的隐含要求，写代码时最容易漏，各自在所属任务里配了测试：

1. **协办名单在我打开退出协办页之后、点击之前被别人改了** —— 主办人同时在别处把我移出名单。点「退出协办」应当给出可读的提示、把这一行收掉，而不是按钮永久卡在 loading 或静默什么都不发生。
2. **一个任务既是我主办、又把我列进了协办名单**（历史脏数据，2026-10-03 刚修过一批）—— 它**不能**出现在退出协办列表里，否则点了必被云函数 `perm.canLeave` 拒。
3. **任务没有 `leaderId`**（61 条历史任务里 59 条如此）—— 删除按钮的显隐判据必须走 `perm.canDeleteTask`，不能因为 `leaderId` 为空就抛错或误判成可删。
4. **删除一个我已经改了但还没保存的任务**（`dirtyCount > 0`）—— 确认弹窗必须明确告知未保存的改动会一起丢失，不能静默丢弃。
5. **卡壳记录由别人提交、而我不是主办人** —— 详情页那条记录上不该出现「标记已解决」；我自己提交的那条要出现。

---

## 文件结构

| 文件 | 职责 | 本计划中的动作 |
|---|---|---|
| `miniprogram/pages/leave/index.js` | 退出协办页逻辑 | 新建 |
| `miniprogram/pages/leave/index.wxml` | 退出协办页结构（与 `pages/join` 对偶） | 新建 |
| `miniprogram/pages/leave/index.wxss` | 退出协办页样式（卡片+按钮叠放） | 新建 |
| `miniprogram/pages/leave/index.json` | 页面配置（标题、下拉刷新、组件） | 新建 |
| `miniprogram/app.json` | 注册页面路由 | 加一行 |
| `miniprogram/app.wxss` | 全局样式令牌与通用件 | 新增 `.entry-card` |
| `miniprogram/pages/update/index.wxml` | 改任务列表页 | 加底部入口卡 |
| `miniprogram/pages/update/index.js` | 改任务列表页逻辑 | 加 `onLeaveTap` |
| `miniprogram/pages/update/index.wxss` | 改任务列表页样式 | 不变（入口卡样式在 app.wxss） |
| `miniprogram/pages/report/index.wxml` | 报任务列表页 | 入口卡类名 `join-entry` → `entry-card` |
| `miniprogram/pages/report/index.wxss` | 报任务列表页样式 | 删 `.join-entry` 两条规则 |
| `miniprogram/pages/task-edit/index.wxml` | 改任务编辑页 | 加底部危险区 |
| `miniprogram/pages/task-edit/index.js` | 改任务编辑页逻辑 | 加 `canDelete` + `onDelete` |
| `miniprogram/pages/task-edit/index.wxss` | 改任务编辑页样式 | 加危险区两条规则 |
| `miniprogram/pages/task-detail/index.wxml` | 任务详情页 | 删底部操作栏，卡壳计数移入信息卡 |
| `miniprogram/pages/task-detail/index.js` | 任务详情页逻辑 | 删 `computePerms` 与 5 个 handler |
| `miniprogram/pages/task-detail/index.wxss` | 任务详情页样式 | 删 4 个死类，调 `.detail__alert` |

**为什么 `.entry-card` 要放进 `app.wxss` 而不是复制一份**：报任务页的「新加入协办」入口卡和改任务页的「退出协办」入口卡是同一个视觉件（`.card.card--flat` + 标题/说明 + 40rpx 箭头）。这个仓库刚刚做过一轮「页面里重复定义的类上提到 `app.wxss`」的清理（见 `pages/task-edit/index.wxss` 顶部的注释），再添一份复制品是往回走。

**任务顺序的理由**：任务 1、2 是纯新增（新增页面、新增入口），做完 App 仍然完全可用；任务 3 是新增删除入口（此时删除在两个页面都有，不留空窗）；任务 4 才是删减（摘掉详情页操作栏）。**任何一步中断，App 都不会处于「删不了任务」或「退出不了协办」的状态。**

---

### Task 1: `pages/leave` 退出协办页

**Files:**
- Create: `miniprogram/pages/leave/index.js`
- Create: `miniprogram/pages/leave/index.wxml`
- Create: `miniprogram/pages/leave/index.wxss`
- Create: `miniprogram/pages/leave/index.json`
- Modify: `miniprogram/app.json:10`
- Test: `C:/Users/Administrator/AppData/Local/Temp/tp-leave.js`（仓库外，跑完删）

**Interfaces:**
- Consumes: `utils/db.js` 的 `myJoinedTasks(openid)`（已存在，返回 `collaboratorIds` 含该 openid 的全部任务，不按阶段过滤）；`shared/perm.js` 的 `canLeave(task, openid)`（已存在，主办人返回 `false`）；`utils/api.js` 的 `taskApi.leave(taskId)`（已存在，云函数 `taskService.leave`）；`utils/format.js` 的 `decorateTasks(list)`（已存在）
- Produces: 路由 `pages/leave/index`，无 query 参数。Task 2 的入口卡跳这个路由。

- [ ] **Step 1: 写失败测试**

创建 `C:/Users/Administrator/AppData/Local/Temp/tp-leave.js`（用 Write 工具写，不要用 bash heredoc，引号会坏）：

```js
/**
 * 仓库外临时脚本：桩掉 utils/*，驱动真实的 pages/leave 页面方法。
 * 用法：node C:/Users/Administrator/AppData/Local/Temp/tp-leave.js
 */
'use strict';
const path = require('path');
const Module = require('module');
const assert = require('assert');

const ROOT = 'G:/TeamPulse/miniprogram';
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
const stub = (rel) => norm(path.join(ROOT, rel));

const ME = 'openid-me';
const BOSS = 'openid-boss';
const OTHER = 'openid-other';

// ── 测试数据 ──────────────────────────────────────────────────────────
const TASKS = [
  { _id: 't1', task_name: '我协办的活', leaderId: BOSS, collaboratorIds: [ME], stage: '进行中', due_date: '2026-10-10' },
  // ★ Review Focus #2：既是我主办、又把我列进了协办 —— 必须被滤掉
  { _id: 't2', task_name: '我主办又被列协办', leaderId: ME, collaboratorIds: [ME], stage: '进行中', due_date: '2026-10-11' },
  // ★ 含已完成 —— 与 join 页刻意不同
  { _id: 't3', task_name: '我协办的已完成的活', leaderId: BOSS, collaboratorIds: [ME], stage: '已完成', due_date: '2026-09-01' },
  { _id: 't4', task_name: '与我无关的活', leaderId: BOSS, collaboratorIds: [OTHER], stage: '进行中', due_date: '2026-10-12' },
];

// ── 调用记录 ──────────────────────────────────────────────────────────
const calls = { leave: [], navigateBack: 0, toasts: [] };

let leaveBehavior = 'ok'; // 'ok' | 'notInList'

const stubs = {};
stubs[stub('utils/api.js')] = {
  taskApi: {
    leave: async (taskId) => {
      calls.leave.push(taskId);
      if (leaveBehavior === 'notInList') {
        const err = new Error('你不在该任务的协办名单中');
        err.code = 'INVALID_PARAM';
        throw err;
      }
      return { taskId, left: true };
    },
  },
  setClaimHandler: () => {},
  progressApi: {},
  memberApi: {},
};
stubs[stub('utils/auth.js')] = {
  requireClaimed: async () => ({ openid: ME, member: { name: '我' } }),
  isAdmin: () => false,
  gotoClaim: () => {},
};
stubs[stub('utils/db.js')] = {
  myJoinedTasks: async (openid) =>
    TASKS.filter((t) => Array.isArray(t.collaboratorIds) && t.collaboratorIds.indexOf(openid) !== -1),
};
stubs[stub('utils/toast.js')] = {
  toast: (m) => calls.toasts.push(m),
  success: (m) => calls.toasts.push(m),
  error: (m) => calls.toasts.push(m),
  confirm: async () => true,
  withLoading: (fn) => fn(),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch (e) {
    return origLoad.apply(this, arguments);
  }
  const hit = stubs[norm(resolved)];
  if (hit) return hit;
  return origLoad.apply(this, arguments);
};

// ── 页面环境 ──────────────────────────────────────────────────────────
let pageObj = null;
global.Page = (o) => { pageObj = o; };
global.wx = {
  navigateBack: () => { calls.navigateBack += 1; },
  stopPullDownRefresh: () => {},
};

function mount(page) {
  page.data = Object.assign({}, page.data);
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) this.data[k] = patch[k];
  };
  return page;
}

// ── 用例 ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}

(async () => {
  console.log('── pages/leave ──');
  require(path.join(ROOT, 'pages/leave/index.js'));
  assert.ok(pageObj, 'Page() 没有被调用 —— 页面文件没加载成功');

  const p = mount(pageObj);

  // ① 初始列表
  await p.refresh();
  const ids = p.data.list.map((t) => t._id).sort();
  check('列表 = 我协办且我非主办，含已完成', ids, ['t1', 't3']);
  check('我主办的任务不在列表里（Review Focus #2）', ids.indexOf('t2'), -1);
  check('与我无关的任务不在列表里', ids.indexOf('t4'), -1);
  check('已完成的任务在列表里（与 join 页刻意不同）', ids.indexOf('t3') !== -1, true);
  check('loading 已复位', p.data.loading, false);

  // ② 退出成功 → 就地移除
  const row1 = p.data.list.find((t) => t._id === 't1');
  await p.onLeave({ currentTarget: { dataset: { task: row1 } } });
  check('调了 taskApi.leave(t1)', calls.leave, ['t1']);
  check('退出后该行就地消失', p.data.list.map((t) => t._id), ['t3']);
  check('leavingId 已复位', p.data.leavingId, '');
  check('没有整页重拉（list 只少了 t1）', p.data.list.length, 1);

  // ③ 期间被别人移出名单 → 失败后重拉，不卡 loading
  leaveBehavior = 'notInList';
  const row3 = p.data.list.find((t) => t._id === 't3');
  await p.onLeave({ currentTarget: { dataset: { task: row3 } } });
  check('leavingId 在失败后也必须复位（Review Focus #1）', p.data.leavingId, '');
  await new Promise((r) => setTimeout(r, 900)); // 等 setTimeout(refresh, 800)
  check('失败后重拉过（loading 已复位）', p.data.loading, false);

  // ④ 连点保护
  leaveBehavior = 'ok';
  const before = calls.leave.length;
  p.setData({ leavingId: 't3' });
  await p.onLeave({ currentTarget: { dataset: { task: row3 } } });
  check('leavingId 非空时忽略点击', calls.leave.length, before);

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exit(1);
})();
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node C:/Users/Administrator/AppData/Local/Temp/tp-leave.js`
Expected: 抛 `Error: Cannot find module 'G:\TeamPulse\miniprogram\pages\leave\index.js'` —— 页面还不存在。

- [ ] **Step 3: 建页面目录与配置文件**

`miniprogram/pages/leave/index.json`：

```json
{
  "navigationBarTitleText": "退出协办",
  "enablePullDownRefresh": true,
  "usingComponents": {
    "task-card": "/components/task-card/index",
    "empty-state": "/components/empty-state/index"
  }
}
```

- [ ] **Step 4: 写页面逻辑**

`miniprogram/pages/leave/index.js`：

```js
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
```

> ⚠️ 注意这里**没有** `res.idempotent` 分支 —— `taskService.leave` 的返回值是
> `{ taskId, left: true, ...snap }`，压根没有 `idempotent` 字段（只有 `join` 有）。
> 不要照抄 join 页的这一段，那会读到一个永远是 `undefined` 的字段。

- [ ] **Step 5: 写页面结构**

`miniprogram/pages/leave/index.wxml`：

```xml
<!-- pages/leave 退出协办 -->
<view class="page">

  <view wx:if="{{loading && !list.length}}" class="loading-block">正在加载…</view>

  <block wx:else>
    <view wx:if="{{list.length}}" class="card card--flat leave__intro">
      <view class="t-sub">
        以下是你参与协办的任务（含已完成）。点击「退出协办」即把自己从协办名单中移除，
        历史进展不受影响。
      </view>
    </view>

    <block wx:if="{{list.length}}">
      <view wx:for="{{list}}" wx:key="_id" class="leave__item">
        <task-card
          task="{{item}}"
          show-leader="{{true}}"
          show-collaborators="{{true}}"
        />
        <button
          class="btn btn--plain btn--sm leave__btn"
          data-task="{{item}}"
          loading="{{leavingId === item._id}}"
          disabled="{{!!leavingId}}"
          bindtap="onLeave"
        >退出协办</button>
      </view>
    </block>

    <empty-state
      wx:else
      title="没有你协办的任务"
      hint="到「报任务」页的「新加入协办」里可以参与他人的任务"
    />
  </block>
</view>
```

> 按钮用 `btn--plain`（灰色描边）而不是 join 页的 `btn--ghost`（主色描边）：
> 加入是主色系的正面动作，退出不是，别让每个退出按钮都亮成主色。

- [ ] **Step 6: 写页面样式**

`miniprogram/pages/leave/index.wxss`：

```css
/* pages/leave */

.leave__intro {
  margin-bottom: var(--gap);
}

/*
 * 卡片与按钮叠放：task-card 自带 margin-bottom，
 * 这里把按钮上移，让它在视觉上归属上方那张卡片。
 * （与 pages/join 的 .join__item / .join__btn 同款，页面 WXSS 不跨页，
 *   所以这两个文件各留一份是必要的。）
 */
.leave__item {
  position: relative;
}

.leave__btn {
  display: flex;
  width: 100%;
  margin: -8rpx 0 24rpx;
}
```

- [ ] **Step 7: 注册路由**

`miniprogram/app.json`，在 `pages` 数组里 `"pages/join/index"` 之后插入一行：

```json
    "pages/join/index",
    "pages/leave/index",
    "pages/task-edit/index",
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node C:/Users/Administrator/AppData/Local/Temp/tp-leave.js`
Expected: 全部 ✓，末行「通过 12 项，失败 0 项」。

- [ ] **Step 9: 确认没碰到后端**

Run: `node scripts/selfcheck.js && node scripts/sync-shared.js --check`
Expected: `通过 184 项，失败 0 项`，然后 `✓ 已同步，无差异`。

- [ ] **Step 10: 提交**

```bash
git add miniprogram/pages/leave miniprogram/app.json
git commit -m "feat: 新增退出协办页 pages/leave

与 pages/join 对偶：列出我参与协办的任务，点一下退出。

两处刻意与 join 不同：
- 不过滤已完成 —— 已完成的协办关系正是最想清掉的那批
- 要滤掉我主办的任务 —— 一个任务可能既是我主办又把我列进了协办，
  主办人「退出」自己的任务是荒谬的，云函数 perm.canLeave 也会拒

云函数、权限规则、数据库均零改动。"
```

---

### Task 2: 「退出协办」入口 + 入口卡样式收敛

**Files:**
- Modify: `miniprogram/app.wxss`（在 `.pill` 块之后、`.filter-pill` 之前插入 `.entry-card`）
- Modify: `miniprogram/pages/update/index.wxml:74`
- Modify: `miniprogram/pages/update/index.js:140`
- Modify: `miniprogram/pages/report/index.wxml:109`
- Modify: `miniprogram/pages/report/index.wxss:35-46`
- Test: 人工 + 类名定义检查（无页面逻辑变更，不需要 node 桩）

**Interfaces:**
- Consumes: Task 1 建好的路由 `pages/leave/index`
- Produces: `app.wxss` 的全局类 `.entry-card`（供任何「整卡可点的下钻入口」使用）

- [ ] **Step 1: 在 `app.wxss` 加共享入口卡样式**

在 `miniprogram/app.wxss` 的 `.pill--warn .pill__value { ... }` 规则之后、
「筛选胶囊」注释块之前，插入：

```css
/* ─────────────────────────────────────────────────────────────────────────
   入口卡 —— 整张卡片可点的下钻入口
   报任务的「新加入协办」与改任务的「退出协办」共用。
   结构 = .card.card--flat + 左侧标题/说明 + 右侧箭头（箭头用 .field__arrow）。
   ───────────────────────────────────────────────────────────────────────── */

.entry-card {
  margin-top: var(--gap);
}

/*
 * 箭头在这里放大到 40rpx。★ 40rpx 不是字号，是图标尺寸 ——
 * 它是可点入口的指示符（和 tabBar 图标同类），不参与文字层级，
 * 所以刻意跳出 --fs-* 那套令牌。
 */
.entry-card .field__arrow {
  font-size: 40rpx;
}
```

- [ ] **Step 2: 报任务页改用它（纯类名替换，行为不变）**

`miniprogram/pages/report/index.wxml:109`，把：

```xml
    <view class="card card--flat join-entry hit" bindtap="onJoinTap">
```

改成：

```xml
    <view class="card card--flat entry-card hit" bindtap="onJoinTap">
```

`miniprogram/pages/report/index.wxss`，删掉第 35-46 行（`.join-entry` 与
`.join-entry .field__arrow` 两条规则 + 它们上方那段「★ 40rpx 不是字号」的注释）。
**只删这些** —— 该文件里还有 `.report__sticky`（吸顶分组标题，本页核心机制）
与 `.report__note` 两条活规则，必须保留。

- [ ] **Step 3: 改任务页加入口卡**

`miniprogram/pages/update/index.wxml`，在「已完成」组那个 `</block>`（第 74 行）
之后、最外层 `</block>`（第 75 行）之前插入：

```xml

    <!-- ── 退出协办入口 ───────────────────────────────────────────── -->
    <view class="card card--flat entry-card hit" bindtap="onLeaveTap">
      <view class="row row--between">
        <view class="flex-1">
          <view class="t-title">退出协办</view>
          <view class="t-muted">浏览你参与协办的任务，可自行退出</view>
        </view>
        <text class="field__arrow">›</text>
      </view>
    </view>
```

> 放在 `wx:else` 块**内部**（与报任务页的入口卡一致），加载中不显示；
> 不受「在办列表是否为空」影响 —— 一条主办任务都没有的人照样能去退出协办。

- [ ] **Step 4: 改任务页加跳转**

`miniprogram/pages/update/index.js`，在 `onTaskTap` 之后（文件末尾 `});` 之前）插入：

```js
  onLeaveTap() {
    wx.navigateTo({ url: '/pages/leave/index' });
  },
```

- [ ] **Step 5: 检查类名有定义、无残留**

Run:
```bash
grep -rn "join-entry" miniprogram/ || echo "✓ join-entry 已清空"
grep -rn "entry-card" miniprogram/
```
Expected: 第一条输出「✓ join-entry 已清空」；第二条列出 `app.wxss` 的定义 2 处 +
`report/index.wxml` 与 `update/index.wxml` 各 1 处使用。

- [ ] **Step 6: 人工验收**

在微信开发者工具里：
1. 报任务页底部的「新加入协办」卡片外观与改版前**完全一致**（只是类名换了）
2. 改任务页底部出现「退出协办」入口，箭头大小与报任务页那个一致
3. 点进改任务页的「退出协办」→ 进入退出协办页，标题为「退出协办」
4. 改任务页一条主办任务都没有时，入口卡**仍然出现**

- [ ] **Step 7: 提交**

```bash
git add miniprogram/app.wxss miniprogram/pages/update miniprogram/pages/report
git commit -m "feat: 改任务页加「退出协办」入口，入口卡样式收敛到 app.wxss

报任务的「新加入协办」与改任务的「退出协办」是同一个视觉件，
把 .join-entry 上提为全局 .entry-card，两页共用，不再各留一份。
报任务页只有类名变化，行为与外观不变。"
```

---

### Task 3: `task-edit` 底部危险区：删除任务

**Files:**
- Modify: `miniprogram/pages/task-edit/index.wxml:181`
- Modify: `miniprogram/pages/task-edit/index.js`（`data` 加字段、`load()` 加 `canDelete`、文件末尾加 `onDelete`）
- Modify: `miniprogram/pages/task-edit/index.wxss`
- Test: `C:/Users/Administrator/AppData/Local/Temp/tp-edit-delete.js`（仓库外，跑完删）

**Interfaces:**
- Consumes: `shared/perm.js` 的 `canDeleteTask(task, openid, isAdmin)`；`utils/api.js` 的 `taskApi.remove(taskId)`（云函数 action 是 `delete`）；`utils/auth.js` 的 `isAdmin()`；`utils/toast.js` 的 `confirm(msg, title, confirmText)` / `withLoading(fn, text)` / `success(msg)`
- Produces: `data.canDelete`（布尔，WXML 读它决定危险区显隐）、`onDelete()` 事件处理器

- [ ] **Step 1: 写失败测试**

创建 `C:/Users/Administrator/AppData/Local/Temp/tp-edit-delete.js`：

```js
/**
 * 仓库外临时脚本：桩掉 utils/*，驱动真实的 pages/task-edit 页面方法，
 * 验证删除按钮的显隐判据与云函数同源、以及删除的实际调用。
 * 用法：node C:/Users/Administrator/AppData/Local/Temp/tp-edit-delete.js
 */
'use strict';
const path = require('path');
const Module = require('module');
const assert = require('assert');

const ROOT = 'G:/TeamPulse/miniprogram';
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
const stub = (rel) => norm(path.join(ROOT, rel));

const ME = 'openid-me';
const BOSS = 'openid-boss';
const OTHER = 'openid-other';

// 被测任务由用例逐个改
let TASK = null;
let AM_ADMIN = false;

const calls = { remove: [], navigateBack: 0, confirmTexts: [], errors: [] };
let confirmAnswer = true;

const stubs = {};
stubs[stub('utils/api.js')] = {
  taskApi: {
    remove: async (taskId) => { calls.remove.push(taskId); return { deleted: true }; },
    update: async () => ({ ok: true }),
  },
  memberApi: { listMembers: async () => ({ list: [{ _id: 'm1', name: '甲', openid: 'openid-a' }] }) },
  setClaimHandler: () => {},
};
stubs[stub('utils/auth.js')] = {
  requireClaimed: async () => ({ openid: ME, member: { name: '我' } }),
  isAdmin: () => AM_ADMIN,
  gotoClaim: () => {},
};
stubs[stub('utils/db.js')] = {
  getDoc: async () => TASK,
};
stubs[stub('utils/toast.js')] = {
  toast: () => {},
  success: () => {},
  error: (m) => calls.errors.push(m),
  confirm: async (msg) => { calls.confirmTexts.push(msg); return confirmAnswer; },
  withLoading: (fn) => fn(),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved;
  try { resolved = Module._resolveFilename(request, parent, isMain); }
  catch (e) { return origLoad.apply(this, arguments); }
  const hit = stubs[norm(resolved)];
  if (hit) return hit;
  return origLoad.apply(this, arguments);
};

let pageObj = null;
global.Page = (o) => { pageObj = o; };
global.wx = {
  navigateBack: () => { calls.navigateBack += 1; },
  stopPullDownRefresh: () => {},
};

function mount(page) {
  page.data = Object.assign({}, page.data);
  page.setData = function (patch) {
    for (const k of Object.keys(patch)) this.data[k] = patch[k];
  };
  return page;
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}

const perm = require(path.join(ROOT, 'shared/perm.js'));

(async () => {
  console.log('── pages/task-edit 危险区 ──');
  require(path.join(ROOT, 'pages/task-edit/index.js'));
  assert.ok(pageObj, 'Page() 没有被调用');

  const p = mount(pageObj);
  p.setData({ taskId: 'tk-1' });

  // ① 我主办 → 可删
  TASK = { _id: 'tk-1', task_name: '我的活', leaderId: ME, collaboratorIds: [], stage: '进行中' };
  await p.load();
  check('我主办的任务：canDelete 为真', p.data.canDelete, true);
  check('与 perm.canDeleteTask 口径一致', p.data.canDelete, perm.canDeleteTask(TASK, ME, false));

  // ② 无 leaderId 的历史任务、我不是管理员 → 不可删（Review Focus #3）
  //    ★ 这条必须走 perm，不能因为在页里读 task.leaderId 而抛错
  TASK = { _id: 'tk-1', task_name: '历史遗留', leaderId: '', collaboratorIds: [], stage: '进行中' };
  await p.load();
  check('无 leaderId 且非管理员：canDelete 为假', p.data.canDelete, false);

  // ③ 无 leaderId 的历史任务、我是管理员 → 可删
  AM_ADMIN = true;
  TASK = { _id: 'tk-1', task_name: '历史遗留', leaderId: '', collaboratorIds: [], stage: '进行中' };
  await p.load();
  check('无 leaderId 但是管理员：canDelete 为真', p.data.canDelete, true);
  AM_ADMIN = false;

  // ④ 非主办 → load() 的守则会挡回（toast.error + navigateBack），canDelete 不置真
  TASK = { _id: 'tk-1', task_name: '别人的活', leaderId: BOSS, collaboratorIds: [], stage: '进行中' };
  p.setData({ taskId: 'tk-1', canDelete: false });
  await p.load();
  check('非主办人：canDelete 不为真', !!p.data.canDelete, false);
  check('非主办人被挡回并提示', calls.errors.length > 0, true);

  // ⑤ 删除：确认 → 调 api.taskApi.remove → navigateBack
  TASK = { _id: 'tk-9', task_name: '要删的活', leaderId: ME, collaboratorIds: [], stage: '进行中' };
  await p.load();
  if (typeof p.onDelete !== 'function') {
    console.log('  ✗ p.onDelete is not a function（页面上还没实现）');
    fail += 1;
  } else {
    await p.onDelete();
    check('调了 taskApi.remove(tk-9)', calls.remove, ['tk-9']);
    await new Promise((r) => setTimeout(r, 900)); // 等 setTimeout(navigateBack, 800)
    check('删除后返回上一页', calls.navigateBack > 0, true);

    // ⑥ 有未保存改动时，确认文案要提到改动会丢失（Review Focus #4）
    calls.confirmTexts.length = 0;
    calls.remove.length = 0;
    TASK = { _id: 'tk-10', task_name: '改了一半的活', leaderId: ME, collaboratorIds: [], stage: '进行中' };
    await p.load();
    p.markDirty('task_name');
    check('已记到 1 项改动', p.data.dirtyCount, 1);
    await p.onDelete();
    check(
      '确认文案提到了未保存改动',
      /未保存|未提交|改动/.test(calls.confirmTexts[0] || ''),
      true
    );

    // ⑦ 确认框点取消 → 不调 api
    calls.remove.length = 0;
    confirmAnswer = false;
    await p.onDelete();
    check('取消后不调 api', calls.remove, []);
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exit(1);
})();
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node C:/Users/Administrator/AppData/Local/Temp/tp-edit-delete.js`
Expected: FAIL —— `data.canDelete` 是 `undefined`（页面上还没有这个字段），以及
`p.onDelete is not a function`。

- [ ] **Step 3: 加 data 字段**

`miniprogram/pages/task-edit/index.js`，在 `data` 里的 `task: {},`（或现有任务相关字段）
之后加：

```js
    /**
     * 能否删除本任务。判据与云函数同源（shared/perm.js），
     * 前端不另写一条规则 —— 理由同本文件顶部的两条守则。
     */
    canDelete: false,
```

- [ ] **Step 4: 在 `load()` 里算 `canDelete`**

`miniprogram/pages/task-edit/index.js`，`load()` 里那个 `this.setData({...})`
（现在以 `task: fmt.decorateTask(task),` 结尾）改成：

```js
      this.setData({
        loading: false,
        origin: Object.assign({}, form),
        // 单独存一份协办人原始值，供「还原」使用
        originCollaboratorIds: (task.collaboratorIds || []).slice(),
        form,
        collaboratorIds: (task.collaboratorIds || []).slice(),
        allMembers: claimed,
        task: fmt.decorateTask(task),
        // ★ 传入 task 原文档（不是 decorateTask 的产物）—— 判据函数要看
        //   leaderId 与 collaboratorIds，装饰后的对象虽然也带着，但保持
        //   与云函数拿到的是同一个形状更不容易出错。
        canDelete: perm.canDeleteTask(task, session.openid, auth.isAdmin()),
      });
```

- [ ] **Step 5: 加 `onDelete`**

`miniprogram/pages/task-edit/index.js`，在 `onReset()` 之后、文件末尾的 `});` 之前插入：

```js
  /**
   * 删除任务（主办人或管理员）。级联删除进展由云函数处理。
   *
   * ★ 从 pages/task-detail 搬来的：那里现在是纯只读页，不该有写操作入口。
   * ★ 本页有「改了还没保存」的状态，删除会把它一起丢掉，所以确认文案要
   *   在那种情况下多说一句 —— 否则用户会以为自己改的东西还在。
   */
  onDelete() {
    const { task, taskId, dirtyCount } = this.data;
    if (!task) return;

    const base = `将永久删除「${task.task_name}」及其全部进展记录，不可恢复。`;
    const extra = dirtyCount ? `\n\n你有 ${dirtyCount} 项改动尚未保存，也会一并丢失。` : '';

    toast
      .confirm(base + extra, '删除任务', '删除')
      .then(async (ok) => {
        if (!ok) return;
        try {
          await toast.withLoading(() => api.taskApi.remove(taskId), '删除中');
          toast.success('已删除');
          setTimeout(() => wx.navigateBack(), 800);
        } catch (e) {
          /* api 层已提示 */
        }
      });
  },
```

- [ ] **Step 6: 写危险区结构**

`miniprogram/pages/task-edit/index.wxml`，在「主办人」卡片那个 `</view>`
（第 181 行）之后、`</block>`（第 182 行）之前插入：

```xml

    <!--
      ── 危险区：删除任务 ─────────────────────────────────────────────
      ★ 放在滚动内容的最底部，**不放固定底栏**。底栏是「保存」的地盘，
        删除混进去迟早有人手滑点到。
      ★ 红描边不填充，与 .btn--danger 的实心红刻意区分开。
      ★ 显隐走 perm.canDeleteTask（与云函数同源）。实际上这页只有主办人
        进得来，所以按钮对能进来的人恒为真；仍走同一函数是为了将来
        规则变化时两边不漂移。
    -->
    <block wx:if="{{canDelete}}">
      <view class="divider"></view>

      <view class="card card--flat edit__danger-zone">
        <view class="t-muted edit__danger-tip">
          删除后，这个任务及其全部进展记录都会消失，无法恢复。
        </view>
        <button class="btn edit__danger" bindtap="onDelete">删除该任务</button>
      </view>
    </block>
```

- [ ] **Step 7: 写危险区样式**

`miniprogram/pages/task-edit/index.wxss`，追加到文件末尾：

```css
/* ── 危险区：删除任务 ── */

.edit__danger-zone {
  margin-top: var(--gap);
}

.edit__danger-tip {
  line-height: 1.6;
}

/*
 * 红描边不填充 —— 底栏已经有一个实心主色的「保存」，
 * 再来一个实心红，两个实心按钮会互相抢视觉重心，
 * 而删除恰恰是最不该被误点的那一个。
 */
.edit__danger {
  width: 100%;
  margin-top: 20rpx;
  color: var(--tone-danger);
  background: var(--card);
  border: 2rpx solid var(--tone-danger);
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node C:/Users/Administrator/AppData/Local/Temp/tp-edit-delete.js`
Expected: 全部 ✓，末行「通过 11 项，失败 0 项」。

- [ ] **Step 9: 确认没碰到后端**

Run: `node scripts/selfcheck.js && node scripts/sync-shared.js --check`
Expected: `通过 184 项，失败 0 项`，然后 `✓ 已同步，无差异`。

- [ ] **Step 10: 提交**

```bash
git add miniprogram/pages/task-edit
git commit -m "feat: 删除任务挪到改任务页底部的独立危险区

从 pages/task-detail 的底部操作栏搬过来 —— 那里正在改为纯只读。
放在滚动内容最底部而不是固定底栏里：底栏是「保存」的地盘，
删除混进去迟早有人手滑点到。

显隐判据走 perm.canDeleteTask（与云函数同源）；
有未保存改动时确认文案会多说一句，避免改动被静默丢弃。"
```

---

### Task 4: `task-detail` 改为纯只读

**Files:**
- Modify: `miniprogram/pages/task-detail/index.wxml`
- Modify: `miniprogram/pages/task-detail/index.js`
- Modify: `miniprogram/pages/task-detail/index.wxss`
- Test: `C:/Users/Administrator/AppData/Local/Temp/tp-detail-readonly.js`（仓库外，跑完删）

**Interfaces:**
- Consumes: 无新增。本任务只做删减。
- Produces: 无新增。**注意：本任务删掉 `data.canEdit` / `canJoin` / `canLeave` / `canReport` / `canDelete` / `isLeader` / `isParticipant` / `isAdmin` / `myOpenid`，以及 `computePerms`、`onReport`、`onEdit`、`onJoin`、`onLeave`、`onDelete`。仓库内不得再有引用。**

- [ ] **Step 1: 写失败测试**

创建 `C:/Users/Administrator/AppData/Local/Temp/tp-detail-readonly.js`：

```js
/**
 * 仓库外临时脚本：验证 pages/task-detail 只读化之后
 *   ① 时间线的「标记已解决」判定仍然正确
 *   ② 写操作入口与权限字段全部消失
 * 用法：node C:/Users/Administrator/AppData/Local/Temp/tp-detail-readonly.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const assert = require('assert');

const ROOT = 'G:/TeamPulse/miniprogram';
const PAGE = path.join(ROOT, 'pages/task-detail');
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
const stub = (rel) => norm(path.join(ROOT, rel));

const ME = 'openid-me';
const BOSS = 'openid-boss';
const OTHER = 'openid-other';

const stubs = {};
stubs[stub('utils/api.js')] = { setClaimHandler: () => {}, progressApi: {}, taskApi: {} };
stubs[stub('utils/auth.js')] = { requireClaimed: async () => ({ openid: ME }), isAdmin: () => false, gotoClaim: () => {} };
stubs[stub('utils/db.js')] = { getDoc: async () => null, progressOf: async () => [] };
stubs[stub('utils/toast.js')] = { toast: () => {}, success: () => {}, error: () => {}, confirm: async () => true, withLoading: (fn) => fn() };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved;
  try { resolved = Module._resolveFilename(request, parent, isMain); }
  catch (e) { return origLoad.apply(this, arguments); }
  const hit = stubs[norm(resolved)];
  if (hit) return hit;
  return origLoad.apply(this, arguments);
};

let pageObj = null;
global.Page = (o) => { pageObj = o; };
global.wx = { navigateBack: () => {}, stopPullDownRefresh: () => {}, navigateTo: () => {} };

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}

(async () => {
  console.log('── pages/task-detail 只读化 ──');
  require(path.join(PAGE, 'index.js'));
  assert.ok(pageObj, 'Page() 没有被调用');

  pageObj.setData = function (patch) { for (const k of Object.keys(patch)) this.data[k] = patch[k]; };

  // ① _canResolve 判定（Review Focus #5）
  const rec = (id, who, blocker, resolved) => ({
    _id: id, updaterId: who, hasBlocker: blocker, blockerResolved: !!resolved,
    updatedAt: new Date(),
  });

  // 我是协办人（被 BOSS 主办的任务），不是主办
  const task = { _id: 'tk-1', leaderId: BOSS, collaboratorIds: [ME] };
  let out = pageObj.decorateRecords(
    [rec('r1', OTHER, true), rec('r2', ME, true), rec('r3', ME, true, true)], task, ME
  );
  check('别人的卡壳记录：我不是主办 → 不能标记解决', out[0]._canResolve, false);
  check('我自己提交的卡壳：能标记解决', out[1]._canResolve, true);
  check('已解决的卡壳：不再显示按钮', out[2]._canResolve, false);

  // 我是主办
  const myTask = { _id: 'tk-1', leaderId: ME, collaboratorIds: [] };
  out = pageObj.decorateRecords([rec('r1', OTHER, true), rec('r2', OTHER, true, true)], myTask, ME);
  check('我是主办：别人的卡壳也能标记解决', out[0]._canResolve, true);
  check('我是主办：已解决的仍不显示按钮', out[1]._canResolve, false);

  // ② 死代码必须彻底消失
  const js = fs.readFileSync(path.join(PAGE, 'index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(PAGE, 'index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(PAGE, 'index.wxss'), 'utf8');

  check('index.js 无 computePerms', /computePerms/.test(js), false);
  check('index.js 无 onReport', /\bonReport\b/.test(js), false);
  check('index.js 无 onEdit', /\bonEdit\b/.test(js), false);
  check('index.js 无 onJoin', /\bonJoin\b/.test(js), false);
  check('index.js 无 onLeave', /\bonLeave\b/.test(js), false);
  check('index.js 无 onDelete', /\bonDelete\b/.test(js), false);
  check('index.js 无 myOpenid', /myOpenid/.test(js), false);
  check('index.js 无 isAdmin', /isAdmin/.test(js), false);

  check('index.wxml 无 footer-bar', /footer-bar/.test(wxml), false);
  check('index.wxml 无 canReport', /canReport/.test(wxml), false);
  check('index.wxml 无 canEdit', /canEdit/.test(wxml), false);
  check('index.wxml 无 canJoin', /canJoin/.test(wxml), false);
  check('index.wxml 无 canLeave', /canLeave/.test(wxml), false);
  check('index.wxml 无 canDelete', /canDelete/.test(wxml), false);
  check('index.wxml 无 page--with-footer', /page--with-footer/.test(wxml), false);
  check('index.wxml 保留了「标记已解决」按钮', /onResolveBlocker/.test(wxml), true);
  check('index.wxml 保留了卡壳计数', /openBlockerCount/.test(wxml), true);

  check('index.wxss 无 .detail__del', /\.detail__del/.test(wxss), false);
  check('index.wxss 无 .detail__edit', /\.detail__edit/.test(wxss), false);
  check('index.wxss 无 .detail__actions', /\.detail__actions/.test(wxss), false);
  check('index.wxss 无 .detail__hint', /\.detail__hint/.test(wxss), false);
  check('index.wxss 保留了 .detail__alert（承载卡壳计数）', /\.detail__alert/.test(wxss), true);

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exit(1);
})();
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node C:/Users/Administrator/AppData/Local/Temp/tp-detail-readonly.js`
Expected: FAIL —— `computePerms` / `onReport` / `footer-bar` 等检查项全部报 ✗。

- [ ] **Step 3: 摘掉底部操作栏，把卡壳计数移进信息卡**

`miniprogram/pages/task-detail/index.wxml`：

(a) 第 2 行根节点去掉 `page--with-footer`：

```xml
<view class="page">
```

(b) 删除第 161-191 行整块 `<!-- ── 底部操作栏 ── -->` 注释 + `<view wx:if="{{task}}" class="footer-bar">…</view>`。

(c) 在信息卡的 `detail__tags` 行（第 23-28 行那个 `row row--wrap detail__tags`）之后插入：

```xml
      <!-- 未解决的卡壳数。它是信息不是操作，原来在底部操作栏里，
           操作栏摘掉后挪到这里，否则这条信息就丢了。 -->
      <view wx:if="{{openBlockerCount}}" class="detail__alert">
        有 {{openBlockerCount}} 项未解决的卡壳
      </view>
```

(d) 空状态文案（第 96 行）改成不含「点下方按钮」的说法：

```xml
    <empty-state
      wx:if="{{!records.length}}"
      title="还没有进展记录"
      hint="主办人还未上报进展"
    />
```

- [ ] **Step 4: 删掉 JS 里的权限与操作代码**

`miniprogram/pages/task-detail/index.js`：

(a) 文件头注释第 7 行 `*   3. 底部操作栏（按权限显隐：上报进展 / 编辑 / 加入 / 退出 / 删除）`
改为：

```
 *   3. 纯只读 —— 本页不承载任何对任务的写操作。
 *      任务看板与成员任务页都跳这里，它们都是「浏览别人的活」的场景，
 *      把改动入口放在这里会让所有任务看起来都能改。
 *      写操作统一归在：改任务（编辑 / 删除）、报任务（上报进展 / 加入协办）、
 *      退出协办页。
```

(b) 第 9-12 行那段「★ 权限显隐一律用 shared/perm.js 的纯函数…」改成：

```
 * ★ 本页只剩一处权限判定：时间线上每条卡壳记录的「标记已解决」，
 *   由 decorateRecords 逐条调 perm.canResolveBlocker 算出。
 *   前端隐藏只是体验（不显示点了会被拒的按钮），真正的边界在云函数。
```

(c) `data` 里删掉这 8 个字段：`isLeader`、`isParticipant`、`canEdit`、`canJoin`、
`canLeave`、`canReport`、`canDelete`、`isAdmin`，以及 `myOpenid`（删前先确认它确实
没有读取方 —— 它只有声明与赋值）。`data` 只剩：

```js
  data: {
    taskId: '',
    task: null,
    loading: true,
    /** 进展记录（已装饰，含 _canResolve / _timeText 等） */
    records: [],
    /** 未解决的卡壳记录条数，显示在任务信息卡里 */
    openBlockerCount: 0,
  },
```

(d) `refresh()` 里的 `setData` 删掉 `myOpenid`、`isAdmin` 两行和展开的
`...this.computePerms(...)`，变成：

```js
      this.setData({
        task: decorated,
        records,
        openBlockerCount: records.filter((r) => r.hasBlocker && !r.blockerResolved).length,
        loading: false,
      });
```

(e) 删掉整个 `computePerms` 方法（含它上方那段注释）。

(f) 删掉 `onReport`、`onEdit`、`onJoin`、`onLeave`、`onDelete` 五个方法。
**保留** `onLeaderTap`、`onResolveBlocker`、`onCopyTaskName`。

- [ ] **Step 5: 删掉死样式**

`miniprogram/pages/task-detail/index.wxss`：

(a) 删掉第 201-226 行整块 `/* ── 底部操作栏 ── */` 里的 `.detail__alert`、
`.detail__actions`、`.detail__edit, .detail__del`、`.detail__hint`。

(b) **把 `.detail__alert` 加回来**，但要改注释与 `margin` —— 它现在住在信息卡内部，
属性名从 `margin-bottom` 改成 `margin-top`：

```css
/* ── 未解决卡壳计数 ──
   住在任务信息卡内部（原来在底部操作栏里，操作栏摘掉后挪上来的）。
   ★ 不用全局 .pill：胶囊底色是 var(--card) 的白，放进白卡片会隐形。 */

.detail__alert {
  padding: 12rpx 20rpx;
  margin-top: 16rpx;
  border-radius: var(--radius-sm);
  background: var(--tone-danger-bg);
  color: var(--tone-danger);
  font-size: var(--fs-caption);
  text-align: center;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node C:/Users/Administrator/AppData/Local/Temp/tp-detail-readonly.js`
Expected: 全部 ✓，末行「通过 27 项，失败 0 项」。

- [ ] **Step 7: 全仓确认无残留引用**

Run:
```bash
grep -rn "computePerms\|onReport\|onJoin\|onLeave\|onDelete" miniprogram/pages/task-detail/ || echo "✓ 详情页已清空"
grep -rn "task-detail" miniprogram/pages --include=*.wxml || echo "✓ 没有页面内联跳详情页"
```
Expected: 第一条「✓ 详情页已清空」。

- [ ] **Step 8: 确认没碰到后端**

Run: `node scripts/selfcheck.js && node scripts/sync-shared.js --check`
Expected: `通过 184 项，失败 0 项`，然后 `✓ 已同步，无差异`。

- [ ] **Step 9: 提交**

```bash
git add miniprogram/pages/task-detail
git commit -m "refactor: 任务详情页改为纯只读，摘掉底部操作栏

这页的两个入口（任务看板、成员任务页）都是「浏览别人的活」的场景，
却带着上报进展、编辑、加入协办、退出协办、删除五个写操作 ——
让所有任务看起来都能改。

摘掉整块 footer-bar 后，computePerms 及其 7 个 data 字段成为死代码
（复核确认它们只被 footer 和一句空状态提示使用；时间线唯一活着的
_canResolve 走的是 decorateRecords 里逐条调 perm.canResolveBlocker，
与 computePerms 无关），一并删除。myOpenid 本来就没人读，也删了。

「有 N 项未解决的卡壳」是信息不是操作，移入任务信息卡。"
```

---

### Task 5: 全局验收

**Files:**
- 无代码改动（只跑检查；发现问题回到对应任务修）

- [ ] **Step 1: 全量自动化**

```bash
node scripts/selfcheck.js
node scripts/sync-shared.js --check
```
Expected: `通过 184 项，失败 0 项`；`✓ 已同步，无差异`。

> 184 这个数字**必须不变** —— 本计划一行都没碰 `shared/`，
> 数字变了就说明改错了地方。

- [ ] **Step 2: 逐个跑三个桩脚本**

```bash
node C:/Users/Administrator/AppData/Local/Temp/tp-leave.js
node C:/Users/Administrator/AppData/Local/Temp/tp-edit-delete.js
node C:/Users/Administrator/AppData/Local/Temp/tp-detail-readonly.js
```
Expected: 三个都 0 失败。

- [ ] **Step 3: 全局死代码与孤儿引用扫描**

```bash
grep -rn "join-entry" miniprogram/ || echo "✓ join-entry 已清空"
grep -rn "computePerms" miniprogram/ || echo "✓ computePerms 已清空"
grep -rln "pages/leave" miniprogram/ 
```
Expected: 前两条都是「✓ …已清空」；第三条列出 `app.json` 与
`pages/update/index.js`。

- [ ] **Step 4: WXML 标签配平**

```bash
node C:/Users/Administrator/AppData/Local/Temp/tp-wxml-balance.js \
  miniprogram/pages/task-detail/index.wxml \
  miniprogram/pages/task-edit/index.wxml \
  miniprogram/pages/update/index.wxml \
  miniprogram/pages/report/index.wxml \
  miniprogram/pages/leave/index.wxml
```
Expected: 五行都是 `✓`，末行「5 个文件全部配平」，退出码 0。
Expected: 五行都是 `✓`，退出码 0。

> 这个脚本是上一轮界面重构时留下的。**它原先那段基于栈的「嵌套」检查已经删掉了**
> —— 它不区分自闭合标签（`<empty-state ... />`、`<input ... />`、`<task-card ... />`，
> 本仓库满页都是），于是每个文件都误报 `</block> 与 <task-card> 不匹配`。
> 一个恒报错的检查比没有检查更糟，会训练人忽略它。现在只保留计数法与
> `{{ }}` 配平两项，**已验证在现有文件上全过、在人为破坏的文件上能报错**。
>
> 它只防手误，替代不了开发者工具的真实编译 —— 两边都跑。
```

- [ ] **Step 5: 开发者工具里逐项人工验收**

1. 任务看板 → 点任意卡片 → 详情页**一个操作按钮都没有**，也没有底部空白条
2. 详情页「有 N 项未解决的卡壳」出现在任务信息卡里（找一条有卡壳的任务看）
3. 详情页时间线里，**我自己提交的**卡壳记录仍有「标记已解决」；别人提交的没有
4. 任务看板 → 人员看板 → 点成员 → 进任务详情，同样是只读的
5. 报任务 → 点我主办的任务 → 仍能上报进展；点我协办的任务 → 仍能上报进展
6. 报任务 →「新加入协办」→ 外观与改版前一致 → 仍能加入
7. 改任务 → 点我主办的任务 → 底部有红描边「删除该任务」
8. 在改任务编辑页先改一个字段（不保存）→ 点删除 → 确认文案里**提到了改动会丢失** → 取消 → 改动还在
9. 真删一条测试任务 → 确认 → 提示「已删除」→ 自动回到改任务列表且该任务消失
10. 改任务 → 底部「退出协办」→ 列表只列我协办且我非主办的任务 → 退出一条 → 该行消失 → 返回报任务页，「我参与协办」里也没有它了
11. 退出协办页在一条协办任务都没有时显示空状态，不是白屏

- [ ] **Step 6: 删掉本轮新建的临时脚本**

```bash
rm -f C:/Users/Administrator/AppData/Local/Temp/tp-leave.js \
      C:/Users/Administrator/AppData/Local/Temp/tp-edit-delete.js \
      C:/Users/Administrator/AppData/Local/Temp/tp-detail-readonly.js
```

> 这几个都在仓库外，删不删不影响仓库；删掉是为了不留会被误当真的陈旧脚本。
> `tp-wxml-balance.js` **不要删** —— 它对以后的改动仍然有用，且本轮修好了它的误报。

- [ ] **Step 7: 最终确认工作区干净**

```bash
git status --short
git log --oneline -5
```
Expected: `git status` 里除了 `?? docs/superpowers/` 之外没有其他改动
（`docs/` 是本轮 spec 与计划，已单独提交过）。

---

## 交付后的用户侧动作

**无。** 本计划不碰 `shared/`、不碰云函数、不碰数据库，所以：

- 不需要 `node scripts/sync-shared.js`
- 不需要在微信开发者工具里重新部署任何云函数
- 不需要在 CloudBase 控制台导入任何数据

（作为对照：上一轮改动动了 `shared/perm.js` 与 `shared/taskRepo.js`，
那次需要重传全部 7 个云函数。这次不需要。）

> ⚠️ 另有一件与本次无关但**仍未完成**的用户侧事项：上一轮生成的
> `scripts/tasks.collabfix.import.json`（7 条协办名单修复）还没导入，
> 需要用覆盖模式导进 `tasks` 集合，然后跑 `node scripts/make-collab-fix-import.js 王佳 --verify`。
