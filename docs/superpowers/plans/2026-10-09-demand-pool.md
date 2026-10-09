# 需求池（领需求 → 建任务）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给团队一个"事情成形之前"的落点 —— 新增需求池（新集合 + 新云函数 + 新 tab），需求可被"领走"（= 基于它建任务），任务全完成时需求自动收尾，没做就直接关闭。

**Architecture:** 新增第 9 个云函数 `demandService` 独占 `demands` 集合的写入口；需求状态的重算逻辑集中在新的 `shared/demandRepo.js`，被 4 个即时落点（建任务 / 改任务 / 报进展 / 删任务）与每日巡检共用同一份实现。权限判据是 `shared/perm.js` 的新纯函数 `canEditDemand`，前后端共用。唯一一处打破现有硬规则的地方是：`demandService` 的入口用 `requireMember()` 而非 `requireWriter()`，好让只读角色「管理者」能建、能改能关自己提的需求。

**Tech Stack:** 微信小程序原生（WXML/WXSS/CommonJS），零构建步骤，无 npm 依赖。云函数用 `wx-server-sdk`。测试靠 `scripts/selfcheck.js`（仓库内、永久）+ 仓库外临时 node 桩脚本（驱动真实 handler）。

**Spec:** `docs/superpowers/specs/2026-10-09-demand-pool-design.md`

## Global Constraints

- **零构建步骤** —— 改完必须能直接在微信开发者工具里编译运行。不引入 npm、不引入打包器、不写 ES Module 语法，一律 CommonJS `require` / `module.exports`。
- **`shared/` 有改动 ⇒ 必须跑 `node scripts/sync-shared.js`**，且**这次要重新部署用到 `lib/shared` 的每个云函数**（现有的 7 个 + 新的 `demandService` = **8 个**）。这是本计划唯一一次触碰 `shared/`。
  - ★ **`dashboardService` 不在其中。** 它的 `index.js` 只 `require('wx-server-sdk')`，完全不使用 `shared/`（有意做成自包含）。`sync-shared.js` 按目录扫，会照灌一份 `lib/shared` 进去，但没有任何 require 指向它 —— 那份副本已在 `.gitignore` 里排除，也**不需要重新部署**。
- **不发明枚举值** —— 需求状态只用 `待认领 / 已领走 / 已完成 / 已关闭` 四个；`SOURCE` 只做改名，数组长度与其余七项顺序一个都不动（顺序是 `field-picker` 高亮下标的依据）。
- **身份只来自 `cloud.getWXContext().OPENID`** —— 前端传的任何 openid 一律丢弃。`proposerId` / `claimedById` 是判据，`proposerName` / `claimedByName` 是快照，**函数里只比对 Id**。
- **权限规则（云函数侧强制校验，前端隐藏不等于安全）** —— 前端控显隐只是体验，真正的边界在云函数。禁止在前端另写一条权限规则。
- **不得因派生逻辑失败而阻断主流程** —— 需求状态重算一律走 `syncDemandQuietly`（内部 try/catch + console.error），绝不把任务保存/进展提交带崩。漏网的由每日巡检收敛。
- **不硬编码颜色** —— WXSS 里一律 `var(--xxx)`（令牌在 `miniprogram/app.wxss` 的 `page {}` 块里）。新增状态只有四个，配色复用现有 `.badge--{active|warn|done|idle}`，**不新增色值**。
- **页面 WXSS 不跨页** —— 页面自己的 `.wxss` 只对本页生效；要跨页复用的类必须放进 `app.wxss`。
- **`scripts/make-*.js` 在 require 时裸调 `main()`** —— 执行它是有意的，不是误触。派生产物（`scripts/*.import.json`）被 `.gitignore` 挡住，不要提交。
- **`git` 只提交到本地** —— 本仓库刻意不配远程（含真实同事姓名）。**不要 `git push`**。
- 分支：`ui-beautify`。
- **测试脚本写在仓库外**（`C:\Users\Administrator\AppData\Local\Temp\tp-demand-*.js`），跑完删掉。汇总行统一为 `通过 N 项，失败 M 项`。

## Review Focus

以下几类输入是 spec 的隐含要求，写代码时最容易漏，各自在所属任务里配了测试：

1. **同一个人重复点「领走」**（网络重试 / 连点两次）—— 第一次已成功建出任务，第二次必须被拒且**不能把已经建好的那条任务当成"没建成"**。这是 `clientToken` 幂等与原子占位交互处最容易出错的地方。
2. **占位成功但建任务失败**（截止日非法、协办人不存在、`add` 超时）—— 那条需求不能停在「已领走」却零任务。回滚必须尽力而为且**不吞掉原始错误**。
3. **领走时建的任务后来被删光** —— 需求回到「待认领」并**清空 `claimedBy*`**，而不是卡在"已领走但没人办"。
4. **已关闭的需求遇上任务状态变化** —— 重算必须**纹丝不动**。一个"我决定不做了"的结论不该被隔壁任务悄悄推翻。
5. **管理者（只读）点别人提的「待认领」卡片** —— 前端不跳转、给提示；即使绕过前端直接调云函数，`taskService.create` 仍返回 `FORBIDDEN_VIEWER`。门只开一半。
6. **迁移尚未完成时打开一条 `source` 仍是「业务部门提报」的老任务** —— 界面照常显示、不崩不空白（`field-picker` 不高亮但原样渲染），只有保存才报错。

---

## 文件结构

| 文件 | 职责 | 本计划中的动作 |
|---|---|---|
| `shared/constants.js` | 全站枚举 | 改：`DEMAND_STATUS` / `DEMAND_STATUS_TONE` / `COLLECTIONS.DEMANDS` / `SOURCE` 改名 |
| `shared/errors.js` | 错误码与部署期错误翻译 | 改：`ALL_COLLECTIONS` 加 `demands` |
| `shared/perm.js` | 权限纯函数（前后端共用） | 改：加 `canEditDemand` |
| `shared/demandRepo.js` | 需求领域仓储助手（**新**） | 新建 |
| `shared/validate.js` | 入参校验与字段白名单 | 改：需求字段白名单与校验 |
| `shared/taskRepo.js` | 任务领域仓储助手 | 改：`buildTaskDoc` 接受 `demandId` |
| `cloudfunctions/demandService/` | 第 9 个云函数（**新**） | 新建 |
| `cloudfunctions/taskService/index.js` | 任务服务 | 改：领走（原子占位）+ 重算挂钩 + 幂等令牌 |
| `cloudfunctions/progressService/index.js` | 进展服务 | 改：`stage` 变更后挂重算 |
| `cloudfunctions/generatePeriodicTasks/index.js` | 每日巡检 | 改：加一段需求状态重算 |
| `miniprogram/config.js` | 云函数名集中定义 | 改：加 `demand` |
| `miniprogram/utils/api.js` | 云函数调用封装 | 改：加 `demandApi` |
| `miniprogram/utils/format.js` | 展示层格式化 | 改：加 `decorateDemand` |
| `miniprogram/pages/demand-edit/*` | 需求新建 / 看改一体（**新**） | 新建 4 个文件 |
| `miniprogram/pages/demands/*` | 领需求 tab（**新**） | 新建 4 个文件 |
| `miniprogram/pages/task-create/*` | 新建任务页 | 改：来源=需求池时选需求 |
| `miniprogram/custom-tab-bar/*` | 自定义 tabBar | 改：加一项 + `sync(index)` → `sync(pagePath)` |
| `miniprogram/app.json` | 路由与 tabBar | 改：2 个页面 + 1 个页签 |
| `scripts/gen-tabbar-icons.js` | tabBar 图标生成 | 改：加「领需求」图标后重跑 |
| `scripts/selfcheck.js` | 纯逻辑自检 | 改：4 个新 section |
| `scripts/make-source-rename-import.js` | 一次性迁移脚本（**新**） | 新建 |
| 其余 4 个 tab 页 | report / update / board / people | 改：`syncTabBar(N)` → `syncTabBar()` |

**为什么 `demandService` 不写进现有的某个云函数**：与 `router.js` 文件头那条理由同源 —— 权限域隔离比省一次冷启动重要。需求池是**唯一**一个对 `ROLE.VIEWER` 开放的写域，把它塞进 `taskService` 会让"这个 action 到底走 requireWriter 还是 requireMember"变成每个 action 都要单独看的事。

**任务顺序的理由**：任何一步中断，App 都不会处于坏状态。前 7 步是纯新增（新文件 / 新函数，没有任何地方调用它们）；第 9 步建出 `demand-edit` 但还没有任何页面指向它；第 10 步让 `task-create` 支持关联需求（此时还只能手选）；第 11 步才装上 tabBar 门面 —— **没有任何一步会让界面指向一个尚不存在的页面**。

---

## Task 1: 枚举地基 —— 四个需求状态与 SOURCE 改名

**Files:**
- Modify: `shared/constants.js`
- Modify: `shared/errors.js:86-92`
- Test: `scripts/selfcheck.js`

**Interfaces:**
- Consumes: 无
- Produces: `C.DEMAND_STATUS: string[]`、`C.DEMAND_STATUS_TONE: {[status]: tone}`、`C.COLLECTIONS.DEMANDS === 'demands'`、`C.SOURCE[2] === '需求池'`

- [ ] **Step 1: 写失败的测试**

打开 `scripts/selfcheck.js`，在 `section('枚举字典完整性');`（约 460 行）那一节末尾追加：

```js
// 需求池：四个状态必须与 spec 完全一致，且每个状态都有配色 key。
// ★ 这条断言是"不发明枚举值"的机器执行者 —— 少一个 / 多一个都会红。
check('需求状态字典', C.DEMAND_STATUS, ['待认领', '已领走', '已完成', '已关闭']);
check(
  '★ 每个需求状态都有配色 key（漏一个会拿到 undefined，徽标变成无色）',
  C.DEMAND_STATUS.map((s) => C.DEMAND_STATUS_TONE[s]),
  ['active', 'warn', 'done', 'idle']
);
check('需求集合名', C.COLLECTIONS.DEMANDS, 'demands');
check('部署期错误提示的集合清单含 demands', require(path.join(__dirname, '..', 'shared', 'errors')).ALL_COLLECTIONS.indexOf('demands') !== -1, true);

// ★ SOURCE 只改名、不动顺序 —— 顺序是 field-picker 的高亮下标依据。
//   改了顺序，所有历史任务的来源会在界面上显示错位。
check('来源仍是 8 项', C.SOURCE.length, 8);
check('★ 第三项（下标 2）是「需求池」', C.SOURCE[2], '需求池');
check('旧名「业务部门提报」已不在枚举里', C.SOURCE.indexOf('业务部门提报'), -1);
check('其余七项一个没动', C.SOURCE.filter((s) => s !== '需求池'), [
  '总行通知', '监管检查', '部领导交办', '中心领导交办', '会议纪要', '考评落实', '自发创新',
]);
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node scripts/selfcheck.js`
Expected: FAIL —— 4 项左右报红（`需求状态字典` 得到 `undefined`、`第三项（下标 2）是「需求池」` 得到 `"业务部门提报"`、`旧名…` 得到 `2`、`部署期错误提示…` 得到 `false`），末尾打印 `失败 5 项` 左右且 `process.exit(1)`。

- [ ] **Step 3: 改 `shared/constants.js`**

把 `SOURCE` 数组的第三项改名（**只改这一个字符串，其余七项与顺序原样**）：

```js
/** 任务来源（8 项业务来源，不含 period——周期任务用 origin 字段标识） */
const SOURCE = [
  '总行通知',
  '监管检查',
  '需求池',      // ← 2026-10-09 由「业务部门提报」改名，见 docs/superpowers/specs/2026-10-09-demand-pool-design.md §7
  '部领导交办',
  '中心领导交办',
  '会议纪要',
  '考评落实',
  '自发创新',
];
```

在 `STAGE` 之后、「优先级」之前插入需求状态字典：

```js
/**
 * 需求状态 —— 需求自己的生命周期，与任务的 STATUS / STAGE 无关。
 * ★ 是**数组**（给 validate.assertEnum 用），不是 ROLE 那样的对象。
 *   写 DEMAND_STATUS.PENDING 会静默得到 undefined，where 条件会变成
 *   "status 等于 undefined" —— 一个不报错、也永远匹配不上的查询。
 */
const DEMAND_STATUS = ['待认领', '已领走', '已完成', '已关闭'];

/**
 * 需求状态 → 徽标配色 key（沿用 app.wxss 的 .badge--{key}）。
 * 语义：待认领＝蓝色（等着被拿走）、已领走＝黄色（有人在办，还没结论）、
 * 已完成＝绿色、已关闭＝灰色（不做也是一种了结，但不需要被庆祝）。
 */
const DEMAND_STATUS_TONE = {
  待认领: 'active',
  已领走: 'warn',
  已完成: 'done',
  已关闭: 'idle',
};
```

在 `COLLECTIONS` 里加一行：

```js
const COLLECTIONS = {
  MEMBERS: 'members',
  TASKS: 'tasks',
  PROGRESS_RECORDS: 'progress_records',
  PERIODIC_TEMPLATES: 'periodic_templates',
  JOB_LOGS: 'job_logs',
  DEMANDS: 'demands',
};
```

在文件末尾的 `module.exports` 里补上两个新名字（保持字母序附近的位置即可）：

```js
  DEMAND_STATUS,
  DEMAND_STATUS_TONE,
```

- [ ] **Step 4: 改 `shared/errors.js` 的 `ALL_COLLECTIONS`**

```js
/** 本项目的全部集合，用于在错误提示里给出可执行的清单 */
const ALL_COLLECTIONS = [
  'members',
  'tasks',
  'progress_records',
  'periodic_templates',
  'job_logs',
  'demands',
];
```

- [ ] **Step 5: 同步 shared 到两端副本**

Run: `node scripts/sync-shared.js`
Expected: 列出 `miniprogram/shared/constants.js`、`miniprogram/shared/errors.js` 以及 8 个云函数各自的 `lib/shared/constants.js`、`lib/shared/errors.js` 共 18 行 `✓`，末尾 `✓ 完成`。

- [ ] **Step 6: 跑测试，确认通过**

Run: `node scripts/selfcheck.js`
Expected: PASS —— 先前那 5 项转绿，末尾 `失败 0 项` 与 `✓ 全部通过`。**记下这次的总数**（形如 `通过 175 项，失败 0 项`），后续每一步都要"总数只增不减、失败为 0"。

Run: `node scripts/sync-shared.js --check`
Expected: `✓ 已同步，无差异`

- [ ] **Step 7: 提交**

```bash
git add shared/constants.js shared/errors.js scripts/selfcheck.js miniprogram/shared cloudfunctions/*/lib/shared
git commit -m "feat(demand): 需求状态枚举、demands 集合名、SOURCE 第三项改名为「需求池」"
```

> ⚠️ 从这一刻起，库里那 14 条 `source: '业务部门提报'` 的任务处于"能被读、一保存就被拒"的状态。**部署前必须做完 Task 12 的迁移**，顺序见 Task 13。

---

## Task 2: `perm.canEditDemand` —— 需求的三方处置权

**Files:**
- Modify: `shared/perm.js`
- Test: `scripts/selfcheck.js`

**Interfaces:**
- Consumes: 无
- Produces: `perm.canEditDemand(demand, openid, isAdmin) → boolean`

- [ ] **Step 1: 写失败的测试**

在 `scripts/selfcheck.js` 的 `section('周期计划归属 — 主办人或管理员');`（约 388 行）之后插入新的一节：

```js
// ---------------------------------------------------------------------------
section('需求处置权 — 提出人、领走人、管理员');

/** 造一条需求：只给判据字段，快照字段刻意用不相干的姓名 */
const demand = { _id: 'd1', proposerId: 'ou_zhang', claimedById: 'ou_li', status: '已领走' };

check('提出人可改', perm.canEditDemand(demand, 'ou_zhang', false), true);
check('领走人可改', perm.canEditDemand(demand, 'ou_li', false), true);
check('管理员可改他人的需求', perm.canEditDemand(demand, 'ou_wang', true), true);
check('外人不可改', perm.canEditDemand(demand, 'ou_wang', false), false);
check('★ 同名不同 openid 拿不到处置权', perm.canEditDemand(demand, 'ou_zhang2', false), false);
check('openid 为空即便管理员也不放行', perm.canEditDemand(demand, '', true), false);
check('openid 为 undefined 拒绝一切', perm.canEditDemand(demand, undefined, false), false);
check('需求为空返回 false', perm.canEditDemand(null, 'ou_zhang', true), false);

// 还没人领走的需求：只有提出人与管理员能动它
const fresh = { _id: 'd2', proposerId: 'ou_zhang', claimedById: '', status: '待认领' };
check('待认领的需求：提出人可改', perm.canEditDemand(fresh, 'ou_zhang', false), true);
check('待认领的需求：没领过的人不可改', perm.canEditDemand(fresh, 'ou_li', false), false);
check('★ claimedById 为空串时不会被误判成"空 openid 匹配空 openid"', perm.canEditDemand(fresh, '', false), false);

// 关闭 / 重开共用同一个判据 —— 能关的人本来就该能改
check('已关闭的需求：提出人仍可改（用于重开）', perm.canEditDemand({ _id: 'd3', proposerId: 'ou_zhang', claimedById: '', status: '已关闭' }, 'ou_zhang', false), true);
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node scripts/selfcheck.js`
Expected: FAIL —— `TypeError: perm.canEditDemand is not a function`，脚本崩溃退出（不是 12 条红，是整体抛错）。这仍然是"因功能缺失而失败"，符合预期。

- [ ] **Step 3: 实现**

在 `shared/perm.js` 的 `canManageTemplate` 之后（`module.exports` 之前）追加：

```js
/**
 * 是否可处置一条需求（改字段 / 关闭 / 重开）。
 *
 * 规则：**提出人、领走人、或管理员** —— 三方都是"这条需求跟我有关"的人。
 *
 * ★ 一个函数管三件事，不再拆细。用户只对"关闭权限"拍过板（提出人 + 领走人 +
 *   管理员），没说过"改"归谁。让两者共用同一条规则的理由有三条：
 *     1. 能关的人本来就该能改 —— 关之前想补一句描述，不该被拦住；
 *     2. 规则拆细就要写两个函数、测两组用例，而它们**必然会漂**
 *        （改的规则变了、关的忘了跟着变，就是"能改不能关"这种说不通的状态）；
 *     3. 这三件事共享同一个语义：「这条需求跟你有关，你可以处置它」。
 *
 * ★ 「领走人」不需要反查任务：领走那一刻就把 openid 写进了 demand.claimedById。
 *   这也是它必须存 openid、不能只存姓名的原因。
 *
 * ★ 只读角色「管理者」在这里不需要额外开洞：他作为提出人时 proposerId 已经
 *   匹配上了。他永远领不走（领走 = 建任务，那条路仍走 requireWriter）。
 *
 * ★ proposerId / claimedById 是判据，proposerName / claimedByName 是快照。
 *   本函数只比对 Id —— 与文件头第 1 条纪律（绝不比对姓名字符串）一致。
 */
function canEditDemand(demand, openid, isAdmin) {
  if (!openid || !demand) return false;
  return demand.proposerId === openid || demand.claimedById === openid || !!isAdmin;
}
```

在 `module.exports` 里加上 `canEditDemand,`。

- [ ] **Step 4: 跑测试，确认通过**

Run: `node scripts/selfcheck.js`
Expected: PASS —— 新增 12 项全绿，`失败 0 项`，总数比 Task 1 记下的多 12。

Run: `node scripts/sync-shared.js`
Expected: 19 行 `✓`（`perm.js` 也变了），末尾 `✓ 完成`。

- [ ] **Step 5: 提交**

```bash
git add shared/perm.js scripts/selfcheck.js miniprogram/shared cloudfunctions/*/lib/shared
git commit -m "feat(demand): perm.canEditDemand —— 提出人/领走人/管理员三方处置权"
```

---

## Task 3: `shared/demandRepo.js` —— 占位、回滚、状态重算

**Files:**
- Create: `shared/demandRepo.js`
- Modify: `shared/taskRepo.js:406-414`（`module.exports` 补两个名字）
- Test: `scripts/selfcheck.js`

**Interfaces:**
- Consumes: `C.COLLECTIONS.DEMANDS`、`C.QUERY_BATCH`、`validate.assertNonEmptyString`、`errors.BizError/Codes/describeInfraError`、`taskRepo.fetchAll/runBatched`
- Produces:
  - `buildDemandDoc({fields, proposerId, proposerName, db}) → object`
  - `readDemand(db, demandId) → Promise<object|null>`
  - `tasksOfDemand(db, demandId) → Promise<object[]>`
  - `listAllDemands(db) → Promise<object[]>`
  - `claimDemand(ctx, demandId, leaderId) → Promise<string>`（无 demandId 时返回 `''`）
  - `releaseDemand(ctx, demandId, leaderId) → Promise<void>`（**永不抛错**）
  - `syncDemandStatus(db, demandId, opts?) → Promise<{status, changed} | {skipped}>`，`opts.fromReopen`
  - `syncDemandQuietly(db, demandId) → Promise<object|null>`（**永不抛错**）
  - `syncAllDemands(db) → Promise<{scanned, changed}>`

- [ ] **Step 1: 写失败的测试**

在 `scripts/selfcheck.js` 末尾，把 `relinkChecks().then(() => {` 改成 `relinkChecks().then(async () => {`，并在这个回调**内**、`const mergeSnap = taskRepo.mergeCollaboratorSnapshot;` 那一节之后、最后的汇总打印之前插入：

```js
  // ── 需求仓储 ──────────────────────────────────────────────────────
  section('需求仓储 — 原子占位、回滚、状态重算');

  const demandRepo = require(path.join(__dirname, '..', 'shared', 'demandRepo'));
  await demandRepoChecks(demandRepo);
```

然后在 `relinkChecks()` 函数定义之后、`relinkChecks().then(...)` 之前插入这个辅助函数：

```js
/**
 * 内存版 db，只实现 demandRepo 用到的方法。
 *
 * ★ 断言的是「最终文档长什么样」与「stats.updated 是多少」，
 *   不是"调了几次 update"—— 后者在覆盖了不该覆盖的字段时照样能通过。
 * ★ where().update() 返回命中条数（而不是恒定 1），是这套测试的关键：
 *   claimDemand 的原子性就建立在 stats.updated === 1 这个判断上。
 *   真库靠单文档更新的原子性保证同一时刻只有一个人拿到 1，这里用内存模拟。
 */
function demandDb(seed) {
  const store = {
    demands: (seed && seed.demands) || [],
    tasks: (seed && seed.tasks) || [],
  };
  const writes = [];
  const match = (doc, where) => Object.keys(where).every((k) => doc[k] === where[k]);
  function query(name, ops) {
    const api = {
      where: (w) => query(name, Object.assign({}, ops, { where: w })),
      orderBy: () => api,
      field: () => api,
      skip: (n) => query(name, Object.assign({}, ops, { skip: n })),
      limit: (m) => query(name, Object.assign({}, ops, { limit: m })),
      get: async () => {
        let rows = store[name].slice();
        if (ops.where) rows = rows.filter((d) => match(d, ops.where));
        if (ops.skip) rows = rows.slice(ops.skip);
        if (ops.limit !== undefined) rows = rows.slice(0, ops.limit);
        return { data: rows };
      },
      update: async ({ data }) => {
        let rows = store[name];
        if (ops.where) rows = rows.filter((d) => match(d, ops.where));
        rows.forEach((d) => Object.assign(d, data));
        writes.push({ name, where: ops.where, data });
        return { stats: { updated: rows.length } };
      },
    };
    return api;
  }
  return {
    writes,
    store,
    serverDate: () => 'SERVER_DATE',
    collection(name) {
      const c = query(name, {});
      c.doc = (id) => ({
        get: async () => {
          const d = store[name].find((x) => x._id === id);
          // 与真库一致：文档不存在时抛错，由 readDemand 翻译成 null
          if (!d) throw Object.assign(new Error('document.get:fail not exist'), { errCode: -502002 });
          return { data: d };
        },
        update: async ({ data }) => {
          const d = store[name].find((x) => x._id === id);
          if (!d) return { stats: { updated: 0 } };
          Object.assign(d, data);
          writes.push({ name, id, data });
          return { stats: { updated: 1 } };
        },
        remove: async () => ({ stats: { removed: 1 } }),
      });
      c.add = async ({ data }) => {
        const _id = 'id-' + (store[name].length + 1);
        store[name].push(Object.assign({ _id }, data));
        return { _id };
      };
      return c;
    },
  };
}

async function demandRepoChecks(repo) {
  const NEW_DEMAND = () => ({
    _id: 'd1', title: '和财富部聊权益', detail: '', contactDept: '', contactName: '',
    expectDate: '', status: '待认领', proposerId: 'o-zhang', proposerName: '张三',
    claimedById: '', claimedByName: '', claimedAt: null,
    closedByName: '', closedAt: null, closeReason: '', createdAt: 'C', updatedAt: 'C',
  });
  const NEW_TASK = (id, stage) => ({ _id: id, demandId: 'd1', stage });

  // ① buildDemandDoc：新需求一律「待认领」，派生字段全部由服务端定
  const doc = repo.buildDemandDoc({
    fields: { title: '和财富部聊权益', detail: '', contactDept: '财富部', contactName: '王主任', expectDate: '2026-10-31' },
    proposerId: 'o-zhang', proposerName: '张三', db: { serverDate: () => 'SERVER_DATE' },
  });
  check('新建需求的状态固定为待认领', doc.status, '待认领');
  check('提出人 openid 由服务端写入', doc.proposerId, 'o-zhang');
  check('领走人字段初始为空', [doc.claimedById, doc.claimedByName, doc.claimedAt], ['', '', null]);
  check('关闭痕迹字段初始为空', [doc.closedByName, doc.closedAt, doc.closeReason], ['', null, '']);
  check('★ 前端字段之外的东西进不来', Object.keys(doc).sort(), [
    'claimedAt', 'claimedById', 'claimedByName', 'closeReason', 'closedAt', 'closedByName',
    'contactDept', 'contactName', 'createdAt', 'detail', 'expectDate', 'proposerId',
    'proposerName', 'status', 'title', 'updatedAt',
  ].sort());

  // ② claimDemand：条件里必须带 status，且以 stats.updated 为准
  const d1 = demandDb({ demands: [NEW_DEMAND()], tasks: [] });
  const ctxOf = (db, openid, members) => ({
    db, openid,
    resolveMembers: async (ids) => (members || []).filter((m) => ids.indexOf(m.openid) !== -1),
  });
  const ctx = ctxOf(d1, 'o-li', [{ openid: 'o-li', name: '李四', role: '普通' }]);

  check('无 demandId 时原样返回空串（不查库）', await repo.claimDemand(ctx, '', 'o-li'), '');
  check('领走后返回 demandId', await repo.claimDemand(ctx, 'd1', 'o-li'), 'd1');
  check('需求转为已领走', d1.store.demands[0].status, '已领走');
  check('★ 领走人存的是 openid（判据）', d1.store.demands[0].claimedById, 'o-li');
  check('领走人姓名是快照', d1.store.demands[0].claimedByName, '李四');
  check('领走时间被写上', d1.store.demands[0].claimedAt, 'SERVER_DATE');

  // ③ 第二次领走必须失败 —— 这就是并发场景下"只有一个人拿到 updated===1"
  let secondErr = null;
  try {
    await repo.claimDemand(ctxOf(d1, 'o-wang', [{ openid: 'o-wang', name: '王五', role: '普通' }]), 'd1', 'o-wang');
  } catch (e) { secondErr = e; }
  check('★ 已被领走的需求不能再被领走', secondErr && secondErr.code, 'INVALID_PARAM');
  check('★ 领走人没有被第二个人改写', d1.store.demands[0].claimedById, 'o-li');

  // ④ 领走不存在的需求：报的是"不存在"，不是"已被领走"
  let missingErr = null;
  try {
    await repo.claimDemand(ctxOf(demandDb({ demands: [] }), 'o-li', [{ openid: 'o-li', name: '李四', role: '普通' }]), 'd-nope', 'o-li');
  } catch (e) { missingErr = e; }
  check('★ 需求不存在说"不存在"，不笼统说"已被领走"', missingErr && missingErr.message.indexOf('不存在') !== -1, true);

  // ⑤ releaseDemand：只回滚自己占的那一条，且永不抛错
  const d2 = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: '已领走', claimedById: 'o-li', claimedByName: '李四' })], tasks: [] });
  await repo.releaseDemand(ctxOf(d2, 'o-li', []), 'd1', 'o-wang'); // 不是自己占的
  check('★ 不是自己占的，回滚不动它', d2.store.demands[0].status, '已领走');
  await repo.releaseDemand(ctxOf(d2, 'o-li', []), 'd1', 'o-li');
  check('自己占的回滚成待认领', d2.store.demands[0].status, '待认领');
  check('回滚时清空领走人', [d2.store.demands[0].claimedById, d2.store.demands[0].claimedByName], ['', '']);
  let releaseErr = null;
  try {
    const broken = demandDb({ demands: [NEW_DEMAND()], tasks: [] });
    broken.collection = () => { throw new Error('数据库炸了'); };
    await repo.releaseDemand(broken, 'd1', 'o-li');
  } catch (e) { releaseErr = e; }
  check('★ 回滚失败不抛错（不能盖掉原始错误）', releaseErr, null);

  // ⑥ syncDemandStatus 的四种输入
  const cases = [
    ['全部任务已完成 → 已完成', [NEW_TASK('t1', '已完成'), NEW_TASK('t2', '已完成')], '已领走', '已完成'],
    ['部分未完成 → 已领走', [NEW_TASK('t1', '已完成'), NEW_TASK('t2', '进行中')], '已完成', '已领走'],
    ['零任务 → 待认领', [], '已领走', '待认领'],
    ['★ 已关闭 → 原样不动', [NEW_TASK('t1', '已完成')], '已关闭', '已关闭'],
  ];
  for (const [label, tasks, from, want] of cases) {
    const db = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: from, claimedById: 'o-li', claimedByName: '李四' })], tasks });
    const r = await repo.syncDemandStatus(db, 'd1');
    check(label, [r.status, db.store.demands[0].status], [want, want]);
  }

  // ⑦ 零任务时还要清空领走人 —— 否则需求卡在"已领走但没人办"
  const dz = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: '已领走', claimedById: 'o-li', claimedByName: '李四' })], tasks: [] });
  await repo.syncDemandStatus(dz, 'd1');
  check('★ 任务被删光后清空领走人', [dz.store.demands[0].claimedById, dz.store.demands[0].claimedByName], ['', '']);

  // ⑧ 状态没变时不写库（每日巡检几百条，全写一遍是白费）
  const dsame = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: '已领走' })], tasks: [NEW_TASK('t1', '进行中')] });
  const same = await repo.syncDemandStatus(dsame, 'd1');
  check('状态没变时 changed=false', same.changed, false);
  check('★ 状态没变时一次 update 都不发', dsame.writes.length, 0);

  // ⑨ 重开：已关闭的需求要能被重算（其余情况下已关闭是纹丝不动的）
  const dre = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: '已关闭', closeReason: '不做了' })], tasks: [] });
  const re = await repo.syncDemandStatus(dre, 'd1', { fromReopen: true });
  check('★ 重开：零任务 → 回到待认领', [re.status, dre.store.demands[0].status], ['待认领', '待认领']);
  check('★ 重开：清掉关闭痕迹', [dre.store.demands[0].closeReason, dre.store.demands[0].closedAt], ['', null]);
  const dre2 = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: '已关闭', closeReason: '不做了', claimedById: 'o-li', claimedByName: '李四' })], tasks: [NEW_TASK('t1', '进行中')] });
  const re2 = await repo.syncDemandStatus(dre2, 'd1', { fromReopen: true });
  check('★ 重开：有未完成的任务 → 回已领走（不把领走事实抹掉）', re2.status, '已领走');
  check('★ 重开：不清空领走人', dre2.store.demands[0].claimedById, 'o-li');

  // ⑩ 不存在的需求：skipped，不抛错
  const dgone = demandDb({ demands: [], tasks: [] });
  check('需求不存在时返回 skipped', await repo.syncDemandStatus(dgone, 'd-x'), { skipped: 'missing' });

  // ⑪ 巡检：一次扫全量，已关闭的跳过，只报变化的条数
  const dall = demandDb({
    demands: [
      Object.assign(NEW_DEMAND(), { _id: 'a', status: '已领走' }),
      Object.assign(NEW_DEMAND(), { _id: 'b', status: '已关闭' }),
      Object.assign(NEW_DEMAND(), { _id: 'c', status: '待认领' }),
    ],
    tasks: [NEW_TASK('t1', '已完成')],
  });
  const all = await repo.syncAllDemands(dall);
  check('巡检扫描全部需求', all.scanned, 3);
  check('只有状态真的变了的才计数（a 无任务→待认领；c 有任务→已领走）', all.changed, 1);
  check('★ 已关闭的那条不受巡检影响', dall.store.demands[1].status, '已关闭');
}
```

> 注：⑪ 里 `NEW_TASK` 的 `demandId` 固定是 `'d1'`，而 `a`/`c` 的 `_id` 是 `a`/`c` —— 所以任务只挂在 `d1` 上，`a`/`c` 都是零任务 → 两条都会从原状态变化（`a` 已领走→待认领、`c` 待认领→待认领不变）。**期望 `changed === 1`**（只有 `a` 变了）。若实测不是 1，先核对 `tasksOfDemand` 的 where 条件是不是写成了 `demandId` 之外的东西。

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node scripts/selfcheck.js`
Expected: FAIL —— `Cannot find module '.../shared/demandRepo'`，脚本崩溃退出。

- [ ] **Step 3: 把两个通用分页助手导出（`shared/taskRepo.js`）**

`fetchAll`（:302）与 `runBatched`（:316）已经存在，但**没有导出**（`module.exports` 只有 8 个名字）。它们其实是与任务无关的通用 db 助手，只是当初顺手写在了这里。需求巡检要用同一个实现 —— 复制一份会让「云函数端单次上限 100，不循环会被静默截断」这条纪律散成两处，迟早有一处被漏掉。

在 `module.exports` 里加两行：

```js
module.exports = {
  recomputeTaskBlockers,
  applyStageSideEffects,
  buildTaskDoc,
  buildProgressDoc,
  mergeCollaboratorSnapshot,
  splitNames,
  relinkMemberData,
  // 通用 db 助手（与任务领域无关，需求池的巡检复用）
  fetchAll,
  runBatched,
};
```

同时在 `fetchAll` 的 JSDoc 上补一句「导出的：demandRepo 的每日巡检与 readDemand 外的全量读共用」——不必展开。

- [ ] **Step 4: 实现 `shared/demandRepo.js`**

```js
/**
 * shared/demandRepo.js
 * ---------------------------------------------------------------------------
 * 需求领域仓储助手（云函数侧）。与 taskRepo.js 同款定位：
 * 「需求领域里容易写错的事集中在一处」，四个即时落点 + 每日巡检共用同一份实现。
 *
 * 本文件负责四件容易写错的事：
 *   1. 需求文档的完整构造（提出人是服务端快照，禁止前端传入）
 *   2. 原子领走（靠 where 带上状态条件，不靠先查后写）
 *   3. 领走失败时的尽力回滚
 *   4. 由关联任务重算需求状态
 *
 * ★ 状态值在本文件里一律写中文字面量，不写 DEMAND_STATUS.xxx ——
 *   DEMAND_STATUS 是**数组**（给 assertEnum 用的），不是 ROLE 那样的对象，
 *   写 .PENDING 会静默得到 undefined，where 条件就变成"status 等于 undefined"：
 *   一个不报错、也永远匹配不上的查询。
 *
 * ⚠ 本文件不 require wx-server-sdk（db 与 ctx 由调用方传入），因此会被
 *   sync-shared.js 一并同步到小程序端 —— 与 taskRepo.js 同样的情况，无害。
 * ---------------------------------------------------------------------------
 */

const { COLLECTIONS, QUERY_BATCH } = require('./constants');
const { BizError, Codes, describeInfraError } = require('./errors');
const validate = require('./validate');
const { fetchAll, runBatched } = require('./taskRepo');

const DEMANDS = COLLECTIONS.DEMANDS;
const TASKS = COLLECTIONS.TASKS;

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/**
 * 读一条需求。不存在返回 null（不抛错）—— 与 templateService.get 同一个理由：
 * 手上的 id 是几秒前从列表点进来的，那一条刚被别人删掉是正常竞态，
 * 不该和"加载失败"混成同一句话。
 *
 * ★ 但不能一律吞掉异常：集合不存在、权限被拒也会走到 catch，
 *   若一并转成 null，部署问题就被伪装成了"需求已被删除"，排查方向会完全跑偏。
 *   这与 ctx.getTaskOrThrow 是同一个判断。
 */
async function readDemand(db, demandId) {
  if (!demandId) return null;
  try {
    const r = await db.collection(DEMANDS).doc(String(demandId)).get();
    return (r && r.data) || null;
  } catch (e) {
    const infra = describeInfraError(e);
    if (infra) throw infra;
    return null;
  }
}

/**
 * 一条需求下的全部任务。分页取全量 —— 云函数端单次上限 100，
 * 不循环会被静默截断（而截断会让"全部完成"这个判据误判成"部分完成"）。
 */
async function tasksOfDemand(db, demandId) {
  const out = [];
  for (let skip = 0; ; skip += QUERY_BATCH) {
    const r = await db
      .collection(TASKS)
      .where({ demandId })
      .skip(skip)
      .limit(QUERY_BATCH)
      .get();
    const batch = r.data || [];
    out.push(...batch);
    if (batch.length < QUERY_BATCH) return out;
  }
}

/**
 * 全部需求，按创建时间倒序。
 * ★ 带 orderBy 是必需的：不带排序的 skip 分页在数据变动时可能漏条或重复。
 * ★ 10 人规模下几十条，一次拉完在前端分组，与任务看板"一次拉全量再归并"同一套路。
 */
async function listAllDemands(db) {
  const out = [];
  for (let skip = 0; ; skip += QUERY_BATCH) {
    const r = await db
      .collection(DEMANDS)
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(QUERY_BATCH)
      .get();
    const batch = r.data || [];
    out.push(...batch);
    if (batch.length < QUERY_BATCH) return out;
  }
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/**
 * 构造新建需求的完整文档。
 *
 * ★ 提出人由调用方（服务端）从 ctx.openid + me.name 传入，本函数不接受前端姓名。
 * ★ status 写死「待认领」：新建的需求一定在池子里等人领，没有第二种入口。
 */
function buildDemandDoc(opts) {
  const { fields, proposerId, proposerName, db } = opts;
  return {
    title: fields.title,
    detail: fields.detail || '',
    contactDept: fields.contactDept || '',
    contactName: fields.contactName || '',
    expectDate: fields.expectDate || '',

    status: '待认领',

    // ★ 判据 / 快照分开存，函数里只比对 Id
    proposerId,
    proposerName,

    claimedById: '',
    claimedByName: '',
    claimedAt: null,

    closedByName: '',
    closedAt: null,
    closeReason: '',

    createdAt: db.serverDate(),
    updatedAt: db.serverDate(),
  };
}

// ---------------------------------------------------------------------------
// 占位 / 回滚
// ---------------------------------------------------------------------------

/**
 * 原子占走一条需求。返回 demandId（无 demandId 时返回 ''）。
 *
 * ★ 为什么用 where().update() 而不是 doc().get() 之后 doc().update()
 *   两个人同时点「领走」时，先查后写会双双查到「待认领」，然后双双写成功 ——
 *   一条需求被领两次。where 里带上 status: '待认领' 这个条件，
 *   数据库的更新是原子的，只有一个人能拿到 stats.updated === 1。
 *   这与 shared/idempotency.js 说的"不靠先查后写"是同一条纪律。
 *
 * @param {object} ctx      执行上下文（要 db 与 resolveMembers）
 * @param {string} demandId 可空 —— 不从需求池来的任务完全正常，此时直接放行
 * @param {string} leaderId 领走人 = 新建任务的主办人
 */
async function claimDemand(ctx, demandId, leaderId) {
  if (!demandId) return '';
  const id = validate.assertNonEmptyString(demandId, '需求');

  const leader = (await ctx.resolveMembers([leaderId]))[0];
  if (!leader) throw new BizError(Codes.MEMBER_NOT_FOUND, '指定的主办人不存在');

  const r = await ctx.db
    .collection(DEMANDS)
    .where({ _id: id, status: '待认领' })
    .update({
      data: {
        status: '已领走',
        claimedById: leaderId,        // ★ 判据，必须是 openid
        claimedByName: leader.name,   // 快照
        claimedAt: ctx.db.serverDate(),
        updatedAt: ctx.db.serverDate(),
      },
    });

  if (!r.stats || r.stats.updated !== 1) {
    // 失败原因分三种，别都笼统说"操作失败"：不存在 / 已被领走 / 已关闭。
    // 这一次回读只在失败路径上发生，不影响上面那条 where 的原子性。
    const cur = await readDemand(ctx.db, id);
    if (!cur) throw new BizError(Codes.INVALID_PARAM, '这条需求不存在或已被删除');
    if (cur.status === '已关闭') throw new BizError(Codes.INVALID_PARAM, '这条需求已关闭，先重新打开再领');
    throw new BizError(Codes.INVALID_PARAM, '这条需求已被领走，刷新后再看看别的');
  }
  return id;
}

/**
 * 领走的逆操作 —— 占位成功但建任务失败时把需求退回池子。
 *
 * ★ 为什么回滚不是可有可无的：不回滚的话，那条需求就停在「已领走」却一条任务
 *   都没有 —— 池子里少了一条，谁也不知道它去哪了。
 * ★ 条件里带上 claimedById：只回滚**自己**占的那条，不误伤别人刚领走的。
 * ★ 本函数**永不抛错**：它在 catch 块里被调用，抛错会盖掉真正要报给用户的
 *   原始错误。回滚失败只进日志，漏网的由每日巡检收敛（见 syncAllDemands）。
 */
async function releaseDemand(ctx, demandId, leaderId) {
  if (!demandId) return;
  try {
    await ctx.db
      .collection(DEMANDS)
      .where({ _id: String(demandId), status: '已领走', claimedById: leaderId })
      .update({
        data: {
          status: '待认领',
          claimedById: '',
          claimedByName: '',
          claimedAt: null,
          updatedAt: ctx.db.serverDate(),
        },
      });
  } catch (e) {
    console.error('[demandRepo] 回滚需求占位失败', demandId, e);
  }
}

// ---------------------------------------------------------------------------
// 状态重算
// ---------------------------------------------------------------------------

/**
 * 由关联任务重算需求状态。**全部状态变化的唯一出口**。
 *
 * 规则（spec §2 的状态表）：
 *   零关联任务        → 待认领，并清空 claimedBy*
 *   全部任务已完成    → 已完成
 *   有任务但未全完成  → 已领走
 *   已关闭            → 不动（除非 opts.fromReopen）
 *
 * ★ 「已关闭不被任何自动规则改动」是刻意的：一个"我决定不做了"的结论，
 *   不该被隔壁任务的状态变化悄悄推翻。重开是唯一能把已关闭拉回来的动作。
 *
 * ★ 不用"任一完成"（那会在第一个任务做完时就误判），也不用进度百分比
 *   （需求没有进度，它是"要不要做"的判断，不是"做了多少"）。
 *
 * @param {object}  db
 * @param {string}  demandId
 * @param {object}  [opts]
 * @param {boolean} [opts.fromReopen] 重开那一刻调用 —— 绕过"已关闭不动"的短路，
 *                                    并在同一次 update 里把关闭痕迹清掉
 * @returns {Promise<{status:string, changed:boolean}|{skipped:string}>}
 */
async function syncDemandStatus(db, demandId, opts = {}) {
  const demand = await readDemand(db, demandId);
  if (!demand) return { skipped: 'missing' };
  return applyStatus(db, demand, opts);
}

/** syncDemandStatus 的内核 —— 已经拿到需求文档时直接用它，省一次回读 */
async function applyStatus(db, demand, opts) {
  if (demand.status === '已关闭' && !opts.fromReopen) {
    return { status: '已关闭', changed: false };
  }

  const tasks = await tasksOfDemand(db, demand._id);
  const total = tasks.length;
  const allDone = total > 0 && tasks.every((t) => t.stage === '已完成');

  let next;
  if (total === 0) next = '待认领';
  else if (allDone) next = '已完成';
  else next = '已领走';

  const data = { status: next, updatedAt: db.serverDate() };

  // 任务被删光 → 需求回到池子里，让下一个人领，而不是卡在"已领走但没人办"
  if (next === '待认领') {
    data.claimedById = '';
    data.claimedByName = '';
    data.claimedAt = null;
  }
  // 重开：清掉关闭痕迹（在同一次 update 里，不留下中间态）
  if (opts.fromReopen) {
    data.closedByName = '';
    data.closedAt = null;
    data.closeReason = '';
  }

  const changed = demand.status !== next || !!opts.fromReopen;
  if (!changed) return { status: next, changed: false };

  await db.collection(DEMANDS).doc(String(demand._id)).update({ data });
  return { status: next, changed: true };
}

/**
 * 重算，但**绝不抛错**。任务保存 / 进展提交 / 删除任务都调它。
 *
 * ★ 失败隔离是硬要求：需求状态晚一步同步是小事，
 *   用户辛苦填的进展提交不上去是大事。漏掉的由每日巡检收敛。
 */
async function syncDemandQuietly(db, demandId) {
  if (!demandId) return null;
  try {
    return await syncDemandStatus(db, demandId);
  } catch (e) {
    console.error('[demandRepo] 需求状态重算失败', demandId, e);
    return null;
  }
}

/**
 * 每日巡检：把所有未关闭需求的状态收敛到真实状态。
 * 与 generatePeriodicTasks 同定位 —— "每天扫一遍库、把派生状态收敛到真实状态"。
 *
 * ★ 已关闭的直接过滤掉（它们本来就不该被自动改），也不为它们多查一次任务。
 * ★ 并发限 10：云开发对单函数的并发请求数有上限，无脑 Promise.all
 *   在需求多起来时容易被限流。
 */
async function syncAllDemands(db) {
  const demands = await fetchAll(db, DEMANDS);
  const open = demands.filter((d) => d.status !== '已关闭');
  let changed = 0;
  await runBatched(open, 10, async (d) => {
    const r = await applyStatus(db, d, {});
    if (r.changed) changed += 1;
  });
  return { scanned: demands.length, changed };
}

module.exports = {
  buildDemandDoc,
  readDemand,
  tasksOfDemand,
  listAllDemands,
  claimDemand,
  releaseDemand,
  syncDemandStatus,
  syncDemandQuietly,
  syncAllDemands,
};
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `node scripts/selfcheck.js`
Expected: PASS —— 新增的 `需求仓储 — 原子占位、回滚、状态重算` 一节全绿，`失败 0 项`。

若 ⑪ 那条 `changed` 不是 1：先确认 `tasksOfDemand` 的 where 是不是原样用了 `{ demandId }`（写错成 `{ _id: demandId }` 就一条都查不到，三条需求全被推回「待认领」，`changed` 会是 2）。

Run: `node scripts/sync-shared.js`
Expected: 末尾 `✓ 完成`，其中含 9 份 `demandRepo.js`（小程序端 + 8 个云函数）。新云函数的目录还没建，所以此刻是 9 份（1 + 8）。

- [ ] **Step 6: 提交**

```bash
git add shared/demandRepo.js shared/taskRepo.js scripts/selfcheck.js miniprogram/shared cloudfunctions/*/lib/shared
git commit -m "feat(demand): demandRepo —— 原子领走、尽力回滚、状态重算与每日巡检"
```

---

## Task 4: `validate` 的需求字段白名单

**Files:**
- Modify: `shared/validate.js`
- Test: `scripts/selfcheck.js`

**Interfaces:**
- Consumes: `validate.pick/assertNonEmptyString/assertDateOrEmpty`（已存在）
- Produces: `validate.DEMAND_CREATE_FIELDS`、`validate.DEMAND_UPDATE_FIELDS`、`validate.validateDemandFields(input, {isCreate})`、`validate.assertDemandRequiredForCreate(fields)`

- [ ] **Step 1: 写失败的测试**

在 `scripts/selfcheck.js` 的 `section('参数校验');`（约 435 行）那一节**之后**插入：

```js
// ---------------------------------------------------------------------------
section('需求字段白名单 — 派生字段必须挡在门外');

check('需求创建白名单', validate.DEMAND_CREATE_FIELDS, ['title', 'detail', 'contactDept', 'contactName', 'expectDate']);
check('需求更新白名单与创建一致', validate.DEMAND_UPDATE_FIELDS, validate.DEMAND_CREATE_FIELDS);

const dv = validate.validateDemandFields(
  {
    title: '  和财富部聊权益  ',
    detail: 'D',
    contactDept: '财富部',
    contactName: '王主任',
    expectDate: '2026-10-31',
    // 下面这些全是服务端派生字段，必须被静默丢弃
    status: '已完成',
    proposerId: 'o-hacker',
    proposerName: '我不是张三',
    claimedById: 'o-hacker',
    closeReason: '我说了算',
    createdAt: 0,
  },
  { isCreate: true }
);
check('标题去空白', dv.title, '和财富部聊权益');
check('★ 服务端派生字段一个都进不来', Object.keys(dv).sort(), ['contactDept', 'contactName', 'detail', 'expectDate', 'title']);

checkThrows('标题不能为空', () => validate.validateDemandFields({ title: '   ' }, { isCreate: true }), Codes.INVALID_PARAM);
checkThrows('标题超长被拒', () => validate.validateDemandFields({ title: 'x'.repeat(101) }, { isCreate: true }), Codes.INVALID_PARAM);
checkThrows('期望时间格式必须补零', () => validate.validateDemandFields({ title: 'T', expectDate: '2026-9-5' }, { isCreate: true }), Codes.INVALID_PARAM);
check(
  '期望时间可以为空（选填）',
  validate.validateDemandFields({ title: 'T', expectDate: '' }, { isCreate: true }).expectDate,
  ''
);
check(
  '超长描述被截断而不是报错（与任务的 detail 同款）',
  validate.validateDemandFields({ title: 'T', detail: 'x'.repeat(2500) }, { isCreate: true }).detail.length,
  2000
);

checkThrows('创建时标题必填', () => validate.assertDemandRequiredForCreate({}), Codes.INVALID_PARAM);
check('标题在时放行', validate.assertDemandRequiredForCreate({ title: 'T' }).title, 'T');

// ★ 更新时只发改动过的字段：没传的字段不能出现在结果里（否则会把它们清空）
check(
  '★ 更新时没传的字段不出现（避免误清空）',
  Object.keys(validate.validateDemandFields({ detail: '只改这个' }, { isCreate: false })),
  ['detail']
);
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node scripts/selfcheck.js`
Expected: FAIL —— `validate.DEMAND_CREATE_FIELDS` 得到 `undefined`，若干项报红，末尾 `失败 N 项`。

- [ ] **Step 3: 实现**

在 `shared/validate.js` 的 `PROGRESS_LEADER_EXTRA_FIELDS` 之后追加：

```js
/**
 * 需求创建时允许前端提交的字段。
 * ★ 不含 status / proposerId / proposerName / claimedBy* / closedBy* ——
 *   它们是服务端派生字段，只能由云函数按 openid 与成员档案写入。
 *   提出人与领走人若能被前端指定，权限判据（perm.canEditDemand）就形同虚设。
 */
const DEMAND_CREATE_FIELDS = ['title', 'detail', 'contactDept', 'contactName', 'expectDate'];

/** 需求可修改的字段 —— 与创建完全一致，需求没有"推进中才会变"的字段 */
const DEMAND_UPDATE_FIELDS = DEMAND_CREATE_FIELDS;
```

在 `assertTaskRequiredForCreate` 之后追加：

```js
/**
 * 校验需求创建/更新的业务字段。返回规范化后的对象。
 * 只做「字段级」校验，不涉及权限（权限在云函数里走 perm.canEditDemand）。
 */
function validateDemandFields(input, { isCreate }) {
  const allowed = isCreate ? DEMAND_CREATE_FIELDS : DEMAND_UPDATE_FIELDS;
  const raw = pick(input, allowed);
  const out = {};

  if ('title' in raw) out.title = assertNonEmptyString(raw.title, '需求标题', 100);
  if ('expectDate' in raw) out.expectDate = assertDateOrEmpty(raw.expectDate, '期望时间');

  // 自由文本字段，限制长度防止超长内容撑爆文档
  if ('detail' in raw) out.detail = String(raw.detail || '').slice(0, 2000);
  if ('contactDept' in raw) out.contactDept = String(raw.contactDept || '').slice(0, 50);
  if ('contactName' in raw) out.contactName = String(raw.contactName || '').slice(0, 50);

  return out;
}

/** 创建需求的必填项校验（在 validateDemandFields 之后调用） */
function assertDemandRequiredForCreate(fields) {
  if (!fields.title) throw new BizError(Codes.INVALID_PARAM, '需求标题不能为空');
  return fields;
}
```

在 `module.exports` 里补上：

```js
  DEMAND_CREATE_FIELDS,
  DEMAND_UPDATE_FIELDS,
  validateDemandFields,
  assertDemandRequiredForCreate,
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node scripts/selfcheck.js`
Expected: PASS，`失败 0 项`。

Run: `node scripts/sync-shared.js`
Expected: `✓ 完成`

- [ ] **Step 5: 提交**

```bash
git add shared/validate.js scripts/selfcheck.js miniprogram/shared cloudfunctions/*/lib/shared
git commit -m "feat(demand): 需求字段白名单与校验（派生字段一律挡在门外）"
```

---

## Task 5: 第 9 个云函数 `demandService`

**Files:**
- Create: `cloudfunctions/demandService/index.js`
- Create: `cloudfunctions/demandService/package.json`
- Test: `C:\Users\Administrator\AppData\Local\Temp\tp-demand-svc.js`（仓库外，跑完删）

**Interfaces:**
- Consumes: `demandRepo`（Task 3）、`validate`（Task 4）、`perm.canEditDemand`（Task 2）
- Produces: 云函数 `demandService` 的 6 个 action
  - `list` → `{ list: Demand[] }`
  - `get({demandId})` → `{ demand: Demand|null, tasks: Task[] }`
  - `create({demand})` → `{ _id, demand }`
  - `update({demandId, patch})` → `{ demandId, patch }`
  - `close({demandId, closeReason})` → `{ demandId, status }`
  - `reopen({demandId})` → `{ demandId, status }`

> **Ruling（与 spec 一处字面冲突，按 spec 的 action 表执行）**
> spec §四 的散文里写「需求列表页直接 `db.fetchFrom('demands', ...)`」，
> 但同一节的 action 表同时定义了 `demandService.list`。两者只能选一个，
> **这里选 `list`**，理由：
>   1. 两条读路径迟早会漂（一条加了权限过滤、另一条忘了加，就是"同一个列表，
>      有人看得到全部、有人看得到一半"）；
>   2. 前端读库要绕开 `requireMember`，等于把"必须已认领"这条门禁在需求池上拆了；
>   3. `fetchFrom` 那条路还要在 `utils/db.js` 里加一套集合映射，
>      而 `list` 走的是现成的 `call(fn, action)` 通路，零新增。
> **代价**：多一次云函数冷启动（约 100–300ms），10 人规模下无所谓。
> 若这个判断错了，改回前端直读只需要动 `pages/demands` 的 `refresh` 一处。

- [ ] **Step 1: 写失败的测试**

先跑一次同步，保证 `lib/shared` 有副本（云函数依赖它们）：

Run: `node scripts/sync-shared.js`

然后写 `C:\Users\Administrator\AppData\Local\Temp\tp-demand-svc.js`：

```js
/**
 * tp-demand-svc.js —— 用假 wx-server-sdk 驱动**真实的** demandService handler。
 *
 * ★ 为什么值得写：权限与状态机的真身在云函数里，界面点不出"管理者能不能建需求"、
 *   也点不出"两个人同时领走会怎样"。这个桩是这几条的唯一防线。
 */
'use strict';
const path = require('path');
const Module = require('module');

const ROOT = 'G:/TeamPulse';

// ── 内存库 ────────────────────────────────────────────────────────────
const store = { members: [], demands: [], tasks: [], progress_records: [], job_logs: [] };
let seq = 0;
let CURRENT_OPENID = '';
const match = (doc, where) => Object.keys(where).every((k) => doc[k] === where[k]);

function query(name, ops) {
  const api = {
    where: (w) => query(name, Object.assign({}, ops, { where: w })),
    orderBy: () => api,
    field: () => api,
    skip: (n) => query(name, Object.assign({}, ops, { skip: n })),
    limit: (m) => query(name, Object.assign({}, ops, { limit: m })),
    get: async () => {
      let rows = store[name].slice();
      if (ops.where) rows = rows.filter((d) => match(d, ops.where));
      if (ops.skip) rows = rows.slice(ops.skip);
      if (ops.limit !== undefined) rows = rows.slice(0, ops.limit);
      return { data: rows };
    },
    count: async () => {
      let rows = store[name].slice();
      if (ops.where) rows = rows.filter((d) => match(d, ops.where));
      return { total: rows.length };
    },
    update: async ({ data }) => {
      let rows = store[name];
      if (ops.where) rows = rows.filter((d) => match(d, ops.where));
      rows.forEach((d) => Object.assign(d, data));
      return { stats: { updated: rows.length } };
    },
  };
  return api;
}

const db = {
  command: {
    in: (v) => v,
    addToSet: (v) => v,
    pull: (v) => v,
  },
  serverDate: () => 'SERVER_DATE',
  collection(name) {
    if (!store[name]) store[name] = [];
    const c = query(name, {});
    c.doc = (id) => ({
      get: async () => {
        const d = store[name].find((x) => x._id === id);
        if (!d) throw Object.assign(new Error('document.get:fail not exist'), { errCode: -502002 });
        return { data: d };
      },
      update: async ({ data }) => {
        const d = store[name].find((x) => x._id === id);
        if (!d) return { stats: { updated: 0 } };
        Object.assign(d, data);
        return { stats: { updated: 1 } };
      },
      remove: async () => ({ stats: { removed: 1 } }),
    });
    c.add = async ({ data }) => {
      const _id = 'id-' + (++seq);
      store[name].push(Object.assign({ _id }, data));
      return { _id };
    };
    return c;
  },
};

const fakeSdk = {
  init: () => {},
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  getWXContext: () => ({ OPENID: CURRENT_OPENID }),
  database: () => db,
};

// ★ require 之前先挂上钩子：云函数的 ctx.js 顶层就 require('wx-server-sdk')
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeSdk;
  return origLoad.apply(this, arguments);
};

const demandService = require(path.join(ROOT, 'cloudfunctions/demandService/index.js'));

// ── 断言 ──────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}
const call = (openid, action, payload) =>
  (CURRENT_OPENID = openid, demandService.main({ action, payload: payload || {}, clientToken: '' }));

function seed() {
  store.members.length = 0;
  store.demands.length = 0;
  store.tasks.length = 0;
  seq = 0;
  store.members.push(
    { _id: 'm1', openid: 'o-zhang', name: '张三', role: '普通' },
    { _id: 'm2', openid: 'o-li', name: '李四', role: '普通' },
    { _id: 'm3', openid: 'o-view', name: '管理者甲', role: '管理者' },
    { _id: 'm4', openid: 'o-admin', name: '管理员乙', role: '管理员' }
  );
}

(async () => {
  // ① 普通成员建需求
  seed();
  let r = await call('o-zhang', 'create', { demand: { title: '和财富部聊机场贵宾权益', contactDept: '财富部' } });
  check('普通成员可建需求', r.ok, true);
  const d1 = r.data._id;
  check('新建的需求落在「待认领」', r.data.demand.status, '待认领');
  check('提出人是当前 openid', r.data.demand.proposerId, 'o-zhang');
  check('提出人姓名是服务端快照', r.data.demand.proposerName, '张三');

  // ② ★ 管理者也能建 —— 本次唯一的权限例外，必须有测试钉住
  r = await call('o-view', 'create', { demand: { title: '管理者提的需求' } });
  check('★ 管理者（只读）可以建需求', r.ok, true);
  const dView = r.data._id;

  // ③ 标题必填
  r = await call('o-zhang', 'create', { demand: { title: '   ' } });
  check('空标题被拒', [r.ok, r.code], [false, 'INVALID_PARAM']);

  // ④ ★ 管理者能改、能关**自己提的**
  r = await call('o-view', 'update', { demandId: dView, patch: { detail: '我自己补一句' } });
  check('★ 管理者能改自己提的需求', r.ok, true);
  r = await call('o-view', 'close', { demandId: dView, closeReason: '先不做了' });
  check('★ 管理者能关自己提的需求', [r.ok, r.data.status], [true, '已关闭']);
  r = await call('o-view', 'reopen', { demandId: dView });
  check('★ 管理者能重开自己提的需求', [r.ok, r.data.status], [true, '待认领']);

  // ⑤ ★ 管理者改不了别人提的
  r = await call('o-view', 'update', { demandId: d1, patch: { detail: '我说了算' } });
  check('★ 管理者改别人提的需求被拒', r.ok, false);
  check('★ 拒绝用的是权限错误码（前端会提示并刷新）', r.code, 'FORBIDDEN_NOT_PARTICIPANT');
  r = await call('o-view', 'close', { demandId: d1 });
  check('★ 管理者关别人提的需求被拒', r.ok, false);

  // ⑥ 外人（未认领）一律拒绝
  r = await call('o-stranger', 'list', {});
  check('未认领者连列表都读不到', [r.ok, r.code], [false, 'NOT_CLAIMED']);

  // ⑦ 管理员可以改关任何人的
  r = await call('o-admin', 'update', { demandId: d1, patch: { contactName: '王主任' } });
  check('管理员可改他人的需求', r.ok, true);

  // ⑧ list / get
  r = await call('o-li', 'list', {});
  check('任何已认领成员都能看到全部需求', r.ok && r.data.list.length >= 2, true);
  r = await call('o-li', 'get', { demandId: d1 });
  check('get 返回需求本体', r.data.demand.title, '和财富部聊机场贵宾权益');
  check('get 一并返回关联任务（此时为空）', r.data.tasks, []);
  r = await call('o-li', 'get', { demandId: 'd-nope' });
  check('★ 需求不存在时返回 null 而不是报错（正常竞态，不是加载失败）', [r.ok, r.data.demand], [true, null]);

  // ⑨ close → reopen 的语义：没建过任务的，重开回「待认领」
  r = await call('o-zhang', 'close', { demandId: d1, closeReason: '聊完了，不用做' });
  check('提出人可关闭', [r.ok, r.data.status], [true, '已关闭']);
  r = await call('o-zhang', 'list', {});
  check('关闭原因被写下来', r.data.list.find((d) => d._id === d1).closeReason, '聊完了，不用做');
  check('关闭人姓名是快照', r.data.list.find((d) => d._id === d1).closedByName, '张三');
  r = await call('o-zhang', 'reopen', { demandId: d1 });
  check('未建任务的需求重开回「待认领」', [r.ok, r.data.status], [true, '待认领']);
  r = await call('o-li', 'list', {});
  check('★ 重开时清掉关闭痕迹', r.data.list.find((d) => d._id === d1).closedAt, null);

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) process.exit(1);
})();
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-svc.js"`
Expected: FAIL —— `Cannot find module 'G:/TeamPulse/cloudfunctions/demandService/index.js'`。

- [ ] **Step 3: 实现**

新建 `cloudfunctions/demandService/package.json`：

```json
{
  "name": "demandService",
  "version": "1.0.0",
  "description": "需求池服务：需求的新建、修改、关闭、重开、领走占位",
  "main": "index.js",
  "dependencies": {
    "wx-server-sdk": "~2.6.3"
  }
}
```

（版本与其余 8 个云函数保持一致 —— 直接抄 `cloudfunctions/taskService/package.json` 里的那行。）

新建 `cloudfunctions/demandService/index.js`：

```js
/**
 * cloudfunctions/demandService/index.js
 * ---------------------------------------------------------------------------
 * 需求池服务。需求是"还没成形的事"（没人负责、无交付物），
 * 任务是"已经有人认领的事" —— 领走 = 基于一条需求建一个任务。
 *
 * ★★★ 本文件是全局**唯一**一个故意不调用 ctx.requireWriter() 的写域。★★★
 *
 *   现有硬规则里「管理者」（ROLE.VIEWER）是纯只读，三道闸口一致：
 *   ctx.requireWriter() 一刀切、custom-tab-bar 置灰、README §5 权限矩阵。
 *   用户 2026-10-09 拍板：管理者能看需求池、能建需求、能改能关自己提的。
 *
 *   这个粒度（"只能写他自己提的那几条"）用一刀切表达不了，只能在纯函数里表达。
 *   所以这里全部 action 走 requireMember()，写权限交给 perm.canEditDemand ——
 *   它与前端共用同一个函数，前端控显隐、后端做强制校验，口径不会漂。
 *
 *   ★ 其余全部数据域（任务、进展、计划、成员）**一行不改**，管理者在那里
 *     仍是 FORBIDDEN_VIEWER。他领不走需求，因为领走 = 建任务，
 *     而 taskService.create 的第一步仍是 requireWriter()。
 *
 * action 一览：
 *   list    需求列表（分段筛在前端做，一次拉全量）
 *   get     单条（不存在返回 null，不抛错）
 *   create  建需求
 *   update  改标题/描述/对接人/期望时间
 *   close   关闭（写 closeReason）
 *   reopen  清空关闭痕迹 → 交给重算定状态
 * ---------------------------------------------------------------------------
 */

const { createRouter } = require('./lib/shared/router');
const { BizError, Codes } = require('./lib/shared/errors');
const { COLLECTIONS, ROLE } = require('./lib/shared/constants');
const validate = require('./lib/shared/validate');
const perm = require('./lib/shared/perm');
const {
  buildDemandDoc,
  readDemand,
  tasksOfDemand,
  listAllDemands,
  syncDemandStatus,
} = require('./lib/shared/demandRepo');

const DEMANDS = COLLECTIONS.DEMANDS;

/**
 * 拒绝编辑权的统一判据。
 *
 * ★ 错误码用 FORBIDDEN_NOT_PARTICIPANT 而不是新造一个：它的语义正是
 *   "你不是这件事的参与方"，且 utils/api.js 的 REFRESH_ON_ERROR 已经收录它
 *   （用户会看到提示 + 当前页自动刷新，拿到最新的归属）。
 */
function assertCanEdit(demand, ctx, me) {
  if (!perm.canEditDemand(demand, ctx.openid, me.role === ROLE.ADMIN)) {
    throw new BizError(
      Codes.FORBIDDEN_NOT_PARTICIPANT,
      '只能处置与自己相关的需求（提出人、领走人或管理员）'
    );
  }
}

/** 读一条需求，不存在则抛错（close / reopen / update 用；get 不抛，见下） */
async function getDemandOrThrow(ctx, demandId) {
  const d = await readDemand(ctx.db, demandId);
  if (!d) throw new BizError(Codes.INVALID_PARAM, '需求不存在或已被删除');
  return d;
}

// ---------------------------------------------------------------------------

/**
 * 需求列表。一次拉全量，分段筛在前端做。
 * ★ 10 人规模下需求总量是几十条，一次拉完在前端分组比三次查询简单，
 *   也和任务看板"一次拉全量再归并"是同一套路。
 */
async function list(payload, ctx) {
  await ctx.requireMember();
  return { list: await listAllDemands(ctx.db) };
}

/**
 * 读一条需求 + 它的关联任务。
 * ★ 需求不存在时返回 { demand: null }，**不抛错** —— 手上的 id 是几秒前
 *   从列表点进来的，那一条刚被别人删掉是正常竞态，不该说成"加载失败"。
 * ★ 顺带把关联任务带回来（而不是让页面再查一次）：这是"这条需求后来怎么样了"
 *   的唯一入口，两个来源分两次查会出现互相矛盾的中间态。
 */
async function get(payload, ctx) {
  await ctx.requireMember();
  const demandId = validate.assertNonEmptyString(payload.demandId, '需求');
  const demand = await readDemand(ctx.db, demandId);
  if (!demand) return { demand: null, tasks: [] };
  return { demand, tasks: await tasksOfDemand(ctx.db, demandId) };
}

/**
 * 建需求。
 * ★ 门禁是 requireMember —— 管理者正是在这里进来的（见文件头）。
 *   其余全部校验与写入都按普通成员处理，不做任何角色分支。
 */
async function create(payload, ctx) {
  const me = await ctx.requireMember();
  const fields = validate.validateDemandFields(payload.demand || {}, { isCreate: true });
  validate.assertDemandRequiredForCreate(fields);

  const doc = buildDemandDoc({
    fields,
    proposerId: ctx.openid,
    proposerName: me.name,
    db: ctx.db,
  });

  const res = await ctx.db.collection(DEMANDS).add({ data: doc });
  return { _id: res._id, demand: Object.assign({ _id: res._id }, doc) };
}

/** 改需求。状态不在这里改 —— 那是领走/关闭/重算的事 */
async function update(payload, ctx) {
  const me = await ctx.requireMember();
  const demandId = validate.assertNonEmptyString(payload.demandId, '需求');
  const demand = await getDemandOrThrow(ctx, demandId);
  assertCanEdit(demand, ctx, me);

  const patch = validate.validateDemandFields(payload.patch || {}, { isCreate: false });
  if (!Object.keys(patch).length) {
    throw new BizError(Codes.INVALID_PARAM, '没有需要更新的字段');
  }

  patch.updatedAt = ctx.db.serverDate();
  await ctx.db.collection(DEMANDS).doc(demandId).update({ data: patch });
  return { demandId, patch };
}

/**
 * 关闭需求（"这件事不做了"）。
 * ★ 已关闭的直接幂等返回：重复点是正常的（网络重试、连点），不是错误。
 */
async function close(payload, ctx) {
  const me = await ctx.requireMember();
  const demandId = validate.assertNonEmptyString(payload.demandId, '需求');
  const demand = await getDemandOrThrow(ctx, demandId);
  assertCanEdit(demand, ctx, me);

  if (demand.status === '已关闭') {
    return { demandId, status: '已关闭', idempotent: true };
  }

  const closeReason = String(payload.closeReason || '').trim().slice(0, 200);
  await ctx.db.collection(DEMANDS).doc(demandId).update({
    data: {
      status: '已关闭',
      closedByName: me.name,   // 快照
      closedAt: ctx.db.serverDate(),
      closeReason,
      updatedAt: ctx.db.serverDate(),
    },
  });
  return { demandId, status: '已关闭' };
}

/**
 * 重新打开。
 *
 * ★ 不硬写「待认领」：用户的原话是"回到待认领"，那只说对了一半 ——
 *   没建任务就关的确实回待认领；但「已领走」的需求也能被关闭，
 *   那种需求重开时该回「已领走」，而不是把人已经领走的事实抹掉。
 *   一份重算逻辑回答所有情况，比在这里再写一遍分支可靠。
 */
async function reopen(payload, ctx) {
  const me = await ctx.requireMember();
  const demandId = validate.assertNonEmptyString(payload.demandId, '需求');
  const demand = await getDemandOrThrow(ctx, demandId);
  assertCanEdit(demand, ctx, me);

  if (demand.status !== '已关闭') {
    return { demandId, status: demand.status, idempotent: true };
  }

  const r = await syncDemandStatus(ctx.db, demandId, { fromReopen: true });
  return { demandId, status: r.status };
}

exports.main = createRouter({
  list,
  get,
  create,
  update,
  close,
  reopen,
});
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-svc.js"`
Expected: PASS —— 末尾 `通过 21 项，失败 0 项`。

- [ ] **Step 5: 提交**

```bash
git add cloudfunctions/demandService miniprogram/shared cloudfunctions/*/lib/shared
git commit -m "feat(demand): 第 9 个云函数 demandService（管理者在此是唯一开放的写域）"
```

---

## Task 6: 领走 —— `taskService` 的原子占位与重算挂钩

**Files:**
- Modify: `shared/taskRepo.js:120-171`（`buildTaskDoc`）
- Modify: `cloudfunctions/taskService/index.js`
- Test: `C:\Users\Administrator\AppData\Local\Temp\tp-demand-task.js`（仓库外，跑完删）

**Interfaces:**
- Consumes: `demandRepo.claimDemand/releaseDemand/syncDemandQuietly`
- Produces:
  - `buildTaskDoc(opts)` 新增可选 `opts.demandId` → `doc.demandId`
  - `taskService.create` / `adminCreate` 接受顶层 `payload.demandId`
  - `taskService.create` / `adminCreate` 的幂等令牌改为同时认 `ctx.event.clientToken`（顶层）与 `payload.clientToken`

- [ ] **Step 1: 写失败的测试**

写 `C:\Users\Administrator\AppData\Local\Temp\tp-demand-task.js`（与 Task 5 的桩同构：`store` 里加 `tasks`、`demands`，钩住 `wx-server-sdk`，这次 require `cloudfunctions/taskService/index.js`）。要点如下：

```js
const taskService = require(path.join(ROOT, 'cloudfunctions/taskService/index.js'));

(async () => {
  // ① 带 demandId 建任务 = 领走
  // seed(): members = 张三(普通) / 李四(普通) / 管理者甲(管理者) / 管理员乙(管理员)
  //         demands = 四条「待认领」，_id 依次 d1..d4，全部零任务
  seed();
  let r = await call('o-zhang', 'create', {
    task: { task_name: '和财富部谈权益', category: '系统研发', source: '需求池', task_type: '计划性', due_date: '2026-12-31' },
    demandId: 'd1',
  });
  check('带 demandId 建任务成功', r.ok, true);
  const taskId = r.data._id;
  check('★ 需求转为「已领走」', store.demands[0].status, '已领走');
  check('★ 领走人 = 新建任务的主办人', store.demands[0].claimedById, 'o-zhang');
  check('★ 任务文档带上了 demandId', store.tasks[0].demandId, 'd1');

  // ② ★ 重复领走：第二次必须失败，且不能把已建好的任务当成"没建成"
  r = await call('o-li', 'create', {
    task: { task_name: '我也想领这条', category: '系统研发', source: '需求池', task_type: '计划性', due_date: '2026-12-31' },
    demandId: 'd1',
  });
  check('★ 已被领走的需求不能再领', [r.ok, r.code], [false, 'INVALID_PARAM']);
  check('★ 第二个人没有建成任何任务', store.tasks.length, 1);
  check('★ 领走人没有被改写', store.demands[0].claimedById, 'o-zhang');

  // ③ ★ 带幂等令牌重复提交（网络重试）—— 同一个人、同一个令牌
  const token = 'tk-retry-1';
  const r1 = await call('o-li', 'create', {
    task: { task_name: '幂等测试', category: '系统研发', source: '需求池', task_type: '计划性', due_date: '2026-12-31' },
    demandId: 'd2',
  }, token);
  check('第一次带令牌建任务成功', r1.ok, true);
  const r2 = await call('o-li', 'create', {
    task: { task_name: '幂等测试', category: '系统研发', source: '需求池', task_type: '计划性', due_date: '2026-12-31' },
    demandId: 'd2',
  }, token);
  check('★ 同一令牌重试不再占一次需求（不该报"已被领走"）', [r2.ok, r2.data && r2.data.idempotent], [true, true]);

  // ④ ★ 占位成功但建任务失败 → 需求退回池子
  const before = store.demands.find((d) => d._id === 'd3').status;
  r = await call('o-zhang', 'create', {
    task: { task_name: '缺截止日', category: '系统研发', source: '需求池', task_type: '计划性' },  // due_date 缺失
    demandId: 'd3',
  });
  check('建任务失败时返回错误', r.ok, false);
  check('★ 需求被回滚成待认领（没有停在"已领走却零任务"）',
    store.demands.find((d) => d._id === 'd3').status, '待认领');
  check('回滚时清空了领走人', store.demands.find((d) => d._id === 'd3').claimedById, '');

  // ⑤ ★ 管理者仍被挡在门外（门只开了一半）
  r = await call('o-view', 'create', {
    task: { task_name: '管理者想领', category: '系统研发', source: '需求池', task_type: '计划性', due_date: '2026-12-31' },
    demandId: 'd4',
  });
  check('★ 管理者建任务仍被拒', [r.ok, r.code], [false, 'FORBIDDEN_VIEWER']);
  check('★ 被拒时需求纹丝不动（门禁在占位之前）',
    store.demands.find((d) => d._id === 'd4').status, '待认领');

  // ⑥ 改任务的 stage → 需求重算
  // 先让 d1 只有 taskId 这一条任务，把它改成已完成
  r = await call('o-zhang', 'update', { taskId, patch: { stage: '已完成' } });
  check('主办人可改阶段', r.ok, true);
  check('★ 关联任务全部完成 → 需求自动完成', store.demands[0].status, '已完成');
  r = await call('o-zhang', 'update', { taskId, patch: { stage: '进行中' } });
  check('★ 任务退回 → 需求退回「已领走」', store.demands[0].status, '已领走');

  // ⑦ 删任务 → 需求回到池子
  r = await call('o-zhang', 'delete', { taskId });
  check('主办人可删任务', r.ok, true);
  check('★ 任务被删光 → 需求回到「待认领」', store.demands[0].status, '待认领');
  check('★ 并清空领走人', store.demands[0].claimedById, '');

  // ⑧ ★ 已关闭的需求不受任务状态变化影响
  seed();  // 重来一遍：d1 已关闭
  store.demands[0].status = '已关闭';
  const t = await call('o-zhang', 'create', { task: { task_name: 'X', category: '系统研发', source: '需求池', task_type: '计划性', due_date: '2026-12-31' } });
  check('不关联需求的任务照常能建', t.ok, true);
  // 直接把一条任务的 demandId 指向已关闭的需求，再改它的阶段
  store.tasks[0].demandId = 'd1';
  await call('o-zhang', 'update', { taskId: store.tasks[0]._id, patch: { stage: '已完成' } });
  check('★ 已关闭的需求不被自动规则改动', store.demands[0].status, '已关闭');

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) process.exit(1);
})();
```

其中 `call(openid, action, payload, token)` 把 `clientToken` 放在**顶层**（与 `utils/api.js` 的 `call` 一致）：

```js
const call = (openid, action, payload, clientToken) =>
  (CURRENT_OPENID = openid, taskService.main({ action, payload: payload || {}, clientToken: clientToken || '' }));
```

> ★ 这个桩的 `store` / `db` / `call` / `check` 全部照抄 `tp-demand-svc.js`，只把 `require` 的目标换成 `taskService`，并让 `seed()` 多建 4 条待认领需求。

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-task.js"`
Expected: FAIL —— 第一条 `带 demandId 建任务成功` 就会红：任务建出来了但 `需求转为「已领走」` 得到 `"待认领"`（`demandId` 根本没被处理）；③ 的幂等那两条也会红（令牌没被读到，`idempotent` 是 undefined）。

- [ ] **Step 3: 改 `shared/taskRepo.js`**

在 `buildTaskDoc` 的解构里加 `demandId`，并在文档构造之后、`_id` 之前加一行：

```js
function buildTaskDoc(opts) {
  const {
    fields,
    leaderId,
    leaderName,
    collaboratorIds,
    collaboratorNames,
    creatorId,
    db,
    _id,
    origin,
    templateId,
    periodKey,
    demandId,          // ← 新增
  } = opts;
```

```js
  // 周期任务溯源字段，同时作为幂等键（配合确定性 _id 双重保险）
  if (templateId) doc.templateId = templateId;
  if (periodKey) doc.periodKey = periodKey;

  // ★ 领走溯源：这条任务是从哪条需求来的。
  //   只在建任务那一刻写入（= 领走），之后主办人改不了 —— 它不在任何
  //   白名单里，前端传不进来。否则 task-edit 能把任务指向任意一条需求，
  //   把一个普通任务伪装成"已领走"，那条需求的关联任务数与自动完成判定就全乱了。
  if (demandId) doc.demandId = demandId;

  if (_id) doc._id = _id;
```

在 `buildTaskDoc` 的 JSDoc 里补一行 `@param {string} [opts.demandId] 领走时关联的需求 _id`。

- [ ] **Step 4: 改 `cloudfunctions/taskService/index.js`**

顶部补 require：

```js
const {
  claimDemand,
  releaseDemand,
  syncDemandQuietly,
} = require('./lib/shared/demandRepo');
```

在 `resolveCollaborators` 之后加一个令牌读取器：

```js
/**
 * 幂等令牌。
 *
 * ★ 前端有两种传法，历史上都出现过：
 *     ① 放在调用的**顶层**（utils/api.js 的 call 把 opts.clientToken 写在 data 上）
 *     ② 页面自己塞进 payload 里（progress-add 就是这么干的）
 *   云函数这一侧过去只认 ②，于是 task-create 传的令牌**从来没生效过** ——
 *   建任务一直不是幂等的，网络重试会建出两条一模一样的任务。
 *   需求池让这件事变得危险：重试时第二次 claimDemand 会撞上"已被领走"，
 *   而那是用户**自己**刚领的，报错信息完全说不通。
 *   两个都认。
 */
function readToken(payload, ctx) {
  const top = ctx.event && ctx.event.clientToken;
  return String(top || payload.clientToken || '').slice(0, 64);
}
```

改 `create`：

```js
async function create(payload, ctx) {
  const me = await ctx.requireWriter();
  const fields = validate.validateTaskFields(payload.task || {}, { isCreate: true });
  validate.assertTaskRequiredForCreate(fields);

  const { ids, names } = await resolveCollaborators(
    ctx,
    fields.__rawCollaboratorIds,
    ctx.openid
  );

  // ★ 顺序：先占位、再建任务。反过来的话，两个人同时点「领走」会双双建成任务，
  //   而其中一条的 demandId 指向的需求已经被另一个人占走了。
  //   门禁在最前（requireWriter），管理者走不到这一行。
  const demandId = await claimDemand(ctx, payload.demandId, ctx.openid);

  try {
    return await insertTask(ctx, {
      fields,
      leaderId: ctx.openid,
      leaderName: me.name,
      collaboratorIds: ids,
      collaboratorNames: names,
      creatorId: ctx.openid,
      token: readToken(payload, ctx),
      demandId,
    });
  } catch (e) {
    // 占位成功但建任务失败：把需求退回池子，否则它停在「已领走」却一条任务都没有。
    // releaseDemand 内部吞掉自己的错误，不会盖掉这里要抛给用户的原始错误。
    await releaseDemand(ctx, demandId, ctx.openid);
    throw e;
  }
}
```

改 `adminCreate` 的尾部（管理员代建时，领走人是**被指派的主办人**）：

```js
  const demandId = await claimDemand(ctx, payload.demandId, leaderId);

  try {
    return await insertTask(ctx, {
      fields,
      leaderId,
      leaderName: leaderMember.name,
      collaboratorIds: ids,
      collaboratorNames: names,
      creatorId: admin.openid,
      token: readToken(payload, ctx),
      demandId,
    });
  } catch (e) {
    await releaseDemand(ctx, demandId, leaderId);
    throw e;
  }
```

改 `insertTask`：

```js
async function insertTask(ctx, opts) {
  const {
    fields, leaderId, leaderName, collaboratorIds, collaboratorNames,
    creatorId, token, demandId,
  } = opts;

  const _id = token ? manualTaskId(String(token).slice(0, 64)) : undefined;
  const doc = buildTaskDoc({
    fields,
    leaderId,
    leaderName,
    collaboratorIds,
    collaboratorNames,
    creatorId,
    db: ctx.db,
    _id,
    origin: ORIGIN.MANUAL,
    demandId,
  });
  // ...以下原样不动
```

改 `update` 的尾部（写库之后）：

```js
  patch.updatedAt = ctx.db.serverDate();
  await ctx.db.collection(TASKS).doc(taskId).update({ data: patch });

  /*
   * 需求状态跟着任务走。★ 失败隔离：包在 syncDemandQuietly 里，
   * 出错只进日志，绝不把任务保存本身带崩 —— 需求晚一步同步是小事，
   * 用户辛苦改的一整屏是大事。漏掉的由每日巡检收敛。
   */
  if ('stage' in patch && task.demandId) {
    await syncDemandQuietly(ctx.db, task.demandId);
  }

  return { taskId, patch };
```

改 `remove` 的尾部：

```js
  await ctx.db.collection(TASKS).doc(taskId).remove();

  // 任务被删光的需求会回到「待认领」（由重算统一判定，这里不写分支）
  if (task.demandId) await syncDemandQuietly(ctx.db, task.demandId);

  return { taskId, deleted: true, removedRecords: removed };
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `node scripts/sync-shared.js`
Expected: `✓ 完成`（`taskRepo.js` 变了）

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-task.js"`
Expected: PASS —— 末尾 `通过 22 项，失败 0 项`。

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-svc.js"`
Expected: 仍然 PASS（回归，确认没把 Task 5 弄坏）

Run: `node scripts/selfcheck.js`
Expected: PASS，`失败 0 项`

- [ ] **Step 6: 提交**

```bash
git add shared/taskRepo.js cloudfunctions/taskService/index.js miniprogram/shared cloudfunctions/*/lib/shared
git commit -m "feat(demand): 领走 —— 原子占位、失败回滚、任务侧重算挂钩；顺带修好任务创建的幂等令牌"
```

---

## Task 7: 进展与每日巡检挂上重算

**Files:**
- Modify: `cloudfunctions/progressService/index.js`
- Modify: `cloudfunctions/generatePeriodicTasks/index.js`

**Interfaces:**
- Consumes: `demandRepo.syncDemandQuietly`、`demandRepo.syncAllDemands`
- Produces: 无新接口（行为：`addRecord` 的 `stage` 变更与每日巡检都会收敛需求状态）

- [ ] **Step 1: 写失败的测试**

在 `C:\Users\Administrator\AppData\Local\Temp\tp-demand-task.js` 末尾（汇总打印之前）追加：

```js
  // ⑨ ★ 报进展时改了阶段 —— 需求必须跟着动
  seed();
  const svc = require(path.join(ROOT, 'cloudfunctions/progressService/index.js'));
  let t2 = null;
  await call('o-zhang', 'create', {
    task: { task_name: '带需求的活', category: '系统研发', source: '需求池', task_type: '计划性', due_date: '2026-12-31' },
    demandId: 'd1',
  });
  t2 = store.tasks[0]._id;
  let pr = await svc.main(CURRENT_OPENID = 'o-zhang', {
    action: 'addRecord',
    payload: { taskId: t2, description: '做完了', stage: '已完成', progress: 100 },
    clientToken: '',
  });
  check('进展提交成功（重算失败不该影响它）', pr.ok, true);
  check('★ 进展里把阶段改成已完成 → 需求自动完成', store.demands[0].status, '已完成');

  // ⑩ ★ 重算失败不能把进展提交带崩
  seed();
  await call('o-zhang', 'create', {
    task: { task_name: '带需求的活2', category: '系统研发', source: '需求池', task_type: '计划性', due_date: '2026-12-31' },
    demandId: 'd1',
  });
  const t3 = store.tasks[0]._id;
  // 把 demands 集合的读取炸掉，模拟重算失败
  const realCollection = db.collection;
  db.collection = (name) => {
    if (name === 'demands') throw new Error('集合炸了');
    return realCollection.call(db, name);
  };
  pr = await svc.main(CURRENT_OPENID = 'o-zhang', {
    action: 'addRecord',
    payload: { taskId: t3, description: '照样要能提交', stage: '已完成', progress: 100 },
    clientToken: '',
  });
  db.collection = realCollection;
  check('★ 需求重算炸了，进展依然提交成功', pr.ok, true);
  check('进展记录确实落库了', store.progress_records.length > 0, true);

  // ⑪ 每日巡检
  seed();
  store.demands[0].status = '已领走';
  store.demands[0].claimedById = 'o-zhang';
  store.tasks.push({ _id: 'orphan', demandId: 'd1', stage: '已完成' });
  store.members.find((m) => m.openid === 'o-admin').role = '管理员';
  const gp = require(path.join(ROOT, 'cloudfunctions/generatePeriodicTasks/index.js'));
  let gr = await gp.main(CURRENT_OPENID = 'o-admin', { action: 'x', payload: {} });
  check('★ 巡检把「已领走 + 任务全完成」收敛成「已完成」', store.demands[0].status, '已完成');
  check('巡检返回扫描条数', gr.ok && gr.data.demandSync.scanned, 4);
```

注意 `svc.main(openid, event)` 那一行要写成 `svc.main({ action, payload, clientToken })` 而 openid 由 `CURRENT_OPENID` 决定 —— 上面为了紧凑写成一句，实现时拆开：

```js
CURRENT_OPENID = 'o-zhang';
pr = await svc.main({ action: 'addRecord', payload: { ... }, clientToken: '' });
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-task.js"`
Expected: FAIL —— `进展里把阶段改成已完成 → 需求自动完成` 得到 `"已领走"`；⑪ 的 `gr.data.demandSync` 是 `undefined` → `TypeError`。

- [ ] **Step 3: 改 `cloudfunctions/progressService/index.js`**

顶部补 require：

```js
const { syncDemandQuietly } = require('./lib/shared/demandRepo');
```

在 `// ── 5. 把主办人改动的字段落到任务上 ──` 那个 `if` 块**之后**、`// ── 6. 重算卡壳冗余字段 ──` **之前**插入：

```js
  // ── 5b. 阶段变了就重算需求状态 ────────────────────────────────────────
  /*
   * ★ 只在 stage 真的在 patch 里时才动 —— 普通进展（只写 description）
   *   不该引发需求重算，那会让每次上报都多两次查询。
   * ★ syncDemandQuietly 内部吞掉一切异常：用户辛苦填的进展提交不上去，
   *   比"需求状态晚一步同步"严重得多。
   */
  if ('stage' in taskPatch && task.demandId) {
    await syncDemandQuietly(ctx.db, task.demandId);
  }
```

- [ ] **Step 4: 改 `cloudfunctions/generatePeriodicTasks/index.js`**

顶部补 require：

```js
const { syncAllDemands } = require('./lib/shared/demandRepo');
```

在定时路径里，`runGenerate` 之后加一段：

```js
  if (isTimerEvent(event)) {
    console.log('[generatePeriodicTasks] 定时巡检开始', event.TriggerName || event.Type);
    try {
      const result = await runGenerate(db, { operator: 'timer' });

      /*
       * ── 需求状态兜底重算 ────────────────────────────────────────────
       * 四个即时落点（建任务 / 改任务 / 报进展 / 删任务）都可能重算失败 ——
       * 它们一律被 syncDemandQuietly 吞掉以保证主流程不被带崩。这里就是
       * 那些漏网之鱼的收敛口：每天扫一遍，把派生状态拉回真实状态。
       * ★ 不新建一个云函数：一个每天只跑一次的巡检单独占一个函数名、
       *   一份部署、一份 lib/shared 副本，代价大于收益；而本函数本来就是
       *   "每天扫一遍库、把派生状态收敛到真实状态"的定位，加这一段是同性质的。
       */
      let demandSync = null;
      try {
        demandSync = await syncAllDemands(db);
        console.log(
          `[generatePeriodicTasks] 需求重算 扫描=${demandSync.scanned} 变化=${demandSync.changed}`
        );
      } catch (e) {
        // 需求重算失败不能影响周期任务生成的结果（它已经落库了），只记日志
        console.error('[generatePeriodicTasks] 需求重算失败', e);
      }

      console.log(
        `[generatePeriodicTasks] 完成 以 ${result.today} 为准 新建=${result.created.length} 跳过=${result.skipped.length} 失败=${result.failed.length}`
      );
      return { ok: true, data: Object.assign({ demandSync }, result) };
    } catch (e) {
      // 定时触发的返回值无人接收，只能靠日志排查。这里必须打全堆栈。
      console.error('[generatePeriodicTasks] 巡检异常', e);
      return { ok: false, code: Codes.INTERNAL, message: String(e.message || e) };
    }
  }
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `node scripts/sync-shared.js`
Expected: `✓ 完成`

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-task.js"`
Expected: PASS —— 末尾 `通过 28 项，失败 0 项`（Task 6 的 22 条 + 本任务新增的 6 条）。

Run: `node scripts/selfcheck.js`
Expected: PASS，`失败 0 项`

- [ ] **Step 6: 提交**

```bash
git add cloudfunctions/progressService cloudfunctions/generatePeriodicTasks miniprogram/shared cloudfunctions/*/lib/shared
git commit -m "feat(demand): 报进展的阶段变更与每日巡检都收敛需求状态（失败一律隔离）"
```

---

## Task 8: 前端接线 —— `config` / `api` / `format`

**Files:**
- Modify: `miniprogram/config.js:19-27`
- Modify: `miniprogram/utils/api.js`
- Modify: `miniprogram/utils/format.js`
- Test: `C:\Users\Administrator\AppData\Local\Temp\tp-demand-fmt.js`（仓库外，跑完删）

**Interfaces:**
- Consumes: 无（纯新增）
- Produces:
  - `config.functions.demand === 'demandService'`
  - `api.demandApi.{list,get,create,update,close,reopen}`
  - `api.taskApi.create(task, clientToken, demandId)`、`api.taskApi.adminCreate(leaderId, task, clientToken, demandId)`
  - `fmt.decorateDemand(demand) → Demand & {_statusTone, _statusText, _contactText, _expectText, _createdText}`

- [ ] **Step 1: 写失败的测试**

`C:\Users\Administrator\AppData\Local\Temp\tp-demand-fmt.js`：

```js
'use strict';
const path = require('path');
const ROOT = 'G:/TeamPulse';
// format.js 会 require('../utils/theme')，那里没有 wx 依赖；但保险起见先摊一个
global.wx = global.wx || {};
const fmt = require(path.join(ROOT, 'miniprogram/utils/format.js'));

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}

const base = {
  _id: 'd1', title: '和财富部聊机场贵宾权益', detail: '', contactDept: '财富部',
  contactName: '王主任', expectDate: '2026-10-31', status: '待认领',
  proposerName: '张三', claimedByName: '', closeReason: '',
  createdAt: new Date(), updatedAt: new Date(),
};

const d = fmt.decorateDemand(base);
check('待认领 → active 色', d._statusTone, 'active');
check('已领走 → warn 色', fmt.decorateDemand(Object.assign({}, base, { status: '已领走' }))._statusTone, 'warn');
check('已完成 → done 色', fmt.decorateDemand(Object.assign({}, base, { status: '已完成' }))._statusTone, 'done');
check('已关闭 → idle 色', fmt.decorateDemand(Object.assign({}, base, { status: '已关闭' }))._statusTone, 'idle');
check('★ 认不出的状态兜底 idle（不崩、不空白）',
  fmt.decorateDemand(Object.assign({}, base, { status: '天知道' }))._statusTone, 'idle');

check('对接人文本：部门 · 姓名', d._contactText, '财富部 · 王主任');
check('只有部门时不留分隔符', fmt.decorateDemand(Object.assign({}, base, { contactName: '' }))._contactText, '财富部');
check('都没有时是空串（模板里靠它决定显不显示这一行）',
  fmt.decorateDemand(Object.assign({}, base, { contactDept: '', contactName: '' }))._contactText, '');

check('期望时间带「期望」前缀', d._expectText.indexOf('期望') === 0, true);
check('没填期望时间时是空串', fmt.decorateDemand(Object.assign({}, base, { expectDate: '' }))._expectText, '');
check('刚建出来显示「刚刚」', d._createdText, '刚刚');

check('空对象原样返回（与 decorateTask 同款）', fmt.decorateDemand(null), null);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-fmt.js"`
Expected: FAIL —— `fmt.decorateDemand is not a function`。

- [ ] **Step 3: 改 `miniprogram/config.js`**

```js
  functions: {
    member: 'memberService',
    task: 'taskService',
    progress: 'progressService',
    template: 'templateService',
    demand: 'demandService',
    ai: 'callAI',
    notify: 'notifyService',
    periodic: 'generatePeriodicTasks',
  },
```

- [ ] **Step 4: 改 `miniprogram/utils/api.js`**

`taskApi` 的两个写入口各加一个 `demandId` 参数（放在最后，保持既有调用方不用改）：

```js
const taskApi = {
  // ★ demandId 非空表示这次建任务是"从需求池领走一条需求"。
  //   传空串而不是不传：云函数的 claimDemand 对空值直接放行，
  //   少一种"字段时有时无"的形态。
  create: (task, clientToken, demandId) =>
    call(config.functions.task, 'create', { task, demandId: demandId || '' }, { clientToken }),
  adminCreate: (leaderId, task, clientToken, demandId) =>
    call(config.functions.task, 'adminCreate', { leaderId, task, demandId: demandId || '' }, { clientToken }),
  // ...其余不变
```

在 `templateApi` 之前插入：

```js
/**
 * 需求池（demands）。
 * ★ 这是唯一一个"管理者"也能写的域 —— 服务端走 requireMember 而非
 *   requireWriter，写权限由 shared/perm.js 的 canEditDemand 判定。
 *   前端不复制那份判断，页面直接用 perm.canEditDemand（同一个函数）。
 */
const demandApi = {
  list: () => call(config.functions.demand, 'list'),
  /**
   * 读一条需求 + 它的关联任务。不存在时 demand 为 null，不抛错 ——
   * 列表是几秒前拉的，点开时刚被别人删掉是正常竞态。
   */
  get: (demandId) => call(config.functions.demand, 'get', { demandId }),
  create: (demand) => call(config.functions.demand, 'create', { demand }),
  update: (demandId, patch) => call(config.functions.demand, 'update', { demandId, patch }),
  close: (demandId, closeReason) => call(config.functions.demand, 'close', { demandId, closeReason }),
  reopen: (demandId) => call(config.functions.demand, 'reopen', { demandId }),
};
```

在 `module.exports` 里加 `demandApi,`。

- [ ] **Step 5: 改 `miniprogram/utils/format.js`**

在 `decoratePlans` 之后、`module.exports` 之前追加：

```js
// ── 需求（demands）────────────────────────────────────────────────────────

/**
 * 给一条需求补上展示用的派生字段。
 *
 * ★ 放在 format.js 而不是各页面里：需求池列表与需求详情都要回答
 *   "这条需求现在什么状态、对接的是谁、什么时候提的"，
 *   两处各写一份迟早会一个说"待认领"、另一个已经显示领走人了。
 *
 * ★ 状态色取自 C.DEMAND_STATUS_TONE，认不出的状态兜底 'idle' ——
 *   与 statusTone/stageTone 完全同款：新状态还没加进枚举时，
 *   界面显示成中性灰而不是没有颜色。
 */
function decorateDemand(d) {
  if (!d) return d;

  // 对接部门与对接人拼一行；两个都没有时给空串，让模板整行不渲染
  const contact = [d.contactDept, d.contactName].map((s) => String(s || '').trim()).filter(Boolean);

  return Object.assign({}, d, {
    _statusTone: C.DEMAND_STATUS_TONE[d.status] || 'idle',
    _statusText: d.status || '',
    _contactText: contact.join(' · '),
    // '期望 10月31日' / '' —— 前缀在 JS 里拼，模板不做字符串拼接
    _expectText: d.expectDate ? `期望 ${dates.friendlyDate(d.expectDate)}` : '',
    /**
     * 提出时间用 timeAgo（"刚刚 / 3 天前 / 10月5日"）而不是绝对日期：
     * 需求卡上要回答的是"这条放了多久了"，不是"哪一天提的"。
     */
    _createdText: timeAgo(d.createdAt),
  });
}

/** 批量装饰需求 */
function decorateDemands(list) {
  return (list || []).map(decorateDemand);
}
```

在 `module.exports` 里加 `decorateDemand,` 与 `decorateDemands,`。

- [ ] **Step 6: 跑测试，确认通过**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-fmt.js"`
Expected: PASS —— 末尾 `通过 12 项，失败 0 项`。

Run: `node scripts/selfcheck.js`
Expected: PASS，`失败 0 项`

- [ ] **Step 7: 提交**

```bash
git add miniprogram/config.js miniprogram/utils/api.js miniprogram/utils/format.js
git commit -m "feat(demand): 前端接线 —— config.functions.demand / demandApi / decorateDemand"
```

---

## Task 9: `pages/demand-edit` —— 新建与看改一体

**Files:**
- Create: `miniprogram/pages/demand-edit/index.js`
- Create: `miniprogram/pages/demand-edit/index.wxml`
- Create: `miniprogram/pages/demand-edit/index.wxss`
- Create: `miniprogram/pages/demand-edit/index.json`
- Modify: `miniprogram/app.json:2-17`

**Interfaces:**
- Consumes: `api.demandApi`、`perm.canEditDemand`、`fmt.decorateDemand/decorateTasks`、`auth.requireClaimed/currentOpenid`
- Produces: 页面路由 `/pages/demand-edit/index?id=<demandId>`（省略 id = 新建）

> ★ 一个页面兼两个职责（新建 / 看改一体），因为 spec §8 的改动面里只有这两个页面。
> 判据是 `id` 在不在：不在就是新建，此时 `canEdit` 恒为真（所有非只读成员都能建）。

- [ ] **Step 1: 写失败的测试**

`C:\Users\Administrator\AppData\Local\Temp\tp-demand-page.js` —— 桩掉 `Page` / `wx` / `api` / `auth`，驱动真实页面方法：

```js
'use strict';
const path = require('path');
const ROOT = 'G:/TeamPulse';

/** 加载一个页面模块，把 Page(...) 的参数抓出来 */
function loadPage(rel, stubs) {
  const Module = require('module');
  let captured = null;
  const origLoad = Module._load;
  Module._load = function (request, parent) {
    if (request === 'wx') return stubs.wx;
    const key = Object.keys(stubs.requires || {}).find((k) => request.indexOf(k) !== -1);
    if (key) return stubs.requires[key];
    return origLoad.apply(this, arguments);
  };
  global.Page = (o) => { captured = o; };
  global.getCurrentPages = () => [];
  delete require.cache[require.resolve(path.join(ROOT, rel))];
  require(path.join(ROOT, rel));
  Module._load = origLoad;
  // 造一个最小的页面实例：data + setData + onLoad
  const inst = Object.assign({}, captured, { data: JSON.parse(JSON.stringify(captured.data)) });
  inst.setData = function (patch, cb) {
    Object.keys(patch).forEach((k) => {
      if (k.indexOf('.') === -1) { this.data[k] = patch[k]; return; }
      const parts = k.split('.');
      let cur = this.data;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
      cur[parts[parts.length - 1]] = patch[k];
    });
    if (cb) cb();
  };
  inst.getTabBar = () => null;
  return inst;
}

// ── 桩实现（略去与 Task 5 同构的内存库部分，见 tp-demand-svc.js）──
```

要钉住的断言：

```js
// ① 新建模式（无 id）：canEdit 恒为真，标题是「新建需求」
// ② 表单校验：标题为空 → toast「请填写需求标题」，不发请求
// ③ toPatch 只提交改动过的字段（打开后原样保存 → 「没有改动」）
// ④ 编辑模式 + 非提出人非领走人非管理员 → canEdit=false，只读分支
// ⑤ ★ 管理者对自己提的需求：canEdit=true（前端这一层也要放开，否则进去只有只读）
// ⑥ ★ 管理者对别人提的需求：canEdit=false，且页面上不渲染任何输入控件
// ⑦ 关闭：调 demandApi.close(id, 原因)，成功后本地状态改「已关闭」
// ⑧ 重开：调 demandApi.reopen(id)，成功后本地状态回服务端返回的 status
// ⑨ 关联任务列表：get 返回的 tasks 经 fmt.decorateTasks 装饰后进 data.tasks
// ⑩ 需求不存在（get 返回 demand:null）→ notFound=true 且 1.2 秒后 navigateBack
```

`④⑤⑥` 的 `canEdit` 必须是 `perm.canEditDemand` 的真实结果 —— 桩里不要自己重算一遍，直接让 `require('../../shared/perm')` 走真文件（它是纯的，不需要 wx）。

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-page.js"`
Expected: FAIL —— `Cannot find module '.../pages/demand-edit/index.js'`。

- [ ] **Step 3: 写 `index.json`**

```json
{
  "navigationBarTitleText": "需求",
  "enablePullDownRefresh": true,
  "usingComponents": {
    "field-picker": "/components/field-picker/index",
    "task-card": "/components/task-card/index"
  }
}
```

- [ ] **Step 4: 写 `index.js`**

```js
/**
 * pages/demand-edit —— 新建需求 / 看一条需求（是自己的才给改）
 * ---------------------------------------------------------------------------
 * 两个入口：
 *   不带 ?id=  → 新建需求（所有非只读成员都能建，含「管理者」）
 *   带 ?id=xxx → 看改一体，照 pages/plan-edit 的先例
 *
 * ★ 一页两态，判据只有 canEdit（perm.canEditDemand，与云函数同一个函数）：
 *     能改 → 表单 + 危险区（关闭 / 重新打开）+ 保存按钮；
 *     不能改 → 只读摘要，页面上**不存在**输入控件与按钮。
 *   ★ 只读不是"把表单灰掉"：input / picker 灰掉只会做出一个"看着能点、
 *     点了也变"的假象。只读分支里干脆不摆控件。
 *   ★ 前端的 canEdit 只是体验（不显示点了会被拒的东西）；真正的边界是
 *     云函数 update / close / reopen 里的 assertCanEdit。
 *
 * ★ 管理者能进这一页的"能改"分支，这是本次唯一放开的地方：他作为提出人时
 *   canEditDemand 的 proposerId 那一项已经为真，perm.js 里没有任何角色特判。
 *
 * ★ 只提交**改动过的**字段，不做整份覆盖写回。patch 越窄，越不容易把界面上
 *   没展示的字段（status / claimedBy* / closedBy*）悄悄改掉。
 *   基线取的是**界面显示值**（不是库里的原始值），打开再保存不会判定成"改过了"。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');
const dates = require('../../shared/dates');
const C = require('../../shared/constants');
const perm = require('../../shared/perm');

Page({
  data: {
    loading: true,
    /** 不带 id 进来 = 新建 */
    isNew: true,
    /** 需求不存在（或已被删） */
    notFound: false,
    /** 当前用户能否处置这条需求 */
    canEdit: true,
    /** 当前状态（危险区按它切换「关闭」/「重新打开」） */
    status: '',

    form: {
      title: '',
      detail: '',
      contactDept: '',
      contactName: '',
      expectDate: '',
    },
    /** 关闭原因，危险区那个输入框 */
    closeReason: '',
    /** 已关闭时的关闭信息（只读展示用） */
    closedText: '',

    /** 关联任务（只读，两个分支都渲染） */
    tasks: [],

    /** 日期选择器的上限（10 年） */
    maxDate: '',
    minDate: '',

    submitting: false,
  },

  onLoad(options) {
    this.demandId = (options && options.id) || '';
    this.original = null;

    const tenYears = new Date();
    tenYears.setFullYear(tenYears.getFullYear() + 10);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    this.setData({
      isNew: !this.demandId,
      // 日期格式化走 shared/dates.js（format.js 不管日期），与 task-edit 同款
      maxDate: dates.formatDate(tenYears),
      minDate: dates.formatDate(oneYearAgo),
    });
    wx.setNavigationBarTitle({ title: this.demandId ? '需求' : '新建需求' });

    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      const session = await auth.requireClaimed();
      const isAdmin = !!(session.member && session.member.role === C.ROLE.ADMIN);

      if (!this.demandId) {
        // 新建：不拉数据，canEdit 恒为真（所有非只读成员都能建需求）
        this.setData({ loading: false });
        return;
      }

      this.setData({ loading: true });
      const res = await api.demandApi.get(this.demandId);
      const d = res.demand;

      /*
       * get 对不存在的 id 返回 null（不抛错）：列表是几秒前拉的，
       * 点开时刚被别人删掉是正常竞态，不该和"加载失败"混成一句话。
       */
      if (!d) {
        this.setData({ loading: false, notFound: true });
        toast.error('需求不存在或已被删除');
        setTimeout(() => wx.navigateBack(), 1200);
        return;
      }

      const form = {
        title: d.title || '',
        detail: d.detail || '',
        contactDept: d.contactDept || '',
        contactName: d.contactName || '',
        expectDate: d.expectDate || '',
      };
      // 权限判据复用 perm.canEditDemand —— 与云函数同一个函数
      const canEdit = perm.canEditDemand(d, session.openid, isAdmin);

      this.setData({
        loading: false,
        notFound: false,
        canEdit,
        status: d.status || '',
        form,
        closeReason: '',
        closedText: d.status === '已关闭'
          ? `${d.closedByName || '有人'} 关闭${d.closeReason ? ` · ${d.closeReason}` : ''}`
          : '',
        // 关联任务是只读信息，两个分支都渲染 —— 提出人恰恰是最想知道
        // "我提的后来怎么样了"的人，只读分支才有就等于把他排除在外了
        tasks: fmt.decorateTasks(res.tasks || []),
      });

      this.original = form;
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        this.setData({ loading: false });
        // 不能只是 loading:false 收场 —— 界面会显示一份空表单，用户以为需求被清空了
        toast.error('加载失败，请下拉重试');
      }
    }
  },

  // ── 表单 ────────────────────────────────────────────────────────────

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onExpectDateChange(e) {
    this.setData({ 'form.expectDate': e.detail.value });
  },

  onCloseReasonInput(e) {
    this.setData({ closeReason: e.detail.value });
  },

  /** 只提交改动过的字段；没有改动就返回空对象 */
  toPatch() {
    const o = this.original || {};
    const patch = {};
    Object.keys(this.data.form).forEach((k) => {
      const next = String(this.data.form[k] || '').trim();
      if (next !== String(o[k] || '')) patch[k] = next;
    });
    return patch;
  },

  // ── 保存 / 新建 ─────────────────────────────────────────────────────

  async onSave() {
    if (this.data.submitting || !this.data.canEdit) return;

    const title = String(this.data.form.title || '').trim();
    if (!title) {
      toast.toast('请填写需求标题');
      return;
    }

    this.setData({ submitting: true });

    try {
      if (this.data.isNew) {
        await api.demandApi.create(Object.assign({}, this.data.form, { title }));
        toast.success('需求已提交，等着有人认领');
        setTimeout(() => wx.navigateBack(), 900);
        return;
      }

      const patch = this.toPatch();
      if (!Object.keys(patch).length) {
        toast.toast('没有改动');
        this.setData({ submitting: false });
        return;
      }
      await api.demandApi.update(this.demandId, patch);
      toast.success('已保存');
      setTimeout(() => wx.navigateBack(), 900);
    } catch (e) {
      // 失败保留页面，让人改完再试。提示由 api.handleError 统一弹。
      this.setData({ submitting: false });
    }
  },

  // ── 关闭 / 重新打开 ─────────────────────────────────────────────────

  onClose() {
    if (this.data.submitting) return;
    wx.showModal({
      title: '关闭需求',
      content: `关闭「${this.data.form.title}」表示这件事不做了。关闭后仍可以重新打开。`,
      confirmText: '关闭',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.demandApi.close(this.demandId, this.data.closeReason);
          toast.success('需求已关闭');
          setTimeout(() => wx.navigateBack(), 900);
        } catch (e) {
          // 提示由 api.handleError 统一弹
        }
      },
    });
  },

  /**
   * 重新打开。★ 不把本地状态猜成「待认领」——
   * 服务端会按关联任务重算（有未完成任务的回「已领走」），
   * 用它的返回值更新界面，两边才不会各说各话。
   */
  onReopen() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    api.demandApi
      .reopen(this.demandId)
      .then((r) => {
        toast.success('需求已重新打开');
        this.setData({ submitting: false, status: r.status });
        setTimeout(() => wx.navigateBack(), 900);
      })
      .catch(() => {
        this.setData({ submitting: false });
      });
  },

  // ── 关联任务 ────────────────────────────────────────────────────────

  onTaskTap(e) {
    const task = e.detail.task;
    if (!task || !task._id) return;
    wx.navigateTo({ url: `/pages/task-detail/index?taskId=${task._id}` });
  },
});
```

- [ ] **Step 5: 写 `index.wxml`**

```xml
<!--
  pages/demand-edit 新建需求 / 看一条需求

  ★ 一页两态：canEdit 为真走表单，为假走只读摘要。
    判据只有 perm.canEditDemand 一处（云函数用同一个函数）。
  ★ 只读分支里没有任何输入控件、按钮、bindtap —— 不是把表单灰掉。
  ★ 两个 <block> 之间不能夹注释：wx:else 必须紧跟着它的 wx:if。
-->
<view class="page page--with-footer">

  <view wx:if="{{loading}}" class="loading-block">正在加载…</view>

  <block wx:else>
    <block wx:if="{{canEdit}}">
      <!-- ── 基本信息 ──────────────────────────────────────────────── -->
      <view class="card">
        <view class="field">
          <view class="field__label field__label--required">需求标题</view>
          <input
            class="field__input"
            placeholder="一句话说清要办什么事，例如：和财富部聊机场贵宾权益"
            placeholder-class="field__placeholder"
            value="{{form.title}}"
            data-field="title"
            maxlength="100"
            bindinput="onInput"
          />
        </view>

        <view class="field">
          <view class="field__label">需求描述</view>
          <textarea
            class="field__textarea"
            placeholder="背景、想要达到什么效果、已知的限制…（选填）"
            placeholder-class="field__placeholder"
            value="{{form.detail}}"
            data-field="detail"
            maxlength="2000"
            auto-height
            bindinput="onInput"
          />
        </view>
      </view>

      <!-- ── 对接的人（纯文本，不进 members）──────────────────────── -->
      <view class="card">
        <view class="field">
          <view class="field__label">对接部门</view>
          <input
            class="field__input"
            placeholder="例如：财富部（选填）"
            placeholder-class="field__placeholder"
            value="{{form.contactDept}}"
            data-field="contactDept"
            maxlength="50"
            bindinput="onInput"
          />
        </view>

        <view class="field">
          <view class="field__label">对接人</view>
          <input
            class="field__input"
            placeholder="例如：王主任（选填）"
            placeholder-class="field__placeholder"
            value="{{form.contactName}}"
            data-field="contactName"
            maxlength="50"
            bindinput="onInput"
          />
        </view>

        <picker mode="date" value="{{form.expectDate}}" start="{{minDate}}" end="{{maxDate}}" bindchange="onExpectDateChange">
          <view class="field--picker">
            <view class="field__label picker__label">期望时间</view>
            <view class="row">
              <text class="field__value t-mono {{form.expectDate ? '' : 'field__value--empty'}}">
                {{form.expectDate || '未设置'}}
              </text>
              <text class="field__arrow">›</text>
            </view>
          </view>
        </picker>

        <view class="t-muted demand__tip">
          对接部门与对接人是**外部联系人**：他们不进成员名单，也不能被选为主办或协办。
          这里只记"要去找谁聊"。
        </view>
      </view>

      <!-- ── 危险区：关闭 / 重新打开（新建时没有）──────────────────── -->
      <view wx:if="{{!isNew}}" class="card card--flat edit__danger-zone">
        <block wx:if="{{status === '已关闭'}}">
          <view class="t-muted edit__danger-tip">
            {{closedText}}。重新打开后，这条需求会按它名下的任务回到「待认领」或「已领走」。
          </view>
          <button class="btn btn--plain btn--sm edit__state" bindtap="onReopen">重新打开</button>
        </block>
        <block wx:else>
          <view class="t-muted edit__danger-tip">
            关闭表示「这件事先不做了」。关闭后需求仍留在池子里，随时可以重新打开。
          </view>
          <input
            class="field__input"
            placeholder="关闭原因（选填，例如：聊完了，不用做）"
            placeholder-class="field__placeholder"
            value="{{closeReason}}"
            maxlength="200"
            bindinput="onCloseReasonInput"
          />
          <button class="btn btn--plain btn--sm edit__danger" bindtap="onClose">关闭需求</button>
        </block>
      </view>

      <!-- ── 关联任务（只读信息，两个分支共用；编辑态里也摆在最下面）── -->
      <view wx:if="{{tasks.length}}" class="card card--flat">
        <view class="t-sub demand__tasks-title">这条需求名下的任务（{{tasks.length}}）</view>
        <task-card
          wx:for="{{tasks}}"
          wx:for-item="task"
          wx:key="_id"
          task="{{task}}"
          show-leader
          bind:tap="onTaskTap"
        />
      </view>
    </block>

    <block wx:else>
      <!--
        只读：给的是"这条需求是什么"，不是一张改不动的表。
      -->
      <view class="card">
        <view class="row row--between edit__ro-head">
          <text class="t-title ellipsis">{{form.title}}</text>
          <text class="badge {{_statusTone}}">{{_statusText}}</text>
        </view>

        <view class="edit__ro-line">
          <text class="edit__ro-k">提出人</text>
          <text class="edit__ro-v">{{proposerName || '—'}}</text>
        </view>

        <view class="edit__ro-line">
          <text class="edit__ro-k">对接</text>
          <text class="edit__ro-v">{{_contactText || '—'}}</text>
        </view>

        <view class="edit__ro-line">
          <text class="edit__ro-k">期望时间</text>
          <text class="edit__ro-v t-mono">{{form.expectDate || '未设置'}}</text>
        </view>

        <view wx:if="{{form.detail}}" class="t-muted edit__ro-detail">{{form.detail}}</view>
      </view>

      <view wx:if="{{tasks.length}}" class="card card--flat">
        <view class="t-sub demand__tasks-title">这条需求名下的任务（{{tasks.length}}）</view>
        <task-card
          wx:for="{{tasks}}"
          wx:for-item="task"
          wx:key="_id"
          task="{{task}}"
          show-leader
          bind:tap="onTaskTap"
        />
      </view>

      <view class="card card--flat edit__tip">
        <view class="t-sub">这条需求不是你提的、也不是你领的，只能查看。</view>
      </view>
    </block>
  </block>
</view>

<view wx:if="{{canEdit}}" class="footer-bar">
  <button
    class="btn btn--primary"
    loading="{{submitting}}"
    disabled="{{submitting}}"
    bindtap="onSave"
  >{{isNew ? '提交需求' : '保存修改'}}</button>
</view>
```

> 只读分支用到的 `_statusTone` / `_statusText` / `_contactText` / `proposerName` 需要进 `data`。
> 在 `refresh` 的编辑分支里补上：把 `res.demand` 经 `fmt.decorateDemand` 后展开进 data：

```js
      const decorated = fmt.decorateDemand(d);
      this.setData({
        // ...
        _statusTone: decorated._statusTone,
        _statusText: decorated._statusText,
        _contactText: decorated._contactText,
        _expectText: decorated._expectText,
        proposerName: d.proposerName || '',
      });
```

并在 `data` 里给这五个字段初值（`_statusTone: 'idle'`、其余空串）。**只读摘要里的「期望时间」改用 `_expectText`**，与需求卡同一口径：

```xml
          <text class="edit__ro-v t-mono">{{_expectText || '未设置'}}</text>
```

（把 `form.expectDate` 那一行替换掉。）

- [ ] **Step 6: 写 `index.wxss`**

```css
/*
 * pages/demand-edit
 * ★ 表单字段与危险区样式全部复用 app.wxss 的通用件（.card / .field /
 *   .edit__ro-* / .edit__danger-*），本页只加"这一页才有"的两条：
 *   说明文字与关联任务小标题的间距。
 */

.demand__tip {
  margin-top: 16rpx;
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.demand__tasks-title {
  margin-bottom: 16rpx;
}
```

> `.edit__ro-head` / `.edit__ro-line` / `.edit__ro-k` / `.edit__ro-v` / `.edit__ro-detail` / `.edit__tip` / `.edit__danger-zone` / `.edit__danger-tip` / `.edit__state` / `.edit__danger` 目前定义在 `pages/plan-edit/index.wxss`，**页面 WXSS 不跨页**。做法：把这十条规则从 `pages/plan-edit/index.wxss` **原样剪切**到 `miniprogram/app.wxss` 的「组件类」一节末尾（与 `.member` 那次"两页共用只能上提"同一处处理），`plan-edit` 页面什么都不用改。这是本任务必须做的一步，漏了本页就只剩裸样式。

- [ ] **Step 7: 注册路由**

在 `miniprogram/app.json` 的 `pages` 数组末尾（现在是 `"pages/person-detail/index"`）加**一行**：

```json
    "pages/person-detail/index",
    "pages/demand-edit/index"
```

> ★ **本步只加这一行**。`pages/demands/index` 的文件要到 Task 11 才建，
> 现在就写进 `pages` 会让开发者工具编译报「找不到页面」。
> `tabBar.list` 这一节也一律不动 —— 本页不是 tab 页。

> 加完之后这一页就能导航了，但**还没有任何页面指向它**：Task 10 让 task-create
> 支持关联需求，Task 11 才让需求池列表跳过来。中间这几步里它只能靠
> 开发者工具的「编译模式 → 指定页面路径」直接打开，这正是刻意的 ——
> 任何一步中断，App 都不会处于"点一下就报错"的状态。

- [ ] **Step 8: 跑测试，确认通过**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-page.js"`
Expected: PASS —— 10 条断言全绿。

Run: `node scripts/selfcheck.js`
Expected: PASS，`失败 0 项`

- [ ] **Step 9: 提交**

```bash
git add miniprogram/pages/demand-edit miniprogram/app.json miniprogram/app.wxss miniprogram/pages/plan-edit/index.wxss
git commit -m "feat(demand): pages/demand-edit —— 新建需求与看改一体（.edit__* 通用件上提到 app.wxss）"
```

---

## Task 10: `task-create` 的来源 = 需求池时选需求

**Files:**
- Modify: `miniprogram/pages/task-create/index.js`
- Modify: `miniprogram/pages/task-create/index.wxml`
- Modify: `miniprogram/pages/task-create/index.wxss`

**Interfaces:**
- Consumes: `api.demandApi.list()`、`api.taskApi.create(task, token, demandId)`
- Produces: `pages/task-create/index?demandId=xxx` 的预填与锁定行为

- [ ] **Step 1: 写失败的测试**

在 `C:\Users\Administrator\AppData\Local\Temp\tp-demand-page.js` 里追加一段（复用同一个 `loadPage` 辅助）：

```js
// ① 来源=需求池 且 没选需求 → 前端拦住，不发请求
// ② 来源=需求池 且 选了需求 → taskApi.create 收到第三个参数 = 需求 id
// ③ 来源≠需求池 → 即使 data.demandId 有值也不传（防脏数据）
// ④ ★ ?demandId=xxx 进来：来源锁死「需求池」、需求预选好、
//    task_name 与 detail 用需求的 title/detail 预填
// ⑤ ★ 预填不覆盖用户已输入的内容（先调 onInput 再让 init 跑完 → 值还是用户的）
// ⑥ ★ ?demandId=xxx 指向一条已被领走 / 不存在的需求 → 不锁死、不预填，
//    给一句提示（而不是让用户建出一条指向别人的任务）
// ⑦ isPlan 为真时需求选择器不出现，提交也不带 demandId
// ⑧ ★ demandApi.list() 抛错时：demandLoadFailed=true、协办人列表**仍然是全的**、
//    提交照样能成功（只是不带 demandId）、提示说的是"没加载出来"而不是"已被领走"
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-page.js"`
Expected: FAIL —— 断言 ①②③ 红（`demandApi` 从没被调用，`demandId` 参数是 undefined）。

- [ ] **Step 3: 改 `index.js`**

`data` 里加：

```js
    // ── 关联需求（来源 = 需求池时才出现）─────────────────────────────
    /**
     * 可选的「待认领」需求。★ 只列待认领的：已领走/已关闭的需求
     * 由云函数拒（claimDemand 的条件里带 status），摆出来只会让人白填一屏。
     */
    demandOptions: [],
    /** 选中的需求 _id。'' 表示没选 */
    demandId: '',
    /** 选中的需求标题（picker 的 range-key 读它，页面外也用来做摘要） */
    demandTitle: '',
    /**
     * 从需求池点进来时锁死：来源不可改、需求不可换。
     * ★ 锁死的不是"体验问题"—— 换一条需求就等于领走另一条，
     *   与用户点进来的意图不符。
     */
    demandLocked: false,
    /** 需求池没拉回来（服务未部署 / 网络失败）。与"池子是空的"要分开说 */
    demandLoadFailed: false,
```

`onLoad` 里记下入参：

```js
  onLoad(options) {
    this.presetDemandId = (options && options.demandId) || '';
    // ...原有代码不动
  },
```

把 `init()` 里现有的那一整块 `this.setData({ leaderId: session.openid, ... })` **整体替换**成下面这段（在 `setData` 之前先把待认领需求拉回来）：

```js
      /*
       * ── 关联需求：只列「待认领」的 ──────────────────────────────────
       *
       * ★ 单独 try/catch，不能和上面的成员加载共用一个 catch：
       *   需求池拉不到（比如 cloudfunctions/demandService 还没部署完）
       *   只该让「关联需求」这一块空着，绝不能让协办人列表跟着变空 ——
       *   那会让人以为"团队里没人了"，而且建任务照样能建（只是不带 demandId）。
       */
      let pending = [];
      let demandLoadFailed = false;
      try {
        const demandRes = await api.demandApi.list();
        pending = (demandRes.list || []).filter((d) => d.status === '待认领');
      } catch (e) {
        console.error('[task-create] 需求池加载失败', e);
        demandLoadFailed = true;
      }

      const patch = {
        leaderId: session.openid,
        leaderName: session.member.name,
        canPickLeader: isAdmin,
        leaderCandidates: claimed.slice().sort((a, b) => {
          if (a.openid === session.openid) return -1;
          if (b.openid === session.openid) return 1;
          return 0;
        }),
        allMembers: claimed.filter((m) => m.openid !== session.openid),
        demandOptions: pending,
        demandLoadFailed,
      };

      /*
       * 从需求池点进来（?demandId=xxx）：来源锁死、需求预选、名字与描述预填。
       *
       * ★ 三条都要判：需求存在 且 仍是「待认领」。
       *   已被别人领走的需求（点进来那一刻的竞态）绝不能锁死并预填 ——
       *   否则用户会填一整屏、提交时才被云函数拒，或者更糟：
       *   建出一条自己以为领走了、其实指向别人的任务。
       */
      const preset = pending.find((d) => d._id === this.presetDemandId);
      if (preset) {
        patch['form.source'] = '需求池';
        patch.demandId = preset._id;
        patch.demandTitle = preset.title;
        patch.demandLocked = true;
        // 预填**不覆盖**用户已经输入的内容（onLoad 到 init 之间可能已经打过字）
        if (!this.data.form.task_name) patch['form.task_name'] = preset.title;
        if (!this.data.form.detail) patch['form.detail'] = preset.detail || '';
      } else if (this.presetDemandId && !demandLoadFailed) {
        // ★ 只有"确实拿到了列表、但里面没有这条"才敢说它被领走了。
        //   列表本身没拉到时 pending 也是空的 —— 那种情况说"已被领走"
        //   是在编造一个不存在的事实，而且用户照做去重选也选不出东西来。
        toast.error('这条需求已被领走或已关闭，请回需求池另选一条');
      } else if (demandLoadFailed) {
        toast.error('需求池没加载出来，请稍后重进本页');
      }

      this.setData(patch);
```

加两个 handler：

```js
  /** 选了哪条待认领的需求 */
  onDemandChange(e) {
    const d = this.data.demandOptions[Number(e.detail.value)];
    if (!d) return;
    this.setData({ demandId: d._id, demandTitle: d.title });
  },

  /** 清空选择 —— 只在不锁死时才允许 */
  onClearDemand() {
    if (this.data.demandLocked) return;
    this.setData({ demandId: '', demandTitle: '' });
  },
```

`onEnumChange` 里，来源改成非「需求池」时清掉关联（避免留下指向一条需求、却被提交成别的来源的脏状态）：

```js
  onEnumChange(e) {
    const { field, value } = e.detail;
    const patch = { [`form.${field}`]: value };
    if (field === 'recur_freq' && value === '不适用') {
      patch['form.recur_rule'] = '';
    }
    if (field === 'task_type') {
      patch.isPlan = value === '周期性';
    }
    // ★ 来源一改成别的，关联就作废：留着会在提交时带出一条"来源不是需求池、
    //   却挂着 demandId"的任务（它会把那条需求误标成已领走）
    if (field === 'source' && value !== '需求池' && !this.data.demandLocked) {
      patch.demandId = '';
      patch.demandTitle = '';
    }
    this.setData(patch);
    if (field === 'task_type') {
      wx.setNavigationBarTitle({ title: this.data.isPlan ? '新建计划' : '新建任务' });
    }
  },
```

`onSubmit` 里加校验与透传：

```js
    if (!form.due_date) {
      toast.toast('请选择计划截止时间');
      return;
    }
    // ★ 来源选了「需求池」就必须指定要关联哪一条 —— 云函数那边也会拒，
    //   这里拦一道是为了别让用户白填一整屏
    if (form.source === '需求池' && !this.data.demandId) {
      toast.toast('请选择要关联的需求');
      return;
    }
```

```js
      const myOpenid = auth.currentOpenid();
      // 只有来源确实是「需求池」时才把 demandId 传上去
      const demandId = form.source === '需求池' ? this.data.demandId : '';

      if (canPickLeader && leaderId && leaderId !== myOpenid) {
        await api.taskApi.adminCreate(leaderId, task, this.data.token, demandId);
      } else {
        await api.taskApi.create(task, this.data.token, demandId);
      }
```

- [ ] **Step 4: 改 `index.wxml`**

在「任务来源」那个 `field-picker` 之后、`任务性质` 之前插入：

```xml
    <!--
      来源 = 需求池时才出现：必须指定关联哪一条待认领的需求。
      「领走」不是另一个按钮，而是"就这条需求建一个任务"这个动作本身 ——
      多一个"领走"按钮再接一层表单，等于同一个意图点两次。
      ★ !isPlan：计划不关联需求（计划是模板，没有"领走"这回事）
    -->
    <block wx:if="{{!isPlan && form.source === '需求池'}}">
      <block wx:if="{{demandLocked}}">
        <view class="field--picker">
          <view class="field__label field__label--required picker__label">关联需求</view>
          <view class="row">
            <text class="field__value ellipsis">{{demandTitle}}</text>
            <text class="tag create__self-tag">已选定</text>
          </view>
        </view>
      </block>
      <block wx:else>
        <picker mode="selector" range="{{demandOptions}}" range-key="title" bindchange="onDemandChange">
          <view class="field--picker">
            <view class="field__label field__label--required picker__label">关联需求</view>
            <view class="row">
              <text class="field__value {{demandId ? '' : 'field__value--empty'}}">
                {{demandTitle || '请选择要认领的需求'}}
              </text>
              <text class="field__arrow">›</text>
            </view>
          </view>
        </picker>
        <!--
          「池子空了」和「没拉到」必须分开说：前者让用户去建一条，
          后者是加载失败（下拉重试就好），说成"没有需求"会把人支使去做无用功。
        -->
        <view wx:if="{{demandLoadFailed}}" class="t-muted create__tip">
          需求池没加载出来。可以直接提交（这条任务就不关联需求），或稍后重进本页。
        </view>
        <view wx:elif="{{!demandOptions.length}}" class="t-muted create__tip">
          需求池里暂时没有待认领的需求。可以先到「领需求」页建一条，或者把来源改成别的。
        </view>
      </block>
    </block>
```

- [ ] **Step 5: 改 `index.wxss`**

如果 `.create__tip` 还没有 `margin-top`，补一条（其余不用动）：

```css
.create__tip {
  margin-top: 16rpx;
  font-size: var(--fs-caption);
  line-height: 1.6;
}
```

- [ ] **Step 6: 跑测试，确认通过**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-page.js"`
Expected: PASS —— 7 条新断言全绿，Task 9 的 10 条仍然绿。

Run: `node scripts/selfcheck.js`
Expected: PASS，`失败 0 项`

- [ ] **Step 7: 提交**

```bash
git add miniprogram/pages/task-create
git commit -m "feat(demand): 新建任务时来源选「需求池」则必须关联一条待认领的需求"
```

---

## Task 11: `pages/demands` 与 tabBar 第五格

**Files:**
- Create: `miniprogram/pages/demands/index.js` / `.wxml` / `.wxss` / `.json`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/custom-tab-bar/index.js`
- Modify: `miniprogram/pages/report/index.js`、`update/index.js`、`board/index.js`、`people/index.js`
- Modify: `scripts/gen-tabbar-icons.js`
- Test: `C:\Users\Administrator\AppData\Local\Temp\tp-demand-page.js`

**Interfaces:**
- Consumes: `api.demandApi.list()`、`fmt.decorateDemands`、`auth.isViewer()`、`utils/swipe`
- Produces: 路由 `/pages/demands/index`；`getTabBar().sync(pagePath)`

- [ ] **Step 1: 写失败的测试**

在 `C:\Users\Administrator\AppData\Local\Temp\tp-demand-page.js` 里追加：

```js
// ① viewFor 的四个分段：待认领 / 我领的 / 我提的 / 已关闭
// ② ★ 同一条需求可以同时落进「我提的」和「我领的」——
//    两个分段问的是两个不同问题，不去重
// ③ 分段计数与列表长度一致（每段逐个数一遍）
// ④ 点「待认领」的卡片 → navigateTo 到 task-create 且带上 demandId
// ⑤ ★ 管理者点「待认领」的卡片 → 不跳转，提示「管理者账号只有查看权限」
// ⑥ 点「我提的 / 我领的 / 已关闭」的卡片 → navigateTo 到 demand-edit?id=
// ⑦ 点「新建需求」→ navigateTo 到 demand-edit（不带 id）
// ⑧ ★ syncTabBar 传给 custom-tab-bar 的是**路径**，不是下标
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-page.js"`
Expected: FAIL —— `Cannot find module '.../pages/demands/index.js'`。

- [ ] **Step 3: 写 `miniprogram/pages/demands/index.js`**

```js
/**
 * pages/demands —— Tab「领需求」
 * ---------------------------------------------------------------------------
 * 需求角度的列表。四个分段，各自问一个问题：
 *   待认领  谁该把这件事接过去（点卡片 = 直接去建任务，那就是"领走"）
 *   我领的  我手上还有哪些从池子里接过来的事
 *   我提的  我提的那些后来怎么样了
 *   已关闭  决定不做的事，留个记录
 *
 * ★ 一条需求可能同时出现在两个分段里（我提的、又是我领的），**这是对的**：
 *   两个分段问的是两个不同问题，不去重。
 *
 * ★ 「领走」不是一个按钮，而是"就这条需求建一个任务"这个动作本身。
 *   多一个"领走"按钮再接一层建任务表单，等于同一个意图点两次。
 *
 * ★ 管理者（只读）在这里能看、能新建，但**领不走** —— 领走 = 建任务，
 *   而 taskService.create 的第一步仍是 requireWriter()。所以对他把
 *   「待认领」的点击换成一个说明，而不是让他跳过去被云函数拒。
 *
 * ★ 视图计算与 setData 分离（viewFor 纯函数 + paint 单次写）：
 *   理由与 pages/board 完全一致，见那里的长篇注释（2026-10-03 那一帧错配）。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');
const swipe = require('../../utils/swipe');
const toast = require('../../utils/toast');

/** 本页在 custom-tab-bar 的 TABS 里的路径（不再传下标，见 custom-tab-bar/index.js） */
const TAB_PATH = '/pages/demands/index';

/** 默认落在哪个分段。「等着认领」是这个页面存在的理由 */
const DEFAULT_SEG = '待认领';

/** 分段列表，顺序即渲染顺序 */
const SEGMENTS = ['待认领', '我领的', '我提的', '已关闭'];

/**
 * 该需求是否属于某个分段。
 * ★ 四个分段各是一条独立判据（不是一个枚举字段的四个取值）——
 *   「我领的」与「我提的」可能同时为真，所以这里不能用 switch 式的互斥判断。
 */
function inSegment(d, seg, openid) {
  if (seg === '待认领') return d.status === '待认领';
  if (seg === '已关闭') return d.status === '已关闭';
  if (!openid) return false;
  if (seg === '我领的') return d.claimedById === openid;
  if (seg === '我提的') return d.proposerId === openid;
  return false;
}

/**
 * 算出「页面该长什么样」：分段计数、当前分段的内容、空态文案、信息块数字。
 *
 * ★ 纯函数：不碰 setData，也不读 this.data（全靠入参）。调用方必须把它的
 *   结果与触发它的那批状态**同一次 setData** 写下去 —— 见 Page.paint。
 */
function viewFor(allDemands, segmentTab, openid) {
  const tabs = SEGMENTS.map((seg) => ({
    seg,
    count: allDemands.filter((d) => inSegment(d, seg, openid)).length,
  }));

  // 排序沿用服务端给的 createdAt 倒序（listAllDemands 里排好的），
  // 不在前端重排：四个分段用同一个顺序，切来切去不会跳位置。
  const rows = allDemands.filter((d) => inSegment(d, segmentTab, openid));

  const EMPTY = {
    待认领: { title: '池子里没有等着认领的需求', hint: '点下面的「新建需求」把想法记下来' },
    我领的: { title: '你还没有从池子里领过需求', hint: '到「待认领」挑一条，点开就能建任务' },
    我提的: { title: '你还没有提过需求', hint: '点下面的「新建需求」把想法记下来' },
    已关闭: { title: '没有已关闭的需求', hint: '关闭表示「这件事先不做了」，随时可以重新打开' },
  };

  return {
    tabs,
    rows,
    empty: EMPTY[segmentTab] || { title: '这一段下没有需求', hint: '上方可以切换分段' },
    stats: {
      total: allDemands.length,
      pending: allDemands.filter((d) => d.status === '待认领').length,
      mine: allDemands.filter((d) => inSegment(d, '我领的', openid)).length,
      proposed: allDemands.filter((d) => inSegment(d, '我提的', openid)).length,
    },
  };
}

Page({
  data: {
    loading: true,
    /** 当前分段 */
    segmentTab: DEFAULT_SEG,
    /** 分段上的计数：[{seg, count}]，顺序跟随 SEGMENTS */
    tabs: [],
    /** 当前分段要渲染的需求 */
    rows: [],
    /** 空态文案，由 viewFor 按当前分段算好 */
    empty: { title: '', hint: '' },
    /** 汇总数字，信息块用 */
    stats: { total: 0, pending: 0, mine: 0, proposed: 0 },
    /** 全部需求的原始集合，切分段从它重建，不重新查库 */
    allDemands: [],
  },

  onLoad() {
    api.setClaimHandler(() => auth.gotoClaim(true));
    this.segmentInitialized = false;
  },

  /** 把选中态告诉自定义 tabBar。★ 传的是路径，不是下标 —— 页签顺序变了也不会错 */
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
      await auth.requireClaimed();
    } catch (e) {
      return;
    }

    // 身份到手后再同步一次：onShow 那刻 bootstrap 可能还没回来
    this.syncTabBar();
    const openid = auth.currentOpenid();

    try {
      if (!this.data.allDemands.length) this.setData({ loading: true });

      const res = await api.demandApi.list();
      const all = fmt.decorateDemands(res.list || []);

      const patch = { allDemands: all, loading: false };
      // ★ 只在首次落数据时挑默认分段：之后用户手动切过哪个就停在哪个，
      //   不能每次下拉刷新都把他弹回去
      if (!this.segmentInitialized) {
        this.segmentInitialized = true;
        patch.segmentTab = pickInitialSegment(all, openid);
      }
      this.paint(patch);
    } catch (e) {
      console.error('[demands] 拉取失败', e);
      this.setData({ loading: false });
      toast.error('加载需求池失败，请下拉重试');
    }
  },

  /**
   * 一次 setData 把「状态」和「由状态算出的视图」一起写下去。
   * ★ 为什么不能分两次写：两次之间会留下一帧「标签已是新分段、列表还是上一段」
   *   的错配 —— 2026-10-03 任务看板上实测过这个 bug，用户的原话是
   *   「看板整体错乱、点也点不开」。一次写下去就永远是自洽的。
   */
  paint(patch, cb) {
    const s = Object.assign({}, this.data, patch);
    this.setData(
      Object.assign({}, patch, viewFor(s.allDemands, s.segmentTab, auth.currentOpenid())),
      cb
    );
  },

  /** 切分段。点标签与横滑两条路都走这里，只有一个出口 */
  goSegment(seg) {
    if (!seg || seg === this.data.segmentTab) return;
    this.paint({ segmentTab: seg }, () => {
      // 各分段长短不一，停在上一段的滚动位置会一眼看到空白或半截列表
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    });
  },

  onSegmentTap(e) {
    this.goSegment(e.currentTarget.dataset.segment);
  },

  // ── 横滑（与 pages/board 同一套，判据在 utils/swipe.js）────────────

  onTouchStart(e) {
    const t = e.touches && e.touches[0];
    this.swipeStart = t ? { x: t.clientX, y: t.clientY } : null;
    this.swipeAxis = '';
  },

  onTouchMove(e) {
    if (!this.swipeStart || this.swipeAxis) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    // ★ 只认**首动方向**，定下就锁定：终点坐标分不清"斜着横滑"和"斜着往下滚"
    this.swipeAxis = swipe.axisOf(this.swipeStart, { x: t.clientX, y: t.clientY });
  },

  onTouchCancel() {
    this.swipeStart = null;
    this.swipeAxis = '';
  },

  onTouchEnd(e) {
    const start = this.swipeStart;
    const axis = this.swipeAxis;
    this.swipeStart = null;
    this.swipeAxis = '';
    if (!start || axis !== 'x') return;
    // ★ touchend 时手指已经抬起，e.touches 是空的 —— 必须用 changedTouches
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const step = swipe.swipeStep(start, { x: t.clientX, y: t.clientY });
    if (!step) return;
    this.goSegment(swipe.stepIn(SEGMENTS, this.data.segmentTab, step));
  },

  // ── 点击 ────────────────────────────────────────────────────────────

  /**
   * 点一张需求卡。
   * ★ 「待认领」段点开的是**建任务页**（那一步就是领走）；
   *   其余三段点开的是需求详情（看改一体，由那一页自己判 canEdit）。
   * ★ 管理者在「待认领」段点不动：领走 = 建任务，而那条路对他关着。
   *   前端拦住只是体验，云函数那边由 taskService.create 的 requireWriter 兜住。
   */
  onCardTap(e) {
    const d = e.currentTarget.dataset.demand;
    if (!d || !d._id) return;

    if (this.data.segmentTab === '待认领') {
      if (auth.isViewer()) {
        toast.toast('管理者账号只有查看权限，领需求请联系同事');
        return;
      }
      wx.navigateTo({ url: `/pages/task-create/index?demandId=${d._id}` });
      return;
    }
    wx.navigateTo({ url: `/pages/demand-edit/index?id=${d._id}` });
  },

  /** 新建需求。不带 id 进 demand-edit，那一页落在"新建"态 */
  onNewTap() {
    wx.navigateTo({ url: '/pages/demand-edit/index' });
  },
});

/**
 * 挑首次进入时落在哪个分段。
 * 优先「待认领」（这个页面存在的理由）；它空了就落到第一个有内容的分段。
 * 不这么做的话，池子清空的那段时间一进来就是一片空白。
 */
function pickInitialSegment(demands, openid) {
  const countOf = (seg) => demands.filter((d) => inSegment(d, seg, openid)).length;
  if (countOf(DEFAULT_SEG) > 0) return DEFAULT_SEG;
  const first = SEGMENTS.find((s) => countOf(s) > 0);
  return first || DEFAULT_SEG;
}
```

- [ ] **Step 4: 写 `index.wxml`**

```xml
<!--
  pages/demands Tab「领需求」

  ★ 结构照 pages/board：信息块 → 分段切换 → 单一纵向列表 → 底部入口卡。
  ★ 支持横向滑动切换分段（判据在 utils/swipe.js，与任务看板共用一份实现）。
  ★ 分段标签是 3 个汉字 + 一位计数，共 4 项 —— 若在开发者工具里看到挤，
    把计数挪到分段上方的胶囊行里（任务看板已有 .pill 那种写法），
    **不要压字号**（见 spec §3）。
-->
<view
  class="page page--tabbar"
  bindtouchstart="onTouchStart"
  bindtouchmove="onTouchMove"
  bindtouchcancel="onTouchCancel"
  bindtouchend="onTouchEnd"
>

  <!-- ── 信息块：这一屏回答"池子里还有多少事没人接" ─────────────── -->
  <view class="summary">
    <view class="summary__value">
      {{stats.pending}}<text class="summary__unit">条等着认领</text>
    </view>
    <view class="summary__stats">
      <text>我领的 {{stats.mine}}</text>
      <text>我提的 {{stats.proposed}}</text>
    </view>
  </view>

  <!-- ── 分段切换（带计数，支持左右滑）─────────────────────────── -->
  <view class="seg demands__seg">
    <view
      wx:for="{{tabs}}"
      wx:key="seg"
      class="seg__item {{segmentTab === item.seg ? 'seg__item--on' : ''}} hit"
      data-segment="{{item.seg}}"
      bindtap="onSegmentTap"
    >
      <text>{{item.seg}}</text>
      <text class="seg__count">{{item.count}}</text>
    </view>
  </view>

  <view wx:if="{{loading}}" class="loading-block">正在加载需求池…</view>

  <block wx:else>
    <view wx:if="{{rows.length}}">
      <view
        wx:for="{{rows}}"
        wx:for-item="d"
        wx:key="_id"
        class="card demand hit"
        data-demand="{{d}}"
        bindtap="onCardTap"
      >
        <view class="demand__head">
          <text class="demand__title">{{d.title}}</text>
          <text class="badge {{d._statusTone}}">{{d._statusText}}</text>
        </view>

        <view wx:if="{{d._contactText || d._expectText}}" class="demand__meta">
          <text wx:if="{{d._contactText}}">{{d._contactText}}</text>
          <text wx:if="{{d._expectText}}" class="t-mono">{{d._expectText}}</text>
        </view>

        <!-- 已关闭的那一段，把关闭原因摆出来 —— 它是"为什么不做"的唯一记录 -->
        <view wx:if="{{d.status === '已关闭' && d.closeReason}}" class="t-muted demand__reason">
          {{d.closeReason}}
        </view>

        <view class="demand__foot">
          <text>{{d.proposerName || '—'}} 提出</text>
          <text>{{d._createdText}}</text>
          <text wx:if="{{d.claimedByName}}" class="demand__claimed">已由 {{d.claimedByName}} 领走</text>
        </view>
      </view>
    </view>

    <empty-state wx:else title="{{empty.title}}" hint="{{empty.hint}}" />

    <!--
      新建需求入口。★ 摆在列表**之后**（与报任务的「新加入协办」入口卡同款）：
        摆在列表前会把第一张卡片顶到屏幕外，而这一段的列表才是主角。
    -->
    <view class="card card--flat entry-card hit" bindtap="onNewTap">
      <view class="row row--between">
        <view class="flex-1">
          <text class="t-title">新建需求</text>
          <view class="t-muted entry-card__hint">还没成形的事先记在这里，等有人认领</view>
        </view>
        <text class="field__arrow">›</text>
      </view>
    </view>
  </block>
</view>
```

- [ ] **Step 5: 写 `index.wxss`**

```css
/*
 * pages/demands Tab「领需求」
 * ★ 卡片是本页专属的形态（需求不是任务，不能塞进 task-card），
 *   所以样式留在本页；状态徽标复用 app.wxss 的 .badge--{tone}。
 */

/* 分段与列表之间留出间距。分段本身在 app.wxss（.seg） */
.demands__seg {
  margin-bottom: var(--gap);
}

.demand__head {
  display: flex;
  align-items: flex-start;
  gap: 16rpx;
}

.demand__title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  line-height: 1.4;
  color: var(--text);
}

/* 对接人与期望时间：次要信息，一行放不下就换行 */
.demand__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6rpx 24rpx;
  margin-top: 14rpx;
  font-size: var(--fs-sub);
  color: var(--text-sub);
}

.demand__reason {
  margin-top: 12rpx;
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.demand__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 6rpx 20rpx;
  margin-top: 16rpx;
  padding-top: 16rpx;
  border-top: 2rpx solid var(--divider);
  font-size: var(--fs-caption);
  color: var(--muted);
}

.demand__claimed {
  color: var(--tone-warn);
}

.entry-card__hint {
  margin-top: 8rpx;
  font-size: var(--fs-caption);
}
```

- [ ] **Step 6: 写 `index.json`**

```json
{
  "navigationBarTitleText": "领需求",
  "enablePullDownRefresh": true,
  "usingComponents": {
    "empty-state": "/components/empty-state/index"
  }
}
```

- [ ] **Step 7: 改 `miniprogram/custom-tab-bar/index.js`**

`TABS` 头部插入一项（**「领需求」放在最前面**，与 spec §3 的页签顺序一致），并把 `sync` 从下标改成路径：

```js
const TABS = [
  /*
   * ★ write 的含义是「管理者能不能用这一格」——
   *   sync() 会把它翻译成 disabled，对管理者置灰。
   *   「领需求」是 write: false：管理者能看、也能新建需求。
   *   他领不走（领走 = 建任务，那条路仍走 requireWriter），
   *   但"进不去这一页"和"进去了有些事做不了"是两回事 ——
   *   前者会让整个需求池对他消失，那不是本次放开的宽度。
   */
  { pagePath: '/pages/demands/index', text: '领需求', icon: 'demand', write: false },
  { pagePath: '/pages/report/index', text: '报任务', icon: 'report', write: true },
  { pagePath: '/pages/update/index', text: '改任务', icon: 'update', write: true },
  { pagePath: '/pages/board/index', text: '任务看板', icon: 'board', write: false },
  { pagePath: '/pages/people/index', text: '人员看板', icon: 'people', write: false },
];
```

`sync` 方法改成按路径找下标，同时把 `attached()` 的调用改掉：

```js
    /**
     * 同步选中态。
     *
     * ★ 参数是**页面路径**，不是下标。
     *   过去四个 tab 页各自硬编码了自己的下标（0/1/2/3，共 8 处调用），
     *   在头部插入一格会让这 8 处全部错位 —— 而错位的表现是"点进 A 页面、
     *   B 页签亮着"：一个不报错、但一眼就能看出不对的 bug。
     *   改成按路径找下标之后，下次再加 tab 也不用再手改任何一个数字。
     *
     * ★ 路径记在实例上：Component 的 attached 早于任何页面调它，
     *   那一次没有路径可传，得沿用上一次（首次为空串 → findIndex 得 -1 → 0）。
     */
    sync(pagePath) {
      if (pagePath) this._pagePath = pagePath;
      const isViewer = auth.isViewer();
      const tabs = TABS.map((t) => Object.assign({}, t, { disabled: isViewer && t.write }));
      const i = TABS.findIndex((t) => t.pagePath === this._pagePath);
      this.setData({ selected: i < 0 ? 0 : i, tabs });
    },
```

`attached()` 里的 `this.sync(this.data.selected)` 改成无参：

```js
  attached() {
    // 没有路径可传：这一趟只是把 tabs 渲染出来（含按下角色算好的 disabled），
    // 选中态等页面 onShow 推过来。首次落 0 是刻意的兜底。
    this.sync();
  },
```

同文件里 `TABS` 上方那段 JSDoc 现在写的是「四个页签」和「顺序必须与 app.json 的 tabBar.list 完全一致（**下标就是选中态**）」—— 两句都过期了：现在是五个，而且选中态不再靠下标。改成：

```js
/**
 * 五个页签。write 标记"这一页是在写业务数据"——
 * 只读角色点它没有意义，所以置灰。
 * ★ 顺序仍必须与 app.json 的 tabBar.list 一致（两处顺序不一致时，
 *   页签的展示顺序与微信路由器认的顺序会对不上）。
 *   但选中态已经不靠下标了：sync 按 pagePath 找，见下面的方法注释。
 */
```

- [ ] **Step 8: 改四个老 tab 页的 `syncTabBar`**

四个页面各自把方法改成无参 + 传路径。以 `pages/report/index.js` 为例：

```js
/** 本页在 custom-tab-bar 的 TABS 里的路径（见 custom-tab-bar/index.js） */
const TAB_PATH = '/pages/report/index';
```

```js
  /** 把选中态告诉自定义 tabBar（传路径，不传下标 —— 见 custom-tab-bar/index.js 的 sync） */
  syncTabBar() {
    const bar = this.getTabBar && this.getTabBar();
    if (bar && bar.sync) bar.sync(TAB_PATH);
  },
```

然后把该页里所有 `this.syncTabBar(0)` 改成 `this.syncTabBar()`。四页的 `TAB_PATH` 分别是：

| 页面 | TAB_PATH | 原来的下标 |
|---|---|---|
| `pages/report/index.js` | `/pages/report/index` | 0 |
| `pages/update/index.js` | `/pages/update/index` | 1 |
| `pages/board/index.js` | `/pages/board/index` | 2 |
| `pages/people/index.js` | `/pages/people/index` | 3 |

**逐个确认改干净**：

Run: `grep -rn "syncTabBar(" miniprogram/pages/`
Expected: 只剩方法定义行（`syncTabBar() {`）与无参调用 `this.syncTabBar()`，**没有任何 `syncTabBar(` 后面跟着数字**。

- [ ] **Step 9: 生成「领需求」图标**（必须在注册页签**之前** —— app.json 一旦指向还不存在的 PNG，开发者工具直接编译不过）

在 `scripts/gen-tabbar-icons.js` 里，`ICON_PEOPLE` 之后加（顺手把上方那句「四个图标」的注释改成「五个图标」）：

```js
/*
 * 领需求：向下的箭头 + 托盘（"放进池子里 / 领走"）。
 *
 * ★ 与「报任务」的文档框刻意区分：那个是**竖长的纸 + 对勾**，
 *   这个是**横宽的托盘 + 箭头**，轮廓一横一竖，缩到 81px 也不会看混。
 * ★ 与「任务看板」的分栏框也区分得开：那个是 42×36 的框 + 两条竖线，
 *   这里是一条横托盘 + 一个箭头，没有内部分栏。
 */
const ICON_DEMAND = union(
  lineStroke([[40.5, 19], [40.5, 41]], W),
  lineStroke([[32, 32.5], [40.5, 41.5], [49, 32.5]], W),
  rrStroke(40.5, 54, 17.5, 7, 5, W)
);
```

`ICONS` 数组头部加一项：

```js
const ICONS = [
  ['demand', ICON_DEMAND, '领需求'],
  ['report', ICON_REPORT, '报任务'],
  ...
```

末尾那行计数改掉：

```js
  console.log('\n✓ 已生成 10 个图标 → miniprogram/images/tabbar/');
```

然后**执行它**（这个脚本是刻意要跑的，它会写 `miniprogram/images/tabbar/*.png`）：

Run: `node scripts/gen-tabbar-icons.js`
Expected: 打印 5 行、末尾 `✓ 已生成 10 个图标 → miniprogram/images/tabbar/`；`miniprogram/images/tabbar/` 下多出 `demand.png` 与 `demand-on.png`。

- [ ] **Step 10: 注册路由与页签**

`miniprogram/app.json`：

1. `pages` 数组末尾加 `"pages/demands/index"`（`pages/demand-edit/index` 在 Task 9 已加）。
2. `tabBar.list` **头部**插入（与 `custom-tab-bar/index.js` 的 `TABS` 顺序必须一致 —— 现有的那行注释就是这么写的）：

```json
      {
        "pagePath": "pages/demands/index",
        "text": "领需求",
        "iconPath": "images/tabbar/demand.png",
        "selectedIconPath": "images/tabbar/demand-on.png"
      },
```

- [ ] **Step 11: 跑测试，确认通过**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-page.js"`
Expected: PASS —— 新增 8 条全绿，前面 17 条仍然绿。

Run: `node scripts/selfcheck.js`
Expected: PASS，`失败 0 项`

- [ ] **Step 12: 提交**

```bash
git add miniprogram/pages/demands miniprogram/app.json miniprogram/custom-tab-bar miniprogram/pages/report miniprogram/pages/update miniprogram/pages/board miniprogram/pages/people miniprogram/images/tabbar scripts/gen-tabbar-icons.js
git commit -m "feat(demand): 领需求 tab（四个分段 + 横滑切换），tabBar 改按路径选中"
```

> ⚠️ 到这一步为止，`miniprogram/images/tabbar/` 下是仓库里唯一的二进制资源。**不要**把它们加进 `.gitignore`。

---

## Task 12: 一次性迁移 —— 14 条历史任务的来源改名

**Files:**
- Create: `scripts/make-source-rename-import.js`
- Modify: `scripts/tasks.source.csv`（14 行）
- Modify: `dashboard/src/api/mock.js:11`

**Interfaces:**
- Consumes: 无
- Produces: `scripts/tasks.sourcerename.import.json`（**派生物，被 .gitignore 挡住，不提交**）

- [ ] **Step 1: 先改不依赖数据的两处**

`dashboard/src/api/mock.js` 第 11 行左右：

```js
const SOURCES = ['总行通知', '监管检查', '需求池', '部领导交办', '中心领导交办', '会议纪要', '考评落实', '自发创新'];
```

`scripts/tasks.source.csv` 里把 14 行的 `业务部门提报` 改成 `需求池`（只改这一列的值，**其余字段一个字符都不动**）：

Run: `grep -c "业务部门提报" scripts/tasks.source.csv`
改之前 Expected: `14`

改完之后：

Run: `grep -c "业务部门提报" scripts/tasks.source.csv`
Expected: `0`

（不要运行 `node scripts/make-task-import.js` —— 那份 CSV 是 2026-08 的初始状态快照，重新生成并用它覆盖导入会把这 14 条任务三个月来的全部现值抹掉。）

- [ ] **Step 2: 写失败的测试（迁移脚本在假数据上先跑一遍）**

`C:\Users\Administrator\AppData\Local\Temp\tp-demand-migrate.js`：

```js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// 造一份假快照（JSON Lines），混入不该被动的条目
const tmp = path.join(os.tmpdir(), 'tp-src-snapshot.jsonl');
const rows = [
  { _id: 't1', task_name: '企金CRM分行专区对接与上线', source: '业务部门提报', progress: 80, detail: '不能被改动' },
  { _id: 't2', task_name: '别动我', source: '总行通知', progress: 10 },
  { _id: 't3', task_name: '也改', source: '业务部门提报', progress: 0 },
];
fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');

// 迁移脚本读的是 process.argv[2]
process.argv[2] = tmp;
const OUT = path.join('G:/TeamPulse', 'scripts', 'tasks.sourcerename.import.json');
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
require('G:/TeamPulse/scripts/make-source-rename-import.js');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}

const out = fs.readFileSync(OUT, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('★ 只导出被改过的那两条', out.length, 2);
check('改的那两条 source 变成「需求池」', out.map((r) => r.source), ['需求池', '需求池']);
check('★ 其余字段逐字节相等', out[0].progress, 80);
check('★ 其余字段逐字节相等（2）', out[0].detail, '不能被改动');
check('★ 未被改的条目一个都不出现', out.some((r) => r._id === 't2'), false);

fs.unlinkSync(OUT);
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 3: 跑测试，确认它失败**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-migrate.js"`
Expected: FAIL —— `Cannot find module '.../scripts/make-source-rename-import.js'`。

- [ ] **Step 4: 实现**

新建 `scripts/make-source-rename-import.js`：

```js
#!/usr/bin/env node
/**
 * scripts/make-source-rename-import.js
 * ---------------------------------------------------------------------------
 * 一次性迁移：把 14 条 source === '业务部门提报' 的任务改成 '需求池'。
 * （2026-10-09 SOURCE 枚举改名，见 docs/superpowers/specs/2026-10-09-demand-pool-design.md §7）
 *
 * 为什么必须迁移：shared/validate.js 的 assertEnum 会拒掉不在枚举里的来源，
 * 改名而不迁移，那 14 条任务一保存就报「任务来源取值不合法」。
 *
 * 【用法】
 *   node scripts/make-source-rename-import.js <控制台导出的任务快照.jsonl>
 *   → 生成 scripts/tasks.sourcerename.import.json
 *   → 在云开发控制台「覆盖导入」该文件（按 _id 覆盖，只动被改的那几条）
 *
 * ★ 不要走 tasks.source.csv 那条路。那份 CSV 是历史任务表的一次性导入源，
 *   字段值是 2026-08 的初始状态；重跑 make-task-import.js 再覆盖导入，
 *   会用三个月前的数据盖掉这 14 条任务的全部现值
 *   （进度、状态、已完成时间、姓名快照……）。CSV 只用来同步改名，
 *   保持源文件与库一致，不参与本次迁移。
 *
 * ⚠ 注意：本仓库的 scripts/make-*.js 在 require 时裸调 main()，
 *   执行它是有意的，不是误触。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const OLD = '业务部门提报';
const NEW = '需求池';
const OUT = path.join(__dirname, 'tasks.sourcerename.import.json');

function main() {
  const src = process.argv[2];
  if (!src) {
    console.error('用法：node scripts/make-source-rename-import.js <任务快照.jsonl>');
    process.exit(1);
  }
  if (!fs.existsSync(src)) {
    console.error(`快照文件不存在：${src}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(src, 'utf8').split('\n').filter((l) => l.trim());
  const changed = [];

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      console.error(`跳过无法解析的一行：${line.slice(0, 80)}`);
      continue;
    }
    if (row.source !== OLD) continue;

    // ★ 只改 source 这一个字段，其余**原样保留**（含 _id、含所有现值）。
    //   重建对象（只挑几个字段）会静默丢掉没列出来的字段 —— 那是数据损坏，
    //   不是迁移。所以这里是赋值而不是重建。
    row.source = NEW;
    changed.push(row);
  }

  fs.writeFileSync(OUT, changed.map((r) => JSON.stringify(r)).join('\n'), 'utf8');

  console.log(`扫描 ${lines.length} 行，命中 ${changed.length} 条「${OLD}」→「${NEW}」\n`);
  console.log('改动清单（请人工核对条数）：');
  changed.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.task_name}  —— 主办 ${r.leader || '（空）'}`);
  });
  console.log(`\n✓ 已生成 ${path.relative(process.cwd(), OUT)}（${changed.length} 条，覆盖导入用）`);
  if (changed.length !== 14) {
    console.warn(
      `\n⚠ 命中 ${changed.length} 条，与预期的 14 条不一致。` +
      `\n  多出或少了都说明快照不是导出时刻的库，先核对再导入，别直接覆盖。`
    );
  }
}

main();
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `node "C:\Users\Administrator\AppData\Local\Temp\tp-demand-migrate.js"`
Expected: PASS —— `通过 5 项，失败 0 项`。

Run: `node scripts/selfcheck.js`
Expected: PASS，`失败 0 项`

- [ ] **Step 6: 提交**

```bash
git add scripts/make-source-rename-import.js scripts/tasks.source.csv dashboard/src/api/mock.js
git commit -m "chore(demand): SOURCE 改名的数据源同步与一次性迁移脚本"
```

> `scripts/tasks.sourcerename.import.json` 是派生物，已被 `.gitignore` 挡住（与 `tasks.import.json` 同一条规则），**不要 `git add -f`**。

---

## Task 13: 文档与部署清单

**Files:**
- Modify: `README.md`（数据模型章节 + §5 权限矩阵）
- Modify: `docs/使用说明.html`（第 7 节「谁能改什么」）
- Modify: `dashboard/README.md:106,111`（两处「现有 7 个云函数」的表述已经过期）

- [ ] **Step 1: README —— 数据模型章节**

在集合清单里加一行 `demands`，并把 `SOURCE` 的枚举说明里的「业务部门提报」改成「需求池」，附一句：

```markdown
> ★ 2026-10-09 起 `SOURCE` 的第三项由「业务部门提报」改名为「需求池」。
> 库里历史任务的 `source` 需要一次性迁移（见 `scripts/make-source-rename-import.js`），
> 顺序见「部署清单」。
```

- [ ] **Step 2: README §5 权限矩阵**

把需求池那一节按 spec §9 的矩阵补上：

```markdown
| 操作 | 普通成员 | 提出人 | 领走人 | 管理员 | 管理者（只读） |
|---|---|---|---|---|---|
| 看需求池 | ✅ | ✅ | ✅ | ✅ | **✅（2026-10-09 放开）** |
| 新建需求 | ✅ | — | — | ✅ | **✅（2026-10-09 放开）** |
| 改需求 | ❌ | ✅ | ✅ | ✅ | 仅自己提的 |
| 领走（= 建任务） | ✅ | ✅ | ❌ | ✅ | ❌ |
| 关闭 / 重开 | ❌ | ✅ | ✅ | ✅ | 仅自己提的 |

★ 需求池是**唯一**一个对「管理者」开放的写域。任务是只读、进展是只读、
计划是只读、成员是只读 —— 那四个域一行没改。他领不走需求，因为
领走 = 建任务，而 `taskService.create` 的第一步仍是 `ctx.requireWriter()`。
```

- [ ] **Step 3: 部署清单（写进 README 或 commit message，交付给人看）**

```markdown
## 需求池上线清单（顺序是硬约束）

1. 云开发控制台**新建集合 `demands`**；建议索引：`status`、`proposerId`、`claimedById`
2. `node scripts/sync-shared.js`
3. **重新部署用到 `lib/shared` 的 8 个云函数**：`callAI`、`generatePeriodicTasks`、
   `memberService`、`notifyService`、`progressService`、`taskService`、
   `templateService`，加上新建的 `demandService`。
   ★ **`dashboardService` 不用传** —— 它只 require `wx-server-sdk`，不使用 `shared/`。
4. ★ **部署完立刻跑迁移**，中间不要有间隔：

   ```
   云开发控制台导出 tasks 集合快照 → 仓库外
   node scripts/make-source-rename-import.js <快照路径>
   控制台「覆盖导入」scripts/tasks.sourcerename.import.json
   ```

   ③ 与 ④ 之间不能等：新枚举一上线，那 14 条 `source: '业务部门提报'`
   的任务就处于"能被读、一保存就被拒"的状态。
5. 开发者工具人肉验收（见下）
```

- [ ] **Step 4: `docs/使用说明.html` 第 7 节**

在权限矩阵那一节补需求池五行，**用日常语言写**（这份文档是给日常使用小程序的同事看的，不是给开发者）：

> **领需求** 这个页签：那里放着还没成形的事 ——「得找财富部聊聊那个权益的事」。
> 谁都可以记一条进去，也可以挑一条自己接过去办（点开那条需求就是新建任务，
> 来源会自动填好「需求池」）。事情办完了，需求会自动变成「已完成」；
> 决定不做了，可以把它关掉，写一句原因，以后还能重新打开。

并更新那句"四个页面"为"五个页面"（全篇凡提到页签数量的地方都过一遍）。

Run: `grep -n "四个页面\|四个页签\|4 个页面" docs/使用说明.html`
Expected: 命中处全部改成五个。

- [ ] **Step 5: `dashboard/README.md`**

把「现有 7 个云函数与小程序源码**零改动**」一句里的数字与事实更新（现在是 8 个，且本次 `shared/` 有改动）：

```markdown
- 本次新增 `demandService`（需求池）后共 9 个云函数。电脑端看板**不展示需求池**。
- ★ `dashboardService` **本次不需要重新部署**：它只 require `wx-server-sdk`，
  完全不使用 `shared/`（有意做成自包含）。`sync-shared.js` 会照灌一份
  `lib/shared` 进去，但那是死副本，已在 `.gitignore` 里排除。
```

- [ ] **Step 6: 人肉验收（在微信开发者工具里，逐条过）**

1. tabBar **5 个页签，点哪个亮哪个**（逐个点一遍 —— 这是 Task 11 那处下标改动最容易翻车的地方）
2. 需求池 → 新建需求 → 出现在「我提的」
3. 待认领的需求点开 → 建任务页，来源锁死「需求池」、需求已选好、任务名与描述已预填
4. 提交 → 需求从「待认领」移到「我领的」，任务详情里能看到关联
5. 把该任务改成「已完成」→ 回到需求池，需求变成「已完成」
6. 再把任务改回「进行中」→ 需求退回「已领走」
7. 另建一条需求，不建任务直接关闭（填原因）→ 进「已关闭」，卡片上显示关闭原因
8. 已关闭的需求点「重新打开」→ 回到「待认领」
9. ★ **用管理者账号登录**：「领需求」tab 能看到且**不变灰**；能新建需求；能改能关自己提的那条；
   点别人提的「待认领」卡片 → 提示只有查看权限，**不跳转**；「报任务」「改任务」两个 tab 仍然变灰
10. 来源选择器仍能正常选其余 7 个来源，不受影响
11. ★ 挑一条原「业务部门提报」的历史任务 → 来源显示「需求池」→ 改一个字段保存 → **成功**
12. 四个分段各点一遍 + 左右横滑切换，确认没有"标签是这一段、列表是上一段"的错帧

- [ ] **Step 7: 提交**

```bash
git add README.md docs/使用说明.html dashboard/README.md
git commit -m "docs(demand): 需求池的权限矩阵、部署清单与使用说明"
```

---

## 回滚

代码层面的回滚是普通的 revert（`git revert` 那几个提交，或从 `main` 拉一个干净分支重做）。

**数据层面的回滚不平坦，必须先想清楚再动手：**

- `demands` 集合与 `tasks.demandId` 是**纯新增**，回滚代码后它们只是变成无人读的
  冗余数据 —— 留着不碍事，删掉也不影响任何功能。**不需要回滚。**
- **`SOURCE` 改名不可逆**：一旦跑完迁移，那 14 条任务的 `source` 就是「需求池」，
  而旧代码的 `assertEnum` 只认「业务部门提报」—— 那些任务在旧版本里**一保存就报错**。
  真要回到旧版本，必须同时做一次反向迁移（把 `source` 改回「业务部门提报」），
  否则会重演一遍"能读不能存"。
- 反向迁移不用新写脚本：`scripts/make-source-rename-import.js` 里的 `OLD`/`NEW`
  两个常量对调，跑在**新导出的快照**上即可（必须重新导出，不能拿几小时前那份）。

所以：**决定回滚前，先确认迁移是不是已经跑过。** 没跑过，回滚就是干净的 revert。

---

## 收尾

- **删掉仓库外的临时脚本**：`C:\Users\Administrator\AppData\Local\Temp\tp-demand-svc.js`、`tp-demand-task.js`、`tp-demand-page.js`、`tp-demand-fmt.js`、`tp-demand-migrate.js`。
- **不要 `git push`**。本仓库刻意不配远程。
- **不要合并到 `main`**：界面的东西要用户在开发者工具里自己过一遍（见 Task 13 Step 6）。
- 最终跑一次：`node scripts/selfcheck.js`（失败 0 项）与 `node scripts/sync-shared.js --check`（`✓ 已同步，无差异`）。
