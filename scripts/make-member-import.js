/**
 * scripts/make-member-import.js
 * ---------------------------------------------------------------------------
 * 把 scripts/members.json（易读的数组）转成云开发数据库能直接导入的格式。
 *
 * 用法：
 *   node scripts/make-member-import.js
 *
 * 产出：
 *   scripts/members.import.json  —— 拿去云开发控制台导入
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么需要这个脚本，而不是直接把 members.json 拿去导入：
 *
 *  1) **格式不同**。云开发数据库要的是 JSON Lines —— 每行一个独立文档，
 *     没有外层 `[]`，对象之间没有逗号。直接导入标准 JSON 数组会报
 *     「解析json文档错误 … invalid character ']' looking for beginning of value」。
 *     数组格式更易读、能被编辑器校验，所以让源文件保持数组、由脚本转格式。
 *
 *  2) **导入前能校验**。导入是往线上集合写数据，写错了要逐条清理。
 *     重名、空名、超长、openid 被误填 —— 这些在这里拦下来，
 *     比导进去之后再发现便宜得多。尤其是 openid 那条，见下。
 *
 *  3) **openid 必须显式写成空串**。这一条最容易漏且后果最隐蔽：
 *     云开发的查询是 MongoDB 语义，`where({ openid: '' })` **匹配不到
 *     根本没有 openid 字段的文档**。若导入时省略了这个字段：
 *       - listClaimable 查不到它 → 认领页不显示这个人
 *       - claim 的 CAS 条件不成立 → stats.updated = 0
 *       - 于是走到"抢占失败"分支，报「该成员已被他人认领」
 *     明明没人认领，却报已被认领 —— 排查方向会被彻底带偏。
 *     所以本脚本**总是**输出 openid: ""。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'members.json');
const OUT = path.join(__dirname, 'members.import.json');

/** 与云函数 memberService 的 NAME_MAX 保持一致 */
const NAME_MAX = 20;
/** 与 memberService 里 dept 的 slice(0, 30) 保持一致 */
const DEPT_MAX = 30;

const ROLE_ADMIN = '管理员';
const ROLE_NORMAL = '普通';

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/**
 * 读取源名单。优先按标准 JSON 数组解析；失败则退回 JSON Lines。
 *
 * ★ 允许两种格式，是因为网上关于"导入失败"的攻略几乎都建议直接改成
 *   JSON Lines。用户照做之后，源文件就不再是数组了 —— 此时脚本不该报错，
 *   而应照常工作。
 */
function readSource(raw) {
  // 去掉可能存在的 BOM，否则 JSON.parse 会在第一个字符就失败
  const text = raw.replace(/^﻿/, '').trim();
  if (!text) return { list: [], format: '空文件' };

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { list: parsed, format: 'JSON 数组' };
    if (parsed && typeof parsed === 'object') return { list: [parsed], format: '单个对象' };
    return { list: [], format: '无法识别' };
  } catch (e) {
    // 落到 JSON Lines
  }

  const list = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      list.push(JSON.parse(line));
    } catch (e) {
      throw new Error(
        `members.json 第 ${i + 1} 行既不是合法 JSON，也不是合法的 JSON Lines 文档：\n` +
        `  ${line.slice(0, 80)}${line.length > 80 ? '…' : ''}\n` +
        `  ${e.message}`
      );
    }
  }
  return { list, format: 'JSON Lines' };
}

// ---------------------------------------------------------------------------
// 校验与归一
// ---------------------------------------------------------------------------

/**
 * @returns {{docs: object[], fatal: string[], warn: string[]}}
 *   fatal 非空时不应产出文件 —— 导进去的是错数据，比不导更麻烦
 */
function normalize(list) {
  const fatal = [];
  const warn = [];
  const docs = [];
  /** 姓名 → 首次出现的序号，用于重名报错时指出两处位置 */
  const seen = new Map();

  list.forEach((item, idx) => {
    const at = `第 ${idx + 1} 条`;

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fatal.push(`${at}不是对象`);
      return;
    }

    const name = String(item.name === undefined ? '' : item.name).trim();
    if (!name) {
      fatal.push(`${at}缺少 name`);
      return;
    }
    if (name.length > NAME_MAX) {
      fatal.push(`${at}姓名「${name}」有 ${name.length} 字，超过上限 ${NAME_MAX}`);
      return;
    }
    if (seen.has(name)) {
      fatal.push(`姓名「${name}」重复：第 ${seen.get(name)} 条和第 ${idx + 1} 条`);
      return;
    }
    seen.set(name, idx + 1);

    // 已填了 openid 的记录永远无法被认领（CAS 条件是 openid === ''），
    // 这属于必须拦下的错误，不是警告。
    if (item.openid) {
      fatal.push(
        `${at}「${name}」的 openid 不是空的。认领的前提是 openid === ''，` +
        `这条记录会永远无法被认领。请删掉该字段或改为 ""。`
      );
      return;
    }

    let dept = String(item.dept === undefined ? '' : item.dept).trim();
    if (dept.length > DEPT_MAX) {
      warn.push(`${at}「${name}」的 dept 超过 ${DEPT_MAX} 字，已截断`);
      dept = dept.slice(0, DEPT_MAX);
    }

    let role = ROLE_NORMAL;
    if (item.role !== undefined && item.role !== '') {
      if (item.role === ROLE_ADMIN || item.role === ROLE_NORMAL) {
        role = item.role;
      } else {
        warn.push(`${at}「${name}」的 role「${item.role}」无法识别，已按「${ROLE_NORMAL}」处理`);
      }
    }

    // ★ openid 与 claimedAt 始终显式写出。原因见文件头注释第 3 条 ——
    //   省略 openid 会让该记录既不出现在认领页、又报"已被他人认领"。
    docs.push({ name, dept, role, openid: '', claimedAt: null });
  });

  if (!docs.length && !fatal.length) {
    fatal.push('名单为空，没有可导入的成员');
  }
  if (docs.length && !docs.some((d) => d.role === ROLE_ADMIN)) {
    warn.push(
      `名单里没有任何「${ROLE_ADMIN}」。导入后所有人都无法管理周期模板、删除任务。` +
      `请至少把一个人（通常是你自己）的 role 改成「${ROLE_ADMIN}」。`
    );
  }

  return { docs, fatal, warn };
}

// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`✗ 找不到源文件：${SRC}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(SRC, 'utf8');
  let source;
  try {
    source = readSource(raw);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  console.log(`读取 ${path.relative(process.cwd(), SRC)}（识别为 ${source.format}，${source.list.length} 条）`);

  const { docs, fatal, warn } = normalize(source.list);

  // 先报 fatal 再报 warn：有致命错误时这个文件根本不会生成，
  // 此时再列一堆"建议处理"的事项只会分散注意力。
  if (fatal.length) {
    console.error('\n✗ 校验未通过，没有生成导入文件：');
    fatal.forEach((f) => console.error(`   · ${f}`));
    process.exit(1);
  }

  if (warn.length) {
    console.log('\n⚠ 警告（不阻断，但建议处理）：');
    warn.forEach((w) => console.log(`   · ${w}`));
  }

  // ★ JSON Lines：每行一个独立文档，行间无逗号，无外层方括号。
  //   末尾补一个换行 —— 最后一行不带换行时，部分解析器会漏掉它。
  const lines = docs.map((d) => JSON.stringify(d));
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

  const admins = docs.filter((d) => d.role === ROLE_ADMIN).map((d) => d.name);
  console.log(`\n✓ 已生成 ${path.relative(process.cwd(), OUT)}（${docs.length} 条，JSON Lines 格式）`);
  console.log(`  ${ROLE_ADMIN}：${admins.length ? admins.join('、') : '（无，见上方警告）'}`);
  console.log('\n下一步：云开发控制台 → 数据库 → members 集合 → 导入 → 选择该文件');
  console.log('        冲突处理方式选「Insert」。');
}

main();
