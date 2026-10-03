# 动作归属重排：看板只读、上报归报任务、改动归改任务

日期：2026-10-03 ｜ 分支：`ui-beautify`

## 由来

用户在试运行中的反馈，两条：

> 「我在任务看板当中看到的大家的任务，然后可以点上报进展，但实际我既不是主办，
> 可能都不是协办，按理来说没办法去报这个任务进展呀。」
>
> 「这个任务看板其实更多是一个展现的，它不应该有对任务的一些修改。包括上报进展
> 应该直接就在我们的报任务模块里头，这里不应该有这个功能。」

前半段（"我明明不是协办却能上报"）是**数据缺陷**，已单独修复：界面读
`collaborator` 姓名快照、权限读 `collaboratorIds`，两者不一致。根因是
`rebuildCollaboratorSnapshot` 会抹掉未认领的协办人姓名，已在
`shared/taskRepo.js` 的 `mergeCollaboratorSnapshot` 修掉（提交 `0866531`）。

本 spec 处理后半段：**动作放在哪个页面**。

## 目标

浏览他人任务的地方（看板、成员任务页）只负责展示，不承载对任务的修改；
「改」类动作集中到改任务，「报」类动作集中到报任务。

**成功标准**：从任务看板点进任务详情，页面上没有任何会对这个任务产生写操作的
入口。

## 现状

| 入口 | 点卡片去哪 | 那页能做什么 |
|---|---|---|
| 报任务 | `progress-add` | 上报进展 ✅ 已是目标行为 |
| 改任务 | `task-edit` | 改字段（只列我主办的任务）✅ |
| **任务看板** | `task-detail` | **上报进展 / 编辑 / 加入协办 / 退出协办 / 删除** ← 唯一的越界者 |

`task-detail` 只有两个入口：`board/index.js` 与 `person-detail/index.js` ——
**都是"浏览别人的活"的场景**，所以把它改成只读方向成立。

任务看板页自身没有任何写操作（只有筛选与折叠），**一行不用改**。

## 设计

### 1. 动作归属（最终表）

| 页面 | 能做什么 |
|---|---|
| 报任务 | 上报进展（我主办／我协办）、新加入协办、新建任务 |
| 改任务 | 我主办：改信息 + 删除；底部新增「退出协办」入口 |
| 任务看板 | 只读浏览（点卡片 → 详情） |
| 人员看板 | 只读浏览 |
| 任务详情 | 纯只读 + 时间线里每条卡壳的「标记已解决」 |
| 加入协办 | 只从 报任务 →「新加入协办」 |
| 退出协办 | 新页 `pages/leave`，从 改任务 → 底部入口进 |

**「标记已解决」留在详情页**：它不改变任务本身，只是对一条历史进展的收尾，
且天然属于"看这条记录"的上下文；挪走反而无处安放（进度上报页是提交新进展的
地方，不是回顾旧记录的）。详情页底部按钮摘掉后，它是剩下的唯一轻动作。

### 2. `task-detail`：摘掉底部操作栏

- **WXML**：整块 `footer-bar` 删除（未解决卡壳提示 + 5 个按钮 + 「你不在协作
  名单中，只能查看」提示行）。
- **「有 N 项未解决的卡壳」移入任务信息卡**。它是信息不是操作，跟着 footer 一起
  删会把这条信息弄丢。
- **空状态文案要改**：`index.wxml:96` 现在是
  `hint="{{canReport ? '点下方按钮上报第一条进展' : '主办人还未上报进展'}}"` ——
  按钮没了，「点下方按钮」就成了假话。两条分支合并成一句（如
  「主办人还未上报进展」），`canReport` 这个 data 字段随之作废。
- **JS：`computePerms` 整个删掉，不是收缩。** 复核后确认：它产出的 7 个字段
  （`isLeader` / `isParticipant` / `canEdit` / `canJoin` / `canLeave` /
  `canReport` / `canDelete`）**只有 footer 和上面那句 hint 在用**；
  而时间线唯一还活着的权限判定 `_canResolve` 走的是完全另一条路 ——
  `decorateRecords` 里逐条调 `perm.canResolveBlocker(task, r, openid)`
  （`index.js:128`），与 `computePerms` 无任何关系。所以 footer 一摘，
  `computePerms` 连同 7 个 data 字段（含 `isAdmin`）全部成为死代码，一并删除。
  删 `onReport` / `onEdit` / `onJoin` / `onLeave` / `onDelete` 五个 handler。
- 根节点去掉 `page--with-footer`，否则底部留一块空白。
- WXSS 中 `.detail__del` / `.detail__edit` / `.detail__actions` / `.detail__hint` /
  `.detail__alert` 成为死类，删除。

> 摘完之后这页的 `perm` 依赖只剩 `canResolveBlocker` 一处，
> `require('../../shared/perm')` 仍然需要。

### 3. `task-edit`：加删除

底部危险区，位于滚动内容最下面、固定底栏之上：divider + 一行说明 +
红描边按钮（不填充，与 `.btn--danger` 的实心删除区分开，避免与底栏的保存抢视觉）。

**可见性判据用 `perm.canDeleteTask(task, openid, isAdmin)`** —— 与云函数同一个
函数，不在前端另写一条规则。

判据所需的两项在 `load()` 里现成可得：`auth` 本页已经 require，
`session.openid` 也在手边，只需在 `load()` 的 `setData` 里多带一个
`isAdmin: auth.isAdmin()`（本页目前没有这个字段，要新增）。判据存在
`data.canDelete` 上，WXML 只读它。

> 实际效果：这页只有主办人进得来（改任务只列我主办的任务，云函数
> `update` 也要求 `requireLeaderOf`），所以按钮对能进来的人恒为真。
> 仍走同一函数是为了将来规则变化时两边不漂移。

删除逻辑从 `task-detail` 搬过来（连同 `api.taskApi.remove(taskId)` 与
`toast.confirm` / `toast.withLoading` 的用法），另加两点：

1. 有未保存改动（`dirtyCount > 0`）时，确认弹窗要额外提醒改动会一起丢失。
2. 删除成功后 `navigateBack` 回改任务列表（`onShow` 会重拉，该任务自然消失）。

### 4. `pages/leave`（新页）：退出协办

与 `pages/join` 完全对偶：join 页是「他人主办、你尚未参与 → 每项一个『加入协办』」，
leave 页是「你参与协办 → 每项一个『退出协办』」，复用 `join` 页的卡片写法与按钮样式。

**数据源直接用现成的 `db.myJoinedTasks(openid)`** —— 它就是
`where({ collaboratorIds: _.in([openid]) })`，本来就不按阶段过滤，
**`utils/db.js` 不需要加任何东西**。

**列表要滤掉我主办的任务**：`db.myJoinedTasks` 只按 `collaboratorIds` 查，
而一个任务可能既是我主办、又把我列进了协办（`report/index.js` 的注释已记着
这种情况）。行过滤用 `perm.canLeave(t, session.openid)` —— 它对主办人返回
`false`，与云函数 `taskService.leave` 的判据是同一个函数，不另写规则。

**不按阶段过滤，含已完成。** 理由：已完成的协办关系也想清掉，过滤掉反而留下一个
在界面上够不着的尾巴。（join 页排除已完成是因为云函数拒绝加入已完成任务；
退出没有这个限制。）

退出后就地从列表移除（按 `_id` 过滤掉该项），不整页刷新。
`leavingId` 用于按钮 loading 态，与 join 页的 `joiningId` 同款。

改任务页底部的入口卡片与报任务页的「新加入协办」同构
（`.card card--flat` + `.field__arrow`）：标题「退出协办」+ 一行说明
「浏览你参与协办的任务，可自行退出」+ 箭头。

> ⚠️ **这里推翻了设计讨论时说的「带计数（`退出协办（3 项）`）」**，请重点看一眼。
> 两条理由：报任务页那个入口本来就**没有**计数，加了计数就不是同构了；
> 而计数要求改任务页每次加载都多查一次 `db.myJoinedTasks`，
> 为一个点一下就能看到的数字付这个代价不值。
> 若仍想要计数，改动是：`update/index.js` 的 `load()` 里与 `myLedTasks` 并发多拉一个
> `myJoinedTasks`，过滤 `perm.canLeave` 后把长度放进 `stats`。

### 5. 报任务页

**不改。** 点卡片 → `progress-add` 已是目标行为；「新加入协办」入口保留，
它现在是加入协办的唯一入口。

## 不做的事

- **云函数零改动** —— `join` / `leave` / `delete` 三个 action 都已存在，
  上一轮已在真实入口（桩掉 `wx-server-sdk` 驱动 `taskService`）验证过。
- **权限规则零改动**、**数据库结构零改动**。
- **`utils/db.js` 零改动** —— `pages/leave` 要的查询就是现成的
  `myJoinedTasks(openid)`，不需要新加辅助函数。
- **`shared/` 零改动** —— 因此不需要 `sync-shared.js` 写入，**不需要重新部署
  任何云函数**。（这是本设计与上一次改动的重要区别：上一次动了 `shared/`，
  7 个云函数都得重传。）
- 不新建"我的任务详情"之类的中转页 —— `task-edit` 显示全部字段、
  `progress-add` 顶部有任务概要，两个入口都不缺上下文，没有"想看看自己的任务
  但看不到"的缺口。

## 验证

**自动化：**
- `node scripts/selfcheck.js` —— 应仍是 **184/184**（`shared/` 未动；这是本设计
  没有触碰后端逻辑的证据）
- `node scripts/sync-shared.js --check` —— 应输出「✓ 已同步，无差异」
- node 桩跑真实页面方法（仓库外临时脚本，跑完删）：
  1. `task-detail` 的 `decorateRecords` 仍能给出正确的 `_canResolve`
     （主办人看任何卡壳记录都为真、非主办人只有自己提交的为真）
  2. `task-edit` 删除按钮的显隐判据与 `perm.canDeleteTask` 一致
  3. `pages/leave` 列表只含 `collaboratorIds` 含我、且 `perm.canLeave` 为真的任务；
     退出后该项就地消失
- 死代码扫描：`computePerms`、`onReport`、`onEdit`、`onJoin`、`onLeave`、
  `onDelete`、`canReport`、`canEdit`、`canJoin`、`canLeave`、`canDelete`、
  `isAdmin`（task-detail 侧）在仓库内**零残留引用**
- WXML 标签配平 + 新引入类名的定义检查

**人肉验收：**
1. 任务看板 → 点任意卡片 → 详情页**一个操作按钮都没有**，卡壳计数仍在
2. 详情页时间线里的卡壳记录，「标记已解决」对自己提交的仍可点
3. 报任务 → 点我主办／我协办的任务 → 仍能上报进展
4. 报任务 →「新加入协办」→ 仍能加入
5. 改任务 → 点我主办的任务 → 底部有「删除该任务」，删除后回到列表且该任务消失
6. 改任务 → 底部「退出协办」→ 列表只列我协办且我非主办的任务 → 退出后该任务
   从列表消失，且从报任务页的「我参与协办」里也消失
7. 全局扫一遍：没有任何操作入口出现在错误的页面

## 改动面

**3 个现有页面 + 1 个新页 + `app.json` 一行：**

| 文件 | 改动 |
|---|---|
| `pages/task-detail/index.{wxml,js,wxss}` | 删底部栏、5 个 handler、`computePerms` 及 7 个 data 字段；卡壳计数移入信息卡；改空状态文案；去掉 `page--with-footer` |
| `pages/task-edit/index.{wxml,js,wxss}` | 危险区 + 删除逻辑 + `isAdmin` |
| `pages/update/index.{wxml,js}` | 底部入口卡片 + `onLeaveTap` |
| `pages/leave/*`（新，4 个文件） | 照 `pages/join` 写 |
| `app.json` | `pages` 数组加一行 `pages/leave/index` |

`utils/db.js`、`utils/format.js`、`utils/theme.js`、`shared/*`、
`cloudfunctions/*`、`scripts/*` **一行不改** —— 因此不需要 `sync-shared.js`
写入、不需要重新部署云函数、不需要跑任何数据脚本。

## 回滚

`git revert` 单个提交即可，无需回滚数据、无需回滚云函数。
