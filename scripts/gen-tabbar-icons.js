/*
 * 生成 tabBar 图标 PNG。
 *
 *   node scripts/gen-tabbar-icons.js
 *
 * ★ 这不是构建步骤。产物（miniprogram/images/tabbar/*.png）已经提交进仓库，
 *   导入微信开发者工具即可直接编译。只有要改图标形状或换主色时才需要重跑。
 *
 * ★ 为什么留这个脚本而不是生成完删掉：小程序 tabBar 只认 PNG 文件，
 *   不能引用 app.wxss 的令牌。主色一旦调整（--primary / tabBar.selectedColor），
 *   图标颜色必须跟着重新生成 —— 否则会出现"图标是旧蓝、文字是新蓝"。
 *   没有脚本就只能手工重画 8 张图。
 *
 * 图标为 81×81（微信推荐的 tabBar 图标尺寸），单色轮廓，透明底。
 * 只画形状，不填色；颜色由 --ink / --ink-on 两个常量决定。
 *
 * 目前共五个页签各一对（未选中 / 选中），合计 10 张。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 81;   // 画布边长（px）
const SS = 4;      // 超采样倍数：以 4 倍分辨率判定覆盖，再降采样得到抗锯齿边缘

/* 与 app.json 的 tabBar.color / tabBar.selectedColor 保持一致。
   ★ 改这里就要同步改 app.json —— tabBar 配置是静态 JSON，引用不了变量。 */
const INK_OFF = '#8A8F99';
const INK_ON = '#2563EB';

// ─────────────────────────────────────────────────────────────────────────────
// 几何：有向距离场。所有图元都返回"到形状的距离"，负值表示在内部。
// ─────────────────────────────────────────────────────────────────────────────

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = px - ax;
  const vy = py - ay;
  const ux = bx - ax;
  const uy = by - ay;
  const len2 = ux * ux + uy * uy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (vx * ux + vy * uy) / len2));
  return Math.hypot(vx - ux * t, vy - uy * t);
}

/* 凸/凹多边形填充（iq 的标准写法：外部取最短距离，内部按绕数取负） */
function sdPolygon(px, py, pts) {
  const n = pts.length;
  let d = Infinity;
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    const ex = xj - xi;
    const ey = yj - yi;
    const wx = px - xi;
    const wy = py - yi;
    const len2 = ex * ex + ey * ey;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * ex + wy * ey) / len2));
    d = Math.min(d, Math.hypot(wx - ex * t, wy - ey * t));
    const c1 = py >= yi;
    const c2 = py < yj;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * d;
}

/* 圆弧中心线（角度用画布坐标：0=右，π/2=下）。超出角度范围时取到端点的距离。 */
function sdArc(px, py, cx, cy, r, a0, a1) {
  const dx = px - cx;
  const dy = py - cy;
  let ang = Math.atan2(dy, dx);
  while (ang < a0) ang += Math.PI * 2;
  if (ang <= a1) return Math.abs(Math.hypot(dx, dy) - r);
  const p0x = cx + r * Math.cos(a0);
  const p0y = cy + r * Math.sin(a0);
  const p1x = cx + r * Math.cos(a1);
  const p1y = cy + r * Math.sin(a1);
  return Math.min(Math.hypot(px - p0x, py - p0y), Math.hypot(px - p1x, py - p1y));
}

/* 折线描边（圆头圆角）。开放路径用它，闭合多边形用 polyStroke。 */
function sdPolyline(px, py, pts) {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) {
    d = Math.min(d, sdSegment(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  }
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// 图元构造器：每个返回 (px, py) => 是否落在墨迹内
// ─────────────────────────────────────────────────────────────────────────────

const rrStroke = (cx, cy, hw, hh, r, w) =>
  (px, py) => Math.abs(sdRoundRect(px, py, cx, cy, hw, hh, r)) <= w / 2;

const rrFill = (cx, cy, hw, hh, r) =>
  (px, py) => sdRoundRect(px, py, cx, cy, hw, hh, r) <= 0;

const circleStroke = (cx, cy, r, w) =>
  (px, py) => Math.abs(Math.hypot(px - cx, py - cy) - r) <= w / 2;

const arcStroke = (cx, cy, r, a0, a1, w) =>
  (px, py) => sdArc(px, py, cx, cy, r, a0, a1) <= w / 2;

const lineStroke = (pts, w) => (px, py) => sdPolyline(px, py, pts) <= w / 2;

const polyStroke = (pts, w) => (px, py) => Math.abs(sdPolygon(px, py, pts)) <= w / 2;

const polyFill = (pts) => (px, py) => sdPolygon(px, py, pts) <= 0;

const union = (...prims) => (px, py) => {
  for (let i = 0; i < prims.length; i++) if (prims[i](px, py)) return true;
  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// 五个图标。坐标直接写在 81×81 的画布空间里，图形居中，四周留 ~20px 出血。
// ─────────────────────────────────────────────────────────────────────────────

const W = 4.2; // 主描边宽度

// 报任务：文档 + 对勾（"我的任务／上报"）
const ICON_REPORT = union(
  rrStroke(40.5, 40.5, 17.5, 22.5, 5.5, W),
  lineStroke([[30.5, 41.5], [36.5, 47.5], [51, 33]], W)
);

// 改任务：铅笔（笔身 + 笔尖，共用一条交界线）
const P_OFF = 3.89; // 笔身半宽 5.5 在 45° 方向上的分量
const P_E = [55.1, 25.9];   // 笔尾
const P_S = [28.46, 52.54]; // 笔身与笔尖的交界
const P_T = [22.1, 58.9];   // 笔尖
const P_BODY = [
  [P_E[0] + P_OFF, P_E[1] + P_OFF],
  [P_S[0] + P_OFF, P_S[1] + P_OFF],
  [P_S[0] - P_OFF, P_S[1] - P_OFF],
  [P_E[0] - P_OFF, P_E[1] - P_OFF],
];
const P_TIP = [
  [P_S[0] + P_OFF, P_S[1] + P_OFF],
  P_T,
  [P_S[0] - P_OFF, P_S[1] - P_OFF],
];

const ICON_UPDATE = union(polyStroke(P_BODY, W), polyStroke(P_TIP, W));

/*
 * 任务看板：外框 + 两条分栏线 = 三栏。
 *
 * ★ 试过在每列顶部加一张实心小卡片（Material 的 view_kanban 那种），
 *   81px 下卡片会和分栏线糊成一片，读起来像"表格的表头行"而不是看板，
 *   所以去掉了。只留分栏线反而干净、一眼就是"分栏"。
 * ★ 外框比报任务的文档框更扁（42×36 vs 35×45），两个图标不会看混。
 */
const ICON_BOARD = union(
  rrStroke(40.5, 40.5, 21, 18, 6, W),
  lineStroke([[33.5, 29], [33.5, 52]], 3.6),
  lineStroke([[47.5, 29], [47.5, 52]], 3.6)
);

// 人员看板：头 + 肩（上半圆）
const ICON_PEOPLE = union(
  circleStroke(40.5, 27.5, 9, W),
  arcStroke(40.5, 61.5, 17.5, Math.PI, Math.PI * 2, W)
);

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

// ─────────────────────────────────────────────────────────────────────────────
// 光栅化 + PNG 编码
// ─────────────────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/* 以 SS 倍超采样判定覆盖率，再降采样 —— 得到抗锯齿的 alpha */
function rasterize(inside) {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hit++;
        }
      }
      px[(y * SIZE + x) * 4 + 3] = Math.round(Math.sqrt(hit * inv) * 255);
    }
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba) {
  const stride = SIZE * 4 + 1;
  const raw = Buffer.alloc(SIZE * stride);
  for (let y = 0; y < SIZE; y++) {
    raw[y * stride] = 0; // filter type 0
    rgba.copy(raw, y * stride + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function emit(dir, name, inside, hex) {
  const [r, g, b] = hexToRgb(hex);
  const px = rasterize(inside);
  for (let i = 0; i < SIZE * SIZE; i++) {
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
  }
  const file = path.join(dir, name + '.png');
  fs.writeFileSync(file, encodePNG(px));
  return file;
}

const ICONS = [
  ['demand', ICON_DEMAND, '领需求'],
  ['report', ICON_REPORT, '报任务'],
  ['update', ICON_UPDATE, '改任务'],
  ['board', ICON_BOARD, '任务看板'],
  ['people', ICON_PEOPLE, '人员看板'],
];

function main() {
  const dir = path.join(__dirname, '..', 'miniprogram', 'images', 'tabbar');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, inside, label] of ICONS) {
    const a = emit(dir, name, inside, INK_OFF);
    const b = emit(dir, name + '-on', inside, INK_ON);
    console.log(
      '  ' + label.padEnd(6) +
      path.basename(a).padEnd(14) + fs.statSync(a).size + ' B   ' +
      path.basename(b).padEnd(14) + fs.statSync(b).size + ' B'
    );
  }
  console.log('\n✓ 已生成 10 个图标 → miniprogram/images/tabbar/');
}

main();
