#!/usr/bin/env node
/**
 * scripts/sync-shared.js
 * ---------------------------------------------------------------------------
 * 把仓库根 shared/ 同步到两端：
 *   1. miniprogram/shared/                     （小程序端副本）
 *   2. cloudfunctions/{每个云函数}/lib/shared/  （云函数端副本）
 *
 * 【为什么用"复制"而不是 npm 包】
 *   三条常见路线都走不通：
 *     - 云函数 require 小程序端代码：两端运行环境与路径隔离，不可能；
 *     - npm file: 本地依赖：开发者工具"云端安装依赖"只上传函数目录，
 *       file:../../shared 在云端解析失败；
 *     - 小程序"构建 npm"：需要额外构建步骤，违反"导入即可编译"的硬约束。
 *   因此采用"单一源 + 复制到两端"，副本提交进仓库，保证零构建。
 *
 * 【用法】
 *   node scripts/sync-shared.js          正常同步
 *   node scripts/sync-shared.js --check   只校验是否已同步（CI / 提交前用）
 *
 * 【纪律】改 shared/ 后必须重跑本脚本，否则两端会跑旧代码。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'shared');
const MP_DEST = path.join(ROOT, 'miniprogram', 'shared');
const CF_ROOT = path.join(ROOT, 'cloudfunctions');

/**
 * 依赖 wx-server-sdk 的模块，**不下发到小程序端**。
 *
 * 注意不能只是"同步过去但不 require"：微信开发者工具在编译期会解析
 * 项目内所有 .js 的 require，一个顶层 `require('wx-server-sdk')` 即使
 * 无人引用，也会让编译报"找不到模块"。所以只同步双端安全的模块过去。
 */
const CLOUD_ONLY = ['ctx.js', 'router.js', 'notify.js'];

const CHECK_MODE = process.argv.includes('--check');
let hasDiff = false;

/** 读取目录下所有 .js 文件（不含子目录，shared 是扁平结构） */
function listSharedFiles() {
  return fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

/** 写文件；--check 模式下只比对不写入 */
function writeIfChanged(destPath, content, label) {
  const exists = fs.existsSync(destPath);
  if (exists) {
    const old = fs.readFileSync(destPath, 'utf8');
    if (old === content) return false; // 无变化，不触碰 mtime
  }

  if (CHECK_MODE) {
    console.log(`  ✗ 未同步：${label}`);
    hasDiff = true;
    return false;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content, 'utf8');
  console.log(`  ✓ ${label}`);
  return true;
}

/**
 * 同步到一个目标目录。
 * @param {boolean} excludeCloudOnly 为 true 时跳过依赖 wx-server-sdk 的模块
 *                                   （小程序端需要，云函数端需要全量）
 */
function syncTo(destDir, label, excludeCloudOnly) {
  const files = listSharedFiles().filter((f) => !(excludeCloudOnly && CLOUD_ONLY.includes(f)));
  let n = 0;
  for (const f of files) {
    const src = path.join(SRC_DIR, f);
    const content = fs.readFileSync(src, 'utf8');
    if (writeIfChanged(path.join(destDir, f), content, `${label}/${f}`)) n += 1;
  }
  return n;
}

/** 清理小程序端副本中不该存在的云函数专属模块（历史遗留或手动复制产生的） */
function pruneCloudOnlyFromMiniprogram() {
  for (const f of CLOUD_ONLY) {
    const p = path.join(MP_DEST, f);
    if (fs.existsSync(p)) {
      if (CHECK_MODE) {
        console.log(`  ✗ 小程序端残留云函数专属模块：${f}`);
        hasDiff = true;
      } else {
        fs.unlinkSync(p);
        console.log(`  − 已移除 miniprogram/shared/${f}（云函数专属）`);
      }
    }
  }
}

/**
 * 安全检查：小程序端不得引用云函数专属模块。
 * 这是一种编译期才会暴露的错误，提前在这里拦住成本低得多。
 */
function assertMiniprogramDoesNotRequireCloudOnly() {
  const mpDir = path.join(ROOT, 'miniprogram');
  if (!fs.existsSync(mpDir)) return;

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // 跳过同步副本自身，它本来就包含这些文件
      if (full.startsWith(MP_DEST)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const mod of CLOUD_ONLY) {
          const base = mod.replace(/\.js$/, '');
          // 匹配 require('.../ctx') 或 require('...ctx.js')
          const re = new RegExp(`require\\(\\s*['"\`][^'"\`]*/${base}(\\.js)?['"\`]\\s*\\)`);
          if (re.test(text)) {
            offenders.push(`${path.relative(ROOT, full)} 引用了云函数专属模块 ${mod}`);
          }
        }
      }
    }
  };
  walk(mpDir);

  if (offenders.length) {
    console.error('\n✗ 小程序端引用了云函数专属模块（这些模块依赖 wx-server-sdk，小程序端无法运行）：');
    for (const o of offenders) console.error(`   - ${o}`);
    if (!CHECK_MODE) process.exit(1);
    hasDiff = true;
  }
}

function main() {
  console.log(CHECK_MODE ? '检查 shared/ 同步状态…' : '同步 shared/ …');
  console.log(`源目录：${path.relative(ROOT, SRC_DIR)}  （共 ${listSharedFiles().length} 个模块）\n`);

  console.log('[1/2] 小程序端（不含云函数专属模块）');
  syncTo(MP_DEST, 'miniprogram/shared', true);
  pruneCloudOnlyFromMiniprogram();

  console.log('\n[2/2] 云函数端（全量）');
  if (!fs.existsSync(CF_ROOT)) {
    console.log('  （cloudfunctions/ 尚不存在，跳过）');
  } else {
    const fns = fs
      .readdirSync(CF_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const fn of fns) {
      syncTo(path.join(CF_ROOT, fn, 'lib', 'shared'), `${fn}/lib/shared`, false);
    }
  }

  console.log('\n安全检查');
  assertMiniprogramDoesNotRequireCloudOnly();

  console.log('\n云函数专属模块（不下发到小程序端）：');
  for (const m of CLOUD_ONLY) console.log(`   - ${m}`);

  if (CHECK_MODE) {
    if (hasDiff) {
      console.error('\n✗ shared/ 存在未同步的改动，请运行：node scripts/sync-shared.js');
      process.exit(1);
    }
    console.log('\n✓ 已同步，无差异');
  } else {
    console.log('\n✓ 完成');
  }
}

main();
