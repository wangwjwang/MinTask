# 需求池：领需求 → 建任务

日期：2026-10-09 ｜ 分支：`ui-beautify`

## 由来

用户的设想，原文：

> 「我想在最前面增加一个『领需求』的界面……1. 新增『需求池』概念：建立一个需求池，
> 里面放一些粗略的需求。例如：我们要和哪个部门的谁去洽谈、洽谈什么事情、
> 大概是什么样的需求，都可以放在这里。2. 关联任务生成：在第二个页面『报任务』时，
> 新建任务的『来源』处，可以选择关联或不关联需求池。如果选择关联，就相当于把需求
> 『领走』，基于这个需求去生成任务。3. 需求关闭机制：如果我们把这个需求聊完了，
> 发现并不需要做什么，也可以直接将其关闭，先不要做。」

## 目标

给团队一个**在事情成形之前**的落点。

现在的四个界面全部围绕"已经确定要做的事"：任务必须有主办人、有截止日、有交付物。
但现实中很多事最初只是一个念头 ——「得找财富部聊聊那个权益的事」。眼下这种念头
无处可放：要么硬着头皮建成一条信息残缺的任务，要么留在微信聊天里。

需求池承接这一段：**需求是还没成形的事，任务是已经有人认领的事。**

**成功标准**：一条想法从"记下来"到"有人接手"再到"做完了 / 决定不做"，
全程在小程序里有迹可循，且中途不产生任何需要人工清理的中间态。

## 已定的决策

八项，全部由用户拍板，实现时不再重新论证：

| # | 决策 | 结论 |
|---|---|---|
| 1 | 需求与任务的数量关系 | 一条需求可拆成**多个**任务（1:N） |
| 2 | 「来源」枚举 | `业务部门提报` **改名为 `需求池`**，配一次性数据迁移 |
| 3 | 关闭权限 | 提出人 + 领走人 + 管理员 |
| 4 | 收尾方式 | 自动 + 手动各管一头：关联任务全完成 → 自动「已完成」；没建任务直接关 → 「已关闭」+ 原因 |
| 5 | 已关闭能否重开 | **能**，回到「待认领」（已建过任务的情形见 §4） |
| 6 | 谁能建需求 | 所有非只读成员 |
| 7 | ★ 管理者（只读角色） | **能看需求池 tab，也能新建需求** |
| 8 | ★ 管理者对自己提的需求 | **能改、能关** |

> 第 7、8 条是本设计唯一**打破现有硬规则**的地方：`管理者` 至今被定义为
> 纯只读（`ctx.requireWriter()` 一刀切 + README §5 权限矩阵 + tabBar 置灰）。
> 下面 §5 单列一节处理它。

---

## 一、数据模型

### 新集合 `demands`

| 字段 | 类型 | 说明 | 谁写 |
|---|---|---|---|
| `_id` | string | 自动 | — |
| `title` | string | 需求标题，一句话（必填，≤100） | 提出人 |
| `detail` | string | 需求描述（选填，≤2000） | 提出人 |
| `contactDept` | string | 对接部门（选填，≤50） | 提出人 |
| `contactName` | string | 对接人（选填，≤50） | 提出人 |
| `expectDate` | string | 期望时间 `YYYY-MM-DD`（选填） | 提出人 |
| `status` | string | 见 §2 状态机 | **服务端** |
| `proposerId` / `proposerName` | string | 提出人 = 录入人 | **服务端**（`ctx.openid` + `me.name`） |
| `claimedById` / `claimedByName` / `claimedAt` | string/string/date | 领走人与时间 | **服务端** |
| `closedByName` / `closedAt` / `closeReason` | string/date/string | 关闭人、时间、原因（≤200） | **服务端** + 原因由前端给 |
| `createdAt` / `updatedAt` | date | | 服务端 |

`contactDept` / `contactName` 是**纯文本的外部联系人**：不进 `members` 集合、
不参与任何权限判定、不能被选为主办或协办。它们是"我们要去找谁聊"的记录，
不是系统用户。

> 这条边界必须守住。一旦把外部联系人塞进 `members`，他们会出现在认领页、
> 人员看板、协作人选择器里，而他们没有 openid、永远认领不了 —— 那正是
> 历史导入数据里"未认领协办人"那类麻烦的翻版。

### `constants.js` 新增

```js
/** 需求状态 —— 与任务 STATUS/STAGE 无关，是需求自己的生命周期 */
const DEMAND_STATUS = ['待认领', '已领走', '已完成', '已关闭'];

/** 需求状态 → 徽标配色 key（沿用 app.wxss 的 .badge--{key}） */
const DEMAND_STATUS_TONE = {
  待认领: 'active',
  已领走: 'warn',
  已完成: 'done',
  已关闭: 'idle',
};

// COLLECTIONS 新增
DEMANDS: 'demands',
```

配色沿用现成四档，**不新增颜色**。语义：待认领＝蓝色（等着被拿走，是个中性偏
积极的状态）、已领走＝黄色（有人在办，但还没结论）、已完成＝绿色、
已关闭＝灰色（不做也是一种了结，但不需要被庆祝）。

### `SOURCE` 改名

```js
const SOURCE = [
  '总行通知',
  '监管检查',
  '需求池',      // ← 由 '业务部门提报' 改名
  '部领导交办',
  '中心领导交办',
  '会议纪要',
  '考评落实',
  '自发创新',
];
```

★ **改名的真实代价**：`shared/validate.js:157` 是
`assertEnum(raw.source, C.SOURCE, '任务来源')` —— 枚举里删掉一个值之后，
库里那 **14 条** `source: '业务部门提报'` 的历史任务会**一保存就报
「任务来源取值不合法」**。所以改名和迁移必须一起上，见 §7。

> 只改这一个值。数组长度与其余七项的**顺序**都不动 —— 顺序是 `field-picker`
> 高亮下标的依据，重排会让所有历史任务的来源在界面上显示错位。

### 任务侧新增 `demandId`

任务文档新增可选字段 `demandId`，指向派生它的需求。

★ **它不是任务的可编辑字段**，因此**不进** `TASK_LEADER_UPDATE_FIELDS`。
关联只在建任务那一刻建立（= 领走），之后主办人改不了 —— 否则
`task-edit` 能把任务指向任意一条需求，把一个普通任务伪装成"已领走"，
而那条需求的关联任务数、自动完成判定就全乱了。

它在 `create` / `adminCreate` 里作为 `payload.demandId` 单独传入
（不放在 `payload.task` 里），由 `taskService` 校验后写进文档。

`buildTaskDoc` 增加 `demandId` 入参（与 `templateId` / `periodKey` 同款）：

```js
if (demandId) doc.demandId = demandId;
```

---

## 二、状态机

任何时刻，一条需求恰好处于四个状态之一。**能让它变的只有三件事**：
手动领走、手动关闭/重开、自动重算（由关联任务的变化触发）。

| 从 | 事件 | 到 |
|---|---|---|
| — | 新建 | 待认领 |
| 待认领 | **领走**：基于它建任务（服务端原子占位） | 已领走 |
| 待认领 / 已领走 | **关闭**（手动，原因选填） | 已关闭 |
| 已关闭 | **重开**（手动）—— 清掉关闭痕迹后交给重算 | 见下一行 |
| 已关闭 ⟳重算 | 零关联任务 | 待认领（清空领走人） |
| 已关闭 ⟳重算 | 有未完成的任务 | 已领走 |
| 已关闭 ⟳重算 | 任务全部完成 | 已完成 |
| 已领走 | ⟳重算：关联任务**全部**已完成 | 已完成 |
| 已完成 | ⟳重算：有任务退回未完成 | 已领走 |
| 已领走 / 已完成 | ⟳重算：关联任务被**删光** | 待认领（清空领走人） |
| 已关闭 | ⟳重算（除重开那一刻） | **不动** |

★ **已关闭不被任何自动规则改动** —— 关了就关着，直到有人重开。
一个"我决定不做了"的结论，不该被隔壁任务的状态变化悄悄推翻。

**手动操作只有三个**：领走、关闭、重开（仅针对已关闭）。其余全部自动。

### 自动完成的判据

需求下的**全部**关联任务都 `stage === '已完成'` → 需求转「已完成」。
不用"任一完成"（那会在第一个任务做完时就误判），也不用进度百分比
（需求没有进度，它是"要不要做"的判断，不是"做了多少"）。

三种边界，都要处理：

| 情况 | 结果 | 理由 |
|---|---|---|
| 有 1 条以上任务，**全**已完成 | 已完成 | 正例 |
| 有任务，部分未完成 | 已领走 | 退回（任务被改回未完成时也要退回） |
| **一条任务都没有** | 待认领，清空 `claimedBy*` | 领走时建的任务被删了 —— 需求回到池子里，让下一个人领，而不是卡在"已领走但没人办" |

### 自动判定的落点

任务状态会变的出口只有四个，逐个挂上重算：

| 落点 | 何时 |
|---|---|
| `taskService.create` / `adminCreate` | 带 `demandId` 时，直接置「已领走」（正向，不是重算） |
| `taskService.update` | `patch` 里含 `stage` 且有 `demandId` |
| `progressService.addRecord` | `taskPatch` 里含 `stage` 且有 `demandId` |
| `taskService.delete` | 被删任务有 `demandId` |

★ **重算必须失败隔离**：包在 `try/catch` 里，出错只 `console.error` 一行，
**绝不让它把任务保存本身带崩**。需求状态晚一点同步是小事，
用户辛苦填的进展提交不上去是大事。漏掉的那些由 §6 的定时兜底收敛。

---

## 三、页面

tabBar 从 4 项变 5 项（微信上限，正好卡满）：

| # | 页签 | 路径 |
|---|---|---|
| **0** | **领需求** | `pages/demands/index` |
| 1 | 报任务 | `pages/report/index` |
| 2 | 改任务 | `pages/update/index` |
| 3 | 任务看板 | `pages/board/index` |
| 4 | 人员看板 | `pages/people/index` |

### `pages/demands`（新 tab）

沿用现有 Tab 页骨架（`.page` + 信息块 + `.seg` 分段 + 列表 + 底部入口行），
与任务看板是同一套结构：

```
┌──────────────────────────────────────┐
│  5 条等着认领                        │  ← 信息块：大数字 + 一行说明
│  我领的 3 · 我提的 2                 │
│                                      │
│ 待认领5│我领的3│我提的2│已关闭2      │  ← 分段（带计数，支持左右滑）
├──────────────────────────────────────┤
│  ▌和财富部聊机场贵宾权益             │  ← 需求卡
│  [待认领]                            │
│  财富部 · 王主任   期望 10月底        │
│  张三 提出   2 天前                  │
└──────────────────────────────────────┘
  [ + 新建需求 ]                        ← 底部入口行
```

**四个分段，各自装什么：**

| 分段 | 内容 | 点卡片去哪 |
|---|---|---|
| 待认领 | `status === '待认领'` | **建任务页**（= 领走） |
| 我领的 | `claimedById === 我` | 需求详情（看改一体） |
| 我提的 | `proposerId === 我` | 需求详情（看改一体） |
| 已关闭 | `status === '已关闭'` | 需求详情（看改一体） |

同一个需求可能同时落在两个分段里（我提的我领的），**这是对的**，不去重 ——
两个分段的问的是两个不同的问题（"我该办什么"和"我提的后来怎么样了"）。

★ 现有 `.seg` 分段控件在任务看板上是 **3 项**，这里要 4 项。落地前先在开发者
工具里确认 4 项不挤（标签是 3 个汉字 + 一位数字）。挤的话把计数挪到分段上方
的胶囊行里（任务看板已有 `.pill` 那种写法），**不要压字号**。

> 待认领分段点卡片直接进建任务页，是这一步的关键设计：**「领走」不是一个按钮，
> 而是"就这条需求建一个任务"这个动作本身**。多一个"领走"按钮再接一层
> 建任务表单，等于同一个意图点两次。

### `pages/demand-edit`（新页，看改一体）

完全照 `pages/plan-edit` 的先例：带 `?id=` 进来，按 `canEdit` 分两态。

- **能改**（`perm.canEditDemand`）→ 表单 + 保存 + 危险区（关闭）
- **不能改** → 只读摘要，页面上**不存在**输入控件与按钮

只读摘要里额外带一块**关联任务列表**（复用 `components/task-card`，只读），
点任务进 `task-detail`。这是"这条需求后来怎么样了"的唯一入口 ——
需求详情不显示派生任务，用户就得自己回任务看板里翻。

导航栏标题按态切换：能改叫「修改需求」，不能改叫「需求详情」（plan-edit 同款）。

关闭入口放危险区，一个描边按钮 + 原因输入（选填）。已关闭的需求，
危险区换成「重新打开」。

### `pages/task-create` 改动：来源 = 需求池时选需求

`source` 字段本身不动（仍是 `field-picker`，仍从 `C.SOURCE` 取值）。
在它下方新增一块**只在 `form.source === '需求池'` 时出现**的需求选择器：

```
来源        [ 需求池 › ]
关联需求    [ 请选择 › ]        ← 仅来源=需求池时出现，必填
            ┌──────────────────┐
            │ ○ 和财富部聊权益  │  ← 只有「待认领」的需求可选
            │ ○ 包头住维金测试  │
            └──────────────────┘
```

**从需求池点进来的情形**（`?demandId=xxx`）：来源锁死为「需求池」、
需求预先选好、`task_name` 与 `detail` 用需求的 `title` / `detail` 预填
（可改，不覆盖用户已输入的内容）。

来源选「需求池」却没选需求 → **前端拦住**（提示"请选择要关联的需求"），
云函数也拦（`INVALID_PARAM`）。选了需求却不是「待认领」→ 云函数拒绝。

### 需求卡上的「领走」按钮对管理者要消失

`auth.isViewer()` 为真时，「待认领」分段的卡片**不跳建任务页**，
点了提示「管理者账号只有查看权限」。理由见 §5。

---

## 四、云函数

### 新增第 9 个：`cloudfunctions/demandService/`

| action | 做什么 | 门禁 |
|---|---|---|
| `list` | 需求列表（分段筛在前端做，一次拉全量） | `requireMember()` |
| `get` | 单条（不存在返回 `null`，不抛错 —— 与 `templateService.get` 同款，避免"刚被别人删了"被说成加载失败） | `requireMember()` |
| `create` | 建需求 | **`requireMember()`** ★ 见 §5 |
| `update` | 改标题/描述/对接人/期望时间 | `requireMember()` + `perm.canEditDemand` |
| `close` | 关闭（写 `closeReason`） | `requireMember()` + `perm.canEditDemand` |
| `reopen` | 清空 `closedBy*` → 交给 §2 的重算定状态 | `requireMember()` + `perm.canEditDemand` |

★ **`reopen` 不硬写「待认领」**，而是清掉关闭痕迹后调用同一个
`syncDemandStatus`。用户的原话是"回到待认领"，那只说对了一半 ——
**没建任务就关的**（最常见的那种）确实回待认领；
但「已领走」的需求也能被关闭（§2 的状态表里有这条边），
那种需求重开时该回「已领走」而不是把人已经领走的事实抹掉。
一份重算逻辑回答所有情况，比在这里再写一遍分支可靠。

`list` **一次拉全量**（`fetchAll`），不在数据库层分段查。10 人规模下需求总量
是几十条，一次拉完在前端分组比三次查询简单，也和任务看板"一次拉全量再归并"
是同一套路。

`get` 走 `doc(id).get()`，返回 `null` 而不是抛错 —— 与 `templateService.get`
同一个理由：`pages/demand-edit` 手上的 id 是几秒前从列表点进来的，
那一条刚被别人删掉是正常竞态，不该和"加载失败"混成同一句话。

### `shared/perm.js` 新增纯函数

```js
/**
 * 是否可编辑需求（改字段 / 关闭 / 重开）。
 * 规则：提出人、领走人、或管理员 —— 三方都是"这条需求跟我有关"的人。
 */
function canEditDemand(demand, openid, isAdmin) {
  if (!openid || !demand) return false;
  return demand.proposerId === openid
      || demand.claimedById === openid
      || !!isAdmin;
}
```

★ **一个函数管三件事（改 / 关 / 重开），不再拆细。** 用户只对"关闭权限"
拍过板（提出人 + 领走人 + 管理员），没说过"改"归谁。这里让两者共用同一条规则，
理由有三条：

1. 能关的人本来就该能改 —— 关之前想补一句描述，不该被拦住；
2. 规则拆细就要写两个函数、测两组用例，而它们**必然会漂**（改的规则变了、
   关的忘了跟着变，就是"能改不能关"这种说不通的状态）；
3. 这三件事共享同一个语义：「这条需求跟你有关，你可以处置它」。

> ⚠️ 这一条是本设计里**替用户做的判断**（不是他拍板的八项之一）。
> 若他要的是"只有提出人能改、领走人只能关"，改动是：把 `canEditDemand` 拆成
> `canEditDemand`（提出人 + 管理员）与 `canCloseDemand`（三方），
> 其余设计不变。

★ **「领走人也能关」怎么算？** 关闭权限里说的"领走人" = 关联任务的主办人 ——
这个关系在**任务**上，不在需求文档里。但需求本身已经存了 `claimedById`
（领走那一刻写下的），所以不需要反查任务：拿需求自己的字段就够了。
**这也是 `claimedById` 必须存 openid、不能只存姓名的原因。**

★ **`proposerId` / `claimedById` 是判据，`proposerName` / `claimedByName` 是快照。**
两两分开存，函数里只比对 Id 那一个 —— 与 `shared/perm.js` 文件头的第 1 条纪律
（"绝不比对姓名字符串"）完全一致，这里没有任何例外。

★ **管理者（只读）不需要在这里额外开洞**：他作为提出人时
`proposerId === openid` 已经为真，作为领走人则永远不可能（他领不走，见 §5）。
所以 §5 那扇门只需要开在 `demandService` 的**入口**（`requireMember` 而非
`requireWriter`），不需要动 `perm.js` 里的任何判据。

### `taskService.create` 扩展：领走是一个原子动作

```js
async function create(payload, ctx) {
  const me = await ctx.requireWriter();
  // 门禁保持在最前：管理者到这一行就被拒，压根走不到占位那一步（§5）
  const fields = validate.validateTaskFields(payload.task || {}, { isCreate: true });
  validate.assertTaskRequiredForCreate(fields);
  const { ids, names } = await resolveCollaborators(ctx, fields.__rawCollaboratorIds, ctx.openid);

  // ★ 顺序：先占位、再建任务。反过来的话，两个人同时点「领走」会双双建成任务，
  //   而其中一条的 demandId 指向的需求已经被另一个人占走了。
  const demandId = await claimDemand(ctx, payload.demandId, ctx.openid);

  try {
    return await insertTask(ctx, { fields, leaderId: ctx.openid, leaderName: me.name,
      collaboratorIds: ids, collaboratorNames: names, creatorId: ctx.openid,
      token: payload.clientToken, demandId });
  } catch (e) {
    await releaseDemand(ctx, demandId);   // 尽力回滚，见下
    throw e;
  }
}
```

`claimDemand` 的原子性靠 `where` 里带上状态条件：

```js
/**
 * 原子占走一条需求。返回 demandId（无 demandId 时返回 ''）。
 *
 * ★ 为什么用 where().update() 而不是 doc().get() 之后 doc().update()
 *   两个人同时点「领走」时，先查后写会双双查到「待认领」，然后双双写成功 ——
 *   一条需求被领两次。where 里带上 status: '待认领' 这个条件，
 *   数据库的更新是原子的，只有一个人能拿到 stats.updated === 1。
 *   这与 shared/idempotency.js 说的"不靠先查后写"是同一条纪律。
 */
async function claimDemand(ctx, demandId, leaderId) {
  if (!demandId) return '';
  const id = validate.assertNonEmptyString(demandId, '需求');

  const leader = (await ctx.resolveMembers([leaderId]))[0];
  if (!leader) throw new BizError(Codes.MEMBER_NOT_FOUND, '指定的主办人不存在');

  const r = await ctx.db.collection(COLLECTIONS.DEMANDS)
    .where({ _id: id, status: '待认领' })   // ← 条件里的枚举必须是字面量
    .update({ data: {
      status: '已领走',
      claimedById: leaderId,        // ★ 判据，必须是 openid
      claimedByName: leader.name,   // 快照
      claimedAt: ctx.db.serverDate(),
      updatedAt: ctx.db.serverDate(),
    }});

  if (!r.stats || r.stats.updated !== 1) {
    throw new BizError(Codes.INVALID_PARAM, '这条需求已被领走，刷新后再看看别的');
  }
  return id;
}
```

> 上面两处状态写的是**字面量**而不是 `DEMAND_STATUS.xxx`：`DEMAND_STATUS` 是
> **数组**（给 `assertEnum` 用的），不是 `ROLE` 那样的对象，写 `.PENDING`
> 会静默得到 `undefined`，`where` 条件里变成"status 等于 undefined"——
> 一个不报错、也永远匹配不上的查询。同理，`COLLECTIONS.DEMANDS` 是对象成员，
> 可以照常用。

`releaseDemand(ctx, demandId)` 是它的逆操作，同样按 `_id + status` 条件更新、
同样判 `stats.updated`，无 demandId 时直接返回。

> **为什么回滚不是可有可无的**：占位成功但建任务失败（截止日校验没过、
> 网络超时、协办人不存在……）时若不回滚，那条需求就停在「已领走」、
> 却一条任务都没有 —— 池子里少了一条，谁也不知道它去哪了。
> 回滚本身也可能失败，所以它包在 `try/catch` 里不影响抛给用户的原始错误，
> 漏网的由 §6 的定时兜底收敛（巡检看到"已领走 + 零任务"就退回待认领）。

> 三条不同的失败信息要分清，别都笼统说"操作失败"：
> 需求不存在 / 已被领走 / 其它。前端 `handleError` 直接用云函数给的中文。

### 需求列表与任务列表的查询

`utils/db.js` **不加东西**。需求列表要 `fetchFrom('demands', q => q.orderBy('createdAt','desc'))`，
这是现成的 `fetchFrom` 一次调用，直接写在 `pages/demands/index.js` 里即可 ——
`fetchFrom` 本来就是给页面用的通用分页封装，为一次查询加一个 `allDemands()`
包装没有收益。

「我领的 / 我提的」在前端按 `claimedById` / `proposerId` 过滤，不下推到数据库 ——
和任务看板"一次拉全量再归并"同一套路，10 人规模下不值得多查两次。

---

## 五、★ 给管理者开的这扇门

这是本设计唯一与现有硬规则冲突的地方，必须正面处理，不能默默沿用旧门禁。

### 冲突是什么

`管理者`（`ROLE.VIEWER`）至今的定义是**纯只读**，三道闸口一致：

1. `shared/ctx.js` 的 `requireWriter()` —— 所有写入口的第一步，命中即
   `FORBIDDEN_VIEWER`；
2. `custom-tab-bar` 的 `write: true` —— 那两个页签对管理者置灰；
3. README §5 权限矩阵 —— 写着"只能看两个看板"。

用户要求：管理者能看需求池 tab，**并且能建需求**，**并且能改能关自己提的**。

### 怎么开

**只开 `demandService` 这一扇门，且只开必要的宽度。**

| 位置 | 做法 |
|---|---|
| `demandService` 全部 action | 走 `requireMember()`，**不调 `requireWriter()`** |
| 写权限判定 | 完全交给 `shared/perm.js` 的需求纯函数（`canEditDemand`） |
| `custom-tab-bar` | 「领需求」标记 `write: false` —— 对它**不变灰** |
| `taskService` | **一行不改**，仍走 `requireWriter()` |

★ **为什么 `demandService` 不调 `requireWriter()` 是安全的**：
`requireWriter()` 是"一刀切地挡住管理者"，而需求池需要的恰恰是
"管理者能写 **他自己提的** 那几条"。这个粒度用一刀切表达不了，
只能在纯函数里表达。而 `canEditDemand` 是同一个函数前端后端共用 ——
前端控显隐、后端做强制校验，口径不会漂。

★ **为什么这是唯一一处**：`demandService` 是**唯一**一个管理者能写的数据域。
其余全部（任务、进展、计划、成员）保持原样。改这一处时要在文件头注释里
写明"为什么这里故意不用 requireWriter"，否则下一个读到的人会以为漏了。

### 必须一起处理的推论

**管理者领不走需求。** 领走 = 建任务，而建任务仍走 `requireWriter()`。
所以流程只能是：**他丢进池子 → 别人领**。这符合他只读的定位，但页面上
必须把「领走」这个动作对他藏掉，否则就是个点了报错的死角。

具体：`pages/demands` 的「待认领」分段里，`auth.isViewer()` 为真时
点卡片不跳建任务页，提示「管理者账号只有查看权限」。前端这一层是体验，
云函数那层由 `taskService.create` 的 `requireWriter()` 真正兜住。

**他也不能当需求卡的"关联任务主办人"** —— 同上，`assertAssignable` 已经拦住了。

---

## 六、定时兜底

`cloudfunctions/generatePeriodicTasks` 是现成的每日巡检函数
（00:05 跑一次，建任务页的注释里已经把它称作"每日巡检"）。
在它里面加一段需求状态重算：

```
扫全部 status ∈ {待认领, 已领走, 已完成} 的需求
  → 按 demandId 统计各自的任务
  → 走与 §2 同一份重算逻辑（shared/demandRepo.js 的 syncDemandStatus）
```

★ **不新建一个云函数**：一个每天只跑一次的巡检单独占一个云函数名、
一份部署、一份 `lib/shared` 副本，代价大于收益；而 `generatePeriodicTasks`
本来就是"每天扫一遍库、把派生状态收敛到真实状态"的定位，加这一段是同性质的。

★ **重算逻辑放 `shared/demandRepo.js`（新文件）**，与 `shared/taskRepo.js` 同款：
「需求领域里容易写错的事集中在一处」。它导出一个
`syncDemandStatus(db, demandId)`，被 §2 的四个即时落点和这段巡检共用。
**同一份实现，不抄第二份。**

`job_logs` 里记一条 `demandSync: { scanned, changed }`，与现有日志同格式。

---

## 七、SOURCE 改名与 14 条历史数据

### 顺序是硬约束

```
① 改 shared/constants.js 的 SOURCE
② node scripts/sync-shared.js          （把新枚举同步到 9 份云函数副本）
③ 部署全部云函数                        （含新的 demandService）
④ ★ 立刻跑数据迁移
```

★ **③ 和 ④ 之间不能有间隔。** 新枚举一上线，库里那 14 条
`source: '业务部门提报'` 的任务就处于"能被读、一保存就被拒"的状态 ——
`validate.js:157` 的 `assertEnum` 会让主办人改任何一个字段都报
「任务来源取值不合法」。迁移做完才恢复正常。

### 迁移怎么做

沿用仓库既有的覆盖导入套路（与 `make-collab-fix-import.js` 同源）：

1. 云开发控制台导出 `tasks` 集合的 JSON Lines 快照到仓库外；
2. 新脚本 `scripts/make-source-rename-import.js`（**注意：本仓库的
   `scripts/make-*.js` 在 require 时裸调 `main()`，执行它是有意的，
   不是误触**）读快照 → 把 `source === '业务部门提报'` 的文档改成
   `'需求池'`，其余字段原样保留 → 输出 `scripts/tasks.sourcerename.import.json`；
3. 控制台「覆盖导入」该文件（按 `_id` 覆盖，只动这 14 条）；
4. 脚本要打印改了哪几条（任务名 + 主办人），供人工核对条数对不对。

★ **不要走 `tasks.source.csv` 那条路。** 那份 CSV 是**历史任务表的一次性导入源**，
里面的字段值是 2026-08 的初始状态；现在重跑 `make-tasks-import.js` 再覆盖导入，
会用三个月前的数据盖掉这 14 条任务的全部现值（进度、状态、已完成时间、
姓名快照……）。CSV 只用来**同步改名**（保持源文件与库一致），不参与本次迁移。

### 顺带要改的

| 文件 | 改什么 |
|---|---|
| `scripts/tasks.source.csv` | 14 行的 `业务部门提报` → `需求池`（保持源文件与库一致） |
| `dashboard/src/api/mock.js:11` | `SOURCES` 数组里的同一个值 |
| `dashboard/dist/` | 若已构建过，**不要手工改** —— 下次 `npm run build` 自然带上 |
| README | 数据模型章节的枚举说明、§5 权限矩阵（见 §9） |

### `field-picker` 不用担心

改名后若某条任务来不及迁移，`field-picker` 的
`indexOf` 返回 `-1` → 不高亮任何选项，而 `field__value` **原样渲染字符串**，
界面显示为「业务部门提报」，不崩不空白。所以迁移慢一步不会做出一个坏页面，
只是那个字段处于"看得见、改不了"的状态。

---

## 八、改动面

### 新增

| 文件 | 说明 |
|---|---|
| `cloudfunctions/demandService/` | 第 9 个云函数（`index.js` + `package.json` + `lib/shared/` 副本） |
| `pages/demands/*` | 领需求 tab（4 个文件） |
| `pages/demand-edit/*` | 看改一体（4 个文件） |
| `shared/demandRepo.js` | `syncDemandStatus`，云函数侧 |
| `scripts/make-source-rename-import.js` | 一次性迁移脚本 |

### 修改

| 文件 | 改动 |
|---|---|
| `shared/constants.js` | `DEMAND_STATUS` / `DEMAND_STATUS_TONE` / `COLLECTIONS.DEMANDS` / `SOURCE` 改名 |
| `shared/perm.js` | `canEditDemand` |
| `shared/taskRepo.js` | `buildTaskDoc` 接受 `demandId` |
| `shared/validate.js` | 需求字段的校验函数（`validateDemandFields` / `assertDemandRequired`） |
| `cloudfunctions/taskService/index.js` | `claimDemand` + `create`/`adminCreate` 接 `demandId` + `update`/`delete` 挂重算 |
| `cloudfunctions/progressService/index.js` | `addRecord` 里 `stage` 变更后挂重算 |
| `cloudfunctions/generatePeriodicTasks/index.js` | 每日需求状态重算 |
| `app.json` | `pages` 加 2 行；`tabBar.list` 头部插 1 项 |
| `custom-tab-bar/index.js` | `TABS` 加一项；★ `sync(index)` 改成 `sync(pagePath)`，见下 |
| `pages/task-create/*` | 需求选择器 + `demandId` 透传 + 预填 |
| `utils/api.js` | `demandApi`（6 个 action） |
| `utils/format.js` | 需求卡的派生字段（相对时间、对接人文本、状态 tone） |
| 4 个现有 tab 页 | `syncTabBar(N)` 的调用改成传路径 |

### ★ tabBar 下标：顺手把魔法数字清掉

现在 4 个 tab 页各自硬编码了自己的下标（`report` 传 0、`update` 传 1、
`board` 传 2、`people` 传 3，共 8 处调用）。在头部插入一个 tab 会让这 8 处**全部错位**，
而错位的表现是"点进 A 页面、B 页签亮着"—— 一个不会报错、但一眼就能看出不对的 bug。

与其手改 8 个数字（下次再加 tab 还得再犯一次），不如改成按路径找下标：

```js
// custom-tab-bar/index.js
sync(pagePath) {
  const i = TABS.findIndex((t) => t.pagePath === pagePath);
  this.setData({ selected: i < 0 ? 0 : i, tabs });
}
```

页面侧 `this.syncTabBar('/pages/report/index')` —— 它本来就"知道"自己在哪一页。
这是**本设计直接引起的**改动（不这么做就要手改 8 个数字），不是无关重构。

---

## 九、权限矩阵更新

README §5 与 `docs/使用说明.html` 第 7 节都要加一节需求池。新的完整矩阵：

| 操作 | 普通成员 | 提出人 | 领走人 | 管理员 | 管理者（只读） |
|---|---|---|---|---|---|
| 看需求池 | ✅ | ✅ | ✅ | ✅ | **✅（本次放开）** |
| 新建需求 | ✅ | — | — | ✅ | **✅（本次放开）** |
| 改需求 | ❌ | ✅ | ✅ | ✅ | 仅自己提的 |
| 领走（= 建任务） | ✅ | ✅ | ❌ | ✅ | ❌ |
| 关闭 / 重开 | ❌ | ✅ | ✅ | ✅ | 仅自己提的 |

★ 需求池**唯一**与任务不同的地方就是最后那一列。其余四列与任务侧完全一致，
说明这确实是"给一个角色多开一格"，不是另起一套权限模型。

---

## 十、验证

**自动化：**

- `node scripts/selfcheck.js` —— 先跑一次记下当前基准，改完再跑，
  **要求：总数只增不减、失败项为 0**（新增的枚举与纯函数应该在自动覆盖范围内；
  跑完看它有没有把 `canEditDemand` 纳入用例，没有就在 `selfcheck.js` 里补一条）
- `node scripts/sync-shared.js --check` —— 应输出「✓ 已同步，无差异」
- node 桩跑真实云函数 handler（仓库外临时脚本，跑完删）。**这几条是本次的
  核心防线**，因为它们才是权限与状态机的真身：
  1. `demandService.create` 对一个 `role: '管理者'` 的成员**返回成功**
     （这是本次唯一的权限例外，必须有测试钉住）
  2. `demandService.update` 对管理者改**别人提的**需求返回 `INVALID_PARAM`
     / 拒绝
  3. `taskService.create` 带 `demandId` 时：需求转「已领走」、`claimedById`
     等于新建任务的 `leaderId`、任务文档带上了 `demandId`
  4. **并发领走**：对同一条需求连发两次 `create`，第二次必须失败，
     且库里 `demands` 只有一次状态变更（`stats.updated` 那条断言）
  5. 管理者调 `taskService.create` 带 `demandId` → 仍返回 `FORBIDDEN_VIEWER`
     （证明门只开了一半，任务侧纹丝不动）
  6. `syncDemandStatus` 四种输入：全完成 → 已完成；部分完成 → 已领走；
     零任务 → 待认领且 `claimedById` 被清空；`已关闭` → **原样不动**
- 迁移脚本先在假数据上跑一遍，确认只改 `source`、条数 = 14、其余字段逐字节相等
- 死代码扫描 / WXML 标签配平 / 新类名有定义（沿用既有检查）

**开发者工具里人肉验收：**

1. tabBar 5 个页签，**点哪个亮哪个**（对 5 个页签逐个点一遍 —— 这是
   §8 那处下标改动最容易翻车的地方）
2. 需求池 → 新建需求 → 出现在「我提的」
3. 待认领的需求点开 → 建任务页，来源锁死「需求池」、需求已选好、
   任务名与描述已预填
4. 提交 → 需求从「待认领」移到「我领的」，任务详情里能看到关联
5. 把该任务改成「已完成」→ 回到需求池，需求变成「已完成」
6. 再把任务改回「进行中」→ 需求退回「已领走」
7. 另建一条需求，不建任务直接关闭（填原因）→ 进「已关闭」，
   卡片上显示关闭原因
8. 已关闭的需求点「重新打开」→ 回到「待认领」
9. ★ **用管理者账号登录**：能看到「领需求」tab 且**不变灰**；能新建需求；
   能改能关自己提的那条；点别人提的「待认领」卡片 → 提示只有查看权限，
   **不跳转**；「报任务」「改任务」两个 tab 仍然变灰
10. 来源选择器仍能正常选其余 7 个来源，不受影响
11. 挑一条原「业务部门提报」的历史任务（如"企金CRM分行专区对接与上线"）
    → 来源显示「需求池」→ 改一个字段保存 → **成功**，不再报来源不合法

**部署清单（本次比往常重）：**

- 新集合 `demands` 要在控制台建；建议索引 `status`、`proposerId`、`claimedById`
- ★ **`shared/` 有改动** ⇒ 现有 **8 个云函数全部要重新部署**，
  加上新建的 `demandService`，共 **9 个**
- 部署完**立刻**跑 §7 的一次性迁移
- `dashboardService` 也在 8 个之内，电脑端看板这次**不改功能**
  （需求池不进看板，等小程序跑顺再说），但因为 `lib/shared` 副本要同步，仍要重传

---

## 十一、不做的事

- **不动权限模型的其余部分**。任务/进展/计划/成员四个域的写门禁一行不改，
  管理者在那些地方仍是 `FORBIDDEN_VIEWER`
- **不发明枚举值**。需求状态只用本文档 §1 列出的四个；
  来源只做改名，不加不减
- **不改现有集合的结构**。`demands` 是新增集合，其余五个集合一个字段不加
  （`tasks.demandId` 是唯一例外，且是可选字段）
- **不做需求的评论 / 附件 / 流转记录**。需求池要解决的是"想法有地方放"，
  讨论过程在微信里发生，进来的是结论
- **不做需求的"指派"**。领走是主动的，不能派 —— 派了就变成任务了
- **电脑端看板不展示需求池**（本次）
- **不做需求的搜索与筛选**。10 人规模、几十条需求，四个分段够用

## 回滚

代码用 `git revert` 即可；**数据迁移不可逆**（14 条任务的 `source` 改了名），
但方向是安全的：回滚代码后把 `SOURCE` 里的 `需求池` 改回 `业务部门提报`，
那 14 条立刻又能保存了 —— 只是它们此时记的是"需求池"这个库里不认的值，
再跑一次反向迁移即可。**回滚要连同 §7 的反向迁移一起做**，不能只回代码。
