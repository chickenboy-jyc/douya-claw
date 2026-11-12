/**
 * posterTemplates —— 「海报」模式的模板数据（6 套口腔门诊真实场景）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【这一份文件只放**数据**，不放渲染逻辑】
 *   模板的样子由 `PosterStudio.jsx` 的 `drawPoster()` 画出来 —— 预览与导出共用
 *   同一份绘制函数，所以模板数据里绝不允许出现「只有预览看得见的样式」
 *   （比如用 DOM 的背景图、CSS 渐变）。所有视觉都在图层字段里，谁都画得出来。
 *
 * 【为什么模板只做「一键套用」，不做「锁定」】
 *   目标用户是「完全不懂设计的门诊前台 / 老板」。他们最怕的是「点了模板之后
 *   有些东西改不动，我是不是搞坏了」。
 *   所以套用只是把图层数组换掉 —— 之后每一个字、每一张图、每一个颜色都能改，
 *   没有任何只读层。这也是「模板 → 改几个字 → 换张图 → 导出」这条动线的底线。
 *
 * 【配色为什么全是绿色系】
 *   老板偏好绿色（本仓主色 `#1f7a4d` 一类），而且明确**不要黑色主调、不要蓝色主调**。
 *   所以 6 套模板的 `palette` 里没有一个纯黑（#000）也没有一个蓝（hue 200-260）。
 *   正文颜色用「深绿灰」（如 `#123328`）而不是 `#000`，在浅底上对比度够（≥ 7:1）
 *   又不刺眼 —— 诊所海报挂在墙上、印在传单上，纯黑正文会显脏。
 *
 * 【坐标口径：全部按 `POSTER_BASE`（1080×1440）写死】
 *   套用时会按当前画布尺寸等比缩放（见 `templateToLayers()`）。
 *   这样 6 套模板只需要维护一套坐标，切 1:1 / 9:16 / 16:9 也不会错位。
 * ════════════════════════════════════════════════════════════════════════════
 */

/** 模板的基准画布。所有模板坐标都按这一套写，套用时按比例缩放。 */
export const POSTER_BASE = { width: 1080, height: 1440 };

/**
 * 模板调色板里必须有的键（`PosterStudio.jsx` 套用模板时读 `palette.bg`）。
 * 其余键只是给模板自己内部引用，渲染层不依赖。
 *
 * @typedef {Object} PosterPalette
 * @property {string} bg      画布底色
 * @property {string} primary 主色（绿系）
 * @property {string} deep    深色块（深绿，不是黑）
 * @property {string} soft    浅色卡片底
 * @property {string} accent  强调色（浅绿）
 * @property {string} ink     正文色（深绿灰）
 * @property {string} sub     次要文字色（灰绿）
 */

/**
 * 6 套模板。字段：
 *   · key      稳定标识（保存项目时落盘用，不要改）
 *   · name     展示名（也用于 `window.__posterTest.applyTemplate(name)`）
 *   · desc     一句话说明「这套模板适合什么时候用」
 *   · palette  配色
 *   · decor    左栏小卡片上的装饰色块（纯展示，三个颜色）
 *   · layers   图层数组，坐标按 POSTER_BASE
 *
 * 图层字段（与 `PosterStudio.jsx` 的图层模型完全一致）：
 *   { type:'text'|'image'|'shape', name, x,y,w,h, opacity, z, hidden,
 *     // text
 *     text, fontSize, color, weight, align, lineHeight, letterSpacing, maxLines,
 *     // shape
 *     fill, radius,
 *     // image（模板里不用图片层：门诊的照片得用户自己导入）
 *     src, fit, radius, filters }
 *
 * @type {ReadonlyArray<{key:string, name:string, desc:string, palette:PosterPalette, decor:string[], layers:object[]}>}
 */
export const POSTER_TEMPLATES = [
  {
    key: 'opening',
    name: '新店开业',
    desc: '开业前两周 · 到店礼 / 洗牙特价 / 门店地址',
    palette: {
      bg: '#f4faf6',
      primary: '#1f7a4d',
      deep: '#14432f',
      soft: '#ffffff',
      accent: '#bfe3cd',
      ink: '#123328',
      sub: '#5e7f70',
    },
    decor: ['#1f7a4d', '#bfe3cd', '#ffffff'],
    layers: [
      { type: 'shape', name: '顶部绿条', x: 0, y: 0, w: 1080, h: 430, fill: '#1f7a4d', radius: 0, z: 1 },
      { type: 'shape', name: '装饰圆', x: 748, y: 58, w: 260, h: 260, fill: '#2b8f5c', radius: 130, opacity: 0.55, z: 2 },
      {
        type: 'text', name: '主标题', x: 80, y: 118, w: 620, h: 140,
        text: '新店开业', fontSize: 104, color: '#ffffff', weight: 800, align: 'left',
        lineHeight: 1.15, letterSpacing: 6, z: 3,
      },
      {
        type: 'text', name: '开业利益点', x: 80, y: 268, w: 700, h: 90,
        text: '洗牙 9.9 元 起', fontSize: 62, color: '#d9f2e2', weight: 700, align: 'left',
        lineHeight: 1.3, letterSpacing: 2, z: 4,
      },
      { type: 'shape', name: '白色卡片', x: 80, y: 500, w: 920, h: 440, fill: '#ffffff', radius: 28, z: 5 },
      {
        type: 'text', name: '卡片标题', x: 132, y: 552, w: 820, h: 80,
        text: '开业三重礼', fontSize: 52, color: '#123328', weight: 800, align: 'left',
        lineHeight: 1.3, letterSpacing: 2, z: 6,
      },
      {
        type: 'text', name: '礼物清单', x: 132, y: 660, w: 820, h: 250,
        text: '① 到店免费口腔检查\n② 洗牙 9.9 元（限前 100 名）\n③ 种植咨询送全景片',
        fontSize: 34, color: '#2c5b45', weight: 500, align: 'left',
        lineHeight: 2, letterSpacing: 0, z: 7,
      },
      {
        type: 'text', name: '门店地址', x: 80, y: 1230, w: 920, h: 70,
        text: 'XX 口腔 · XX 路 88 号 3 楼（地铁 X 号线 X 站 B 口）',
        fontSize: 28, color: '#5e7f70', weight: 400, align: 'left',
        lineHeight: 1.5, letterSpacing: 0, maxLines: 1, z: 8,
      },
      {
        type: 'text', name: '预约电话', x: 80, y: 1310, w: 920, h: 80,
        text: '预约到店 400-000-0000', fontSize: 40, color: '#1f7a4d', weight: 800, align: 'left',
        lineHeight: 1.4, letterSpacing: 1, z: 9,
      },
    ],
  },
  {
    key: 'implant',
    name: '种植牙优惠',
    desc: '种植专场 · 立减金额 / 种植体品牌 / 质保',
    palette: {
      bg: '#f2f8f4',
      primary: '#1f7a4d',
      deep: '#0f3d2a',
      soft: '#e8f4ed',
      accent: '#a9dcbf',
      ink: '#123328',
      sub: '#5e7f70',
    },
    decor: ['#0f3d2a', '#a9dcbf', '#ffffff'],
    layers: [
      { type: 'shape', name: '左侧竖条', x: 0, y: 0, w: 28, h: 1440, fill: '#1f7a4d', radius: 0, z: 1 },
      {
        type: 'text', name: '小标签', x: 88, y: 132, w: 560, h: 60,
        text: '种植专场 · 限时 15 天', fontSize: 30, color: '#1f7a4d', weight: 700, align: 'left',
        lineHeight: 1.4, letterSpacing: 4, z: 2,
      },
      {
        type: 'text', name: '主标题', x: 88, y: 208, w: 900, h: 200,
        text: '种植牙\n单颗立减 2000 元', fontSize: 82, color: '#123328', weight: 800, align: 'left',
        lineHeight: 1.28, letterSpacing: 2, z: 3,
      },
      { type: 'shape', name: '强调块', x: 88, y: 560, w: 904, h: 260, fill: '#1f7a4d', radius: 24, z: 4 },
      {
        type: 'text', name: '强调文案', x: 132, y: 606, w: 816, h: 180,
        text: '进口种植体 · 终身质保\n含种植体 + 基台 + 冠，全包价',
        fontSize: 38, color: '#ffffff', weight: 600, align: 'left',
        lineHeight: 1.75, letterSpacing: 1, z: 5,
      },
      { type: 'shape', name: '说明卡', x: 88, y: 880, w: 904, h: 300, fill: '#e8f4ed', radius: 24, z: 6 },
      {
        type: 'text', name: '说明文字', x: 132, y: 928, w: 816, h: 220,
        text: '· 免费拍片 + 免费方案设计\n· 主任医师亲自种植\n· 术后一年内免费复查',
        fontSize: 32, color: '#14432f', weight: 500, align: 'left',
        lineHeight: 1.95, letterSpacing: 0, z: 7,
      },
      {
        type: 'text', name: '行动号召', x: 88, y: 1250, w: 904, h: 90,
        text: '拨打 400-000-0000 预约面诊', fontSize: 42, color: '#1f7a4d', weight: 800, align: 'left',
        lineHeight: 1.4, letterSpacing: 1, z: 8,
      },
      {
        type: 'text', name: '备注', x: 88, y: 1340, w: 904, h: 60,
        text: '* 优惠不与其他活动同享，具体以门诊报价为准', fontSize: 24, color: '#5e7f70',
        weight: 400, align: 'left', lineHeight: 1.5, letterSpacing: 0, z: 9,
      },
    ],
  },
  {
    key: 'fluoride',
    name: '儿童涂氟',
    desc: '亲子场景 · 价格 / 适龄 / 时长，家长一眼看懂',
    palette: {
      bg: '#f7fbf4',
      primary: '#2f8f5b',
      deep: '#17513a',
      soft: '#ffffff',
      accent: '#d8eecb',
      ink: '#173a2a',
      sub: '#6a8a76',
    },
    decor: ['#2f8f5b', '#d8eecb', '#ffffff'],
    layers: [
      { type: 'shape', name: '顶部浅绿块', x: 0, y: 0, w: 1080, h: 640, fill: '#d8eecb', radius: 0, z: 1 },
      { type: 'shape', name: '圆形装饰', x: 700, y: 400, w: 340, h: 340, fill: '#2f8f5b', radius: 170, opacity: 0.25, z: 2 },
      {
        type: 'text', name: '主标题', x: 90, y: 150, w: 800, h: 120,
        text: '儿童全口涂氟', fontSize: 86, color: '#173a2a', weight: 800, align: 'left',
        lineHeight: 1.25, letterSpacing: 3, z: 3,
      },
      {
        type: 'text', name: '价格', x: 90, y: 300, w: 620, h: 160,
        text: '88 元', fontSize: 120, color: '#2f8f5b', weight: 900, align: 'left',
        lineHeight: 1.1, letterSpacing: 0, z: 4,
      },
      {
        type: 'text', name: '适龄说明', x: 90, y: 470, w: 700, h: 70,
        text: '3-12 岁 · 全程 20 分钟 · 无痛', fontSize: 34, color: '#173a2a', weight: 600,
        align: 'left', lineHeight: 1.5, letterSpacing: 1, z: 5,
      },
      { type: 'shape', name: '说明卡', x: 90, y: 720, w: 900, h: 400, fill: '#ffffff', radius: 24, z: 6 },
      {
        type: 'text', name: '说明标题', x: 140, y: 772, w: 800, h: 70,
        text: '为什么建议每半年涂一次', fontSize: 40, color: '#173a2a', weight: 800,
        align: 'left', lineHeight: 1.4, letterSpacing: 1, z: 7,
      },
      {
        type: 'text', name: '说明正文', x: 140, y: 862, w: 800, h: 220,
        text: '涂氟能在牙齿表面形成保护层，\n降低儿童蛀牙风险，第一次建议 3 岁左右。',
        fontSize: 30, color: '#3d6152', weight: 400, align: 'left',
        lineHeight: 1.9, letterSpacing: 0, z: 8,
      },
      {
        type: 'text', name: '底部提示', x: 90, y: 1210, w: 900, h: 90,
        text: '预约电话 400-000-0000 · XX 口腔', fontSize: 34, color: '#2f8f5b', weight: 700,
        align: 'left', lineHeight: 1.5, letterSpacing: 0, z: 9,
      },
    ],
  },
  {
    key: 'ortho',
    name: '正畸咨询',
    desc: '隐形矫正 · 免费拍片建模 / 一对一面诊',
    palette: {
      bg: '#f5faf7',
      primary: '#1f7a4d',
      deep: '#123a2a',
      soft: '#e9f5ef',
      accent: '#c6e6d5',
      ink: '#123328',
      sub: '#5e7f70',
    },
    decor: ['#123a2a', '#c6e6d5', '#ffffff'],
    layers: [
      { type: 'shape', name: '底部深绿块', x: 0, y: 1000, w: 1080, h: 440, fill: '#123a2a', radius: 0, z: 1 },
      {
        type: 'text', name: '小标签', x: 88, y: 120, w: 700, h: 60,
        text: '正畸初诊 · 免费咨询', fontSize: 30, color: '#1f7a4d', weight: 700, align: 'left',
        lineHeight: 1.4, letterSpacing: 4, z: 2,
      },
      {
        type: 'text', name: '主标题', x: 88, y: 200, w: 900, h: 240,
        text: '隐形矫正\n先看方案再决定', fontSize: 80, color: '#123328', weight: 800,
        align: 'left', lineHeight: 1.3, letterSpacing: 2, z: 3,
      },
      {
        type: 'text', name: '副标题', x: 88, y: 470, w: 860, h: 120,
        text: '免费拍片 + 免费口扫建模 + 一对一方案设计', fontSize: 34, color: '#3d6152',
        weight: 500, align: 'left', lineHeight: 1.7, letterSpacing: 0, z: 4,
      },
      { type: 'shape', name: '流程卡片', x: 88, y: 640, w: 904, h: 300, fill: '#e9f5ef', radius: 24, z: 5 },
      {
        type: 'text', name: '流程文字', x: 132, y: 692, w: 816, h: 220,
        text: '① 到店拍片、口扫建模（约 30 分钟）\n② 医生出方案与报价\n③ 决定后再开始，不做也能走',
        fontSize: 30, color: '#14432f', weight: 500, align: 'left',
        lineHeight: 2, letterSpacing: 0, z: 6,
      },
      {
        type: 'text', name: '底部标题', x: 88, y: 1070, w: 904, h: 90,
        text: '本月预约免挂号费', fontSize: 52, color: '#ffffff', weight: 800, align: 'left',
        lineHeight: 1.4, letterSpacing: 2, z: 7,
      },
      {
        type: 'text', name: '底部电话', x: 88, y: 1180, w: 904, h: 80,
        text: '400-000-0000 · XX 口腔正畸中心', fontSize: 34, color: '#c6e6d5', weight: 500,
        align: 'left', lineHeight: 1.5, letterSpacing: 0, z: 8,
      },
    ],
  },
  {
    key: 'holiday',
    name: '节假日祝福',
    desc: '放假通知 + 祝福，顺手把营业时间说清楚',
    palette: {
      bg: '#f6faf3',
      primary: '#1f7a4d',
      deep: '#14432f',
      soft: '#ffffff',
      accent: '#e5f1d8',
      ink: '#14352a',
      sub: '#6a8a76',
    },
    decor: ['#14432f', '#e5f1d8', '#ffffff'],
    layers: [
      { type: 'shape', name: '顶部色块', x: 0, y: 0, w: 1080, h: 520, fill: '#14432f', radius: 0, z: 1 },
      { type: 'shape', name: '圆环', x: 620, y: 90, w: 380, h: 380, fill: '#2b8f5c', radius: 190, opacity: 0.35, z: 2 },
      {
        type: 'text', name: '祝福标题', x: 90, y: 190, w: 800, h: 150,
        text: '中秋安康', fontSize: 108, color: '#ffffff', weight: 800, align: 'left',
        lineHeight: 1.2, letterSpacing: 8, z: 3,
      },
      {
        type: 'text', name: '祝福副句', x: 90, y: 360, w: 800, h: 80,
        text: '愿您和家人，齿间有味，笑里有光', fontSize: 34, color: '#c6e6d5', weight: 400,
        align: 'left', lineHeight: 1.6, letterSpacing: 1, z: 4,
      },
      { type: 'shape', name: '通知卡', x: 90, y: 620, w: 900, h: 420, fill: '#ffffff', radius: 24, z: 5 },
      {
        type: 'text', name: '通知标题', x: 140, y: 672, w: 800, h: 80,
        text: '放假与开诊安排', fontSize: 46, color: '#14352a', weight: 800, align: 'left',
        lineHeight: 1.4, letterSpacing: 2, z: 6,
      },
      {
        type: 'text', name: '通知正文', x: 140, y: 762, w: 800, h: 260,
        text: '9 月 29 日 - 9 月 30 日 放假两天\n10 月 1 日起 正常接诊（8:30-18:00）\n急诊请拨 400-000-0000',
        fontSize: 32, color: '#3d6152', weight: 500, align: 'left',
        lineHeight: 2, letterSpacing: 0, z: 7,
      },
      {
        type: 'text', name: '落款', x: 90, y: 1200, w: 900, h: 90,
        text: 'XX 口腔 · 全体医护敬上', fontSize: 34, color: '#1f7a4d', weight: 700,
        align: 'left', lineHeight: 1.5, letterSpacing: 1, z: 8,
      },
    ],
  },
  {
    key: 'doctor',
    name: '医生介绍',
    desc: '医生名片式海报：职称 / 年限 / 擅长 / 出诊时间',
    palette: {
      bg: '#f4f9f6',
      primary: '#1f7a4d',
      deep: '#123a2a',
      soft: '#ffffff',
      accent: '#cfe8db',
      ink: '#123328',
      sub: '#5e7f70',
    },
    decor: ['#1f7a4d', '#cfe8db', '#ffffff'],
    layers: [
      { type: 'shape', name: '左侧色块', x: 0, y: 0, w: 400, h: 1440, fill: '#1f7a4d', radius: 0, z: 1 },
      // 医生照片：**故意留空 src**，靠占位标记在预览里画虚线圆形 + 「放医生照片」。
      // 为什么不画一个灰色圆当占位：灰圆会被用户当成"已经放好的图"，他导出后才发现
      // 照片位是空的。虚线圆 + 中心提示是唯一能让人一眼看出"这里要我做点事"的画法。
      // 导出时这个图层**一个像素都不画**（见 PosterStudio.drawPoster 的 opts 边界）。
      {
        type: 'image', name: '医生照片', src: '', placeholder: true, placeholderLabel: '放医生照片',
        x: 90, y: 180, w: 240, h: 240, radius: 120, fit: 'cover', z: 2,
      },
      {
        type: 'text', name: '姓名', x: 90, y: 500, w: 260, h: 90,
        text: '张 医 生', fontSize: 54, color: '#ffffff', weight: 800, align: 'left',
        lineHeight: 1.3, letterSpacing: 4, z: 4,
      },
      {
        type: 'text', name: '职称', x: 90, y: 600, w: 280, h: 120,
        text: '主治医师\n口腔种植修复', fontSize: 28, color: '#cfe8db', weight: 400,
        align: 'left', lineHeight: 1.7, letterSpacing: 1, z: 5,
      },
      {
        type: 'text', name: '右侧标题', x: 460, y: 200, w: 540, h: 90,
        text: '从业 15 年', fontSize: 62, color: '#123328', weight: 800, align: 'left',
        lineHeight: 1.3, letterSpacing: 2, z: 6,
      },
      {
        type: 'text', name: '资历', x: 460, y: 320, w: 540, h: 220,
        text: '种植修复 3000+ 例\n隐适美认证医师\n省口腔医学会会员', fontSize: 32, color: '#3d6152',
        weight: 500, align: 'left', lineHeight: 2, letterSpacing: 0, z: 7,
      },
      { type: 'shape', name: '擅长卡片', x: 460, y: 620, w: 540, h: 300, fill: '#ffffff', radius: 24, z: 8 },
      {
        type: 'text', name: '擅长内容', x: 500, y: 668, w: 460, h: 230,
        text: '擅长：\n单颗 / 多颗种植、全口修复、\n前牙美学修复', fontSize: 30, color: '#123328',
        weight: 500, align: 'left', lineHeight: 1.9, letterSpacing: 0, z: 9,
      },
      {
        type: 'text', name: '出诊时间', x: 460, y: 1000, w: 540, h: 150,
        text: '出诊：周一 / 周三 / 周五\n8:30 - 17:30（需提前预约）', fontSize: 30, color: '#1f7a4d',
        weight: 600, align: 'left', lineHeight: 1.8, letterSpacing: 0, z: 10,
      },
      {
        type: 'text', name: '预约电话', x: 460, y: 1200, w: 540, h: 80,
        text: '400-000-0000', fontSize: 44, color: '#123328', weight: 800, align: 'left',
        lineHeight: 1.4, letterSpacing: 2, z: 11,
      },
    ],
  },
];

/**
 * 模板名列表。
 *
 * `window.__posterTest.templates()` 直接用它，所以**名字就是对外契约**：
 * 改名字等于改自动化接口，豆芽 Agent 生成海报时会按名字套模板。
 *
 * @returns {string[]} 6 个模板名，顺序与左栏一致
 */
export function posterTemplateNames() {
  return POSTER_TEMPLATES.map((t) => t.name);
}

/**
 * 按名字找模板。名字对不上时返回 `null`（调用方负责给提示，别静默当第一个）。
 *
 * @param {string} name 模板名（`POSTER_TEMPLATES[].name`）
 * @returns {object|null}
 */
export function findTemplate(name) {
  const key = String(name == null ? '' : name).trim();
  if (!key) return null;
  for (const t of POSTER_TEMPLATES) {
    if (t.name === key || t.key === key) return t;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 占位文案：填充（能填的真填）+ 检测（填不了的显式拦住）
// ─────────────────────────────────────────────────────────────────────────────
//
// 【为什么这两个纯函数住在这里，而不是塞进 PosterStudio.jsx】
//   ① 它们**不依赖 React、不依赖 store、不做 IO** —— 只吃字符串 / 图层数组。
//      放在本文件里，node 侧一个 `import` 就能直接调用（自验探针正是这么做的），
//      而塞进 .jsx 里就得先过一遍 JSX 编译才能碰一下 "这段文字算不算占位"。
//   ② 本文件是「原型数据的唯一来源」。占位特征表与模板里的原型写法必须**同一处维护**
//      —— 模板改了原型写法（比如以后再出现 `XX 门诊`），这张表要跟着改，
//      分两个文件放必然有一天漂移成「模板印 XX、检测不认识 XX」。
//   ③ 但**模板数据本身一个字都不改**：`XX 口腔` / `400-000-0000` 是"原型"，
//      被填充才有意义。改的是「填充」和「拦截」这两层，不是把原型抹掉。
//
// 【为什么必须有一条"拦住"的路径，而不只是"自动填"】
//   企业资料里 **只有企业名**（`currentCompany` = {id, name, type, role, workspaceId, createdAt}，
//   见 store/companyStore.jsx 的 normalizeCompany / createCompany）。
//   **没有电话，也没有地址** —— 所以 `400-000-0000`、`XX 路 88 号`、`X 号线`、`X 站`
//   全部无数据源可填。硬撑着"自动填"只能靠编，编出来的号码/地址会被印在传单上发给顾客，
//   那比印着 `XX 口腔` 更糟。
//   ⇒ 能填的真填（企业名），填不了的**在导出前明确告诉用户是哪几层、原文是什么**，
//     由用户决定"去改"还是"就这么导"。绝不静默导出废图。

/**
 * store 自动补出来的「企业名」，不是用户填的真名 ⇒ 绝不往海报上印。
 * 依据：`companyStore.jsx:122` 的 `asStr(base.name) || '未命名企业'`、
 *      `:330` 迁移分支的 `name || '我的企业'`。
 */
const NON_REAL_COMPANY_NAMES = ['未命名企业', '我的企业'];

/**
 * 归一化企业名：去首尾空白、压掉换行、限长，并挡掉 store 的自动占位名。
 *
 * @param {any} companyName 候选企业名（`currentCompany.name`）
 * @returns {string} 可用于印刷的企业名；拿不到真名时返回空串（调用方据此不填充）
 */
export function cleanCompanyName(companyName) {
  const raw = String(companyName == null ? '' : companyName).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // 「未命名企业」/「我的企业」是 store 自己补的壳，印上去等于换了个假名 ⇒ 当作没名字。
  if (NON_REAL_COMPANY_NAMES.indexOf(raw) >= 0) return '';
  // 企业名是单行标题，超过 40 字一定是异常输入（粘错了整段话），不印。
  if (raw.length > 40) return '';
  return raw;
}

/**
 * 占位特征表。**只认「一定会被印在成品图上」的字面形态**，不做语义猜测。
 *
 * 口径（踩过的坑，别改回去）：`source` 存的是正则**源码**，每次检测现场
 * `new RegExp(source, 'g')`。绝不缓存带 `g` 标记的 RegExp 实例 —— 带 `g` 的
 * `.test()` 会推进 `lastIndex`，同一个实例反复用就会出现「第一次命中、第二次不命中」，
 * 而那正是本仓最贵的假绿形态（检测函数永远返回空数组，全绿，功能是死的）。
 */
const PLACEHOLDER_RULES = [
  { key: 'companyName', label: '企业名还是「XX 口腔」这类占位', source: '[XxＸｘ]{2,}\\s*口腔' },
  { key: 'doubleX', label: '还有「XX」占位（地址 / 路名 / 门牌 / 其它）', source: '[XxＸｘ]{2,}' },
  { key: 'examplePhone', label: '电话还是示例号 400-000-0000', source: '400[\\s\\-－]*0{3}[\\s\\-－]*0{4}' },
  { key: 'zeroPhone', label: '电话是形如 000-000-0000 的全 0 占位', source: '0{3,4}[\\s\\-－]*0{3,4}[\\s\\-－]*0{3,4}' },
  { key: 'metroLine', label: '地铁路线还是「X 号线」占位', source: '[XxＸｘ]\\s*号线' },
  { key: 'metroStation', label: '地铁站名还是「X 站」占位', source: '[XxＸｘ]\\s*站' },
  { key: 'doctorName', label: '医生姓名还是「张 医 生」占位', source: '张\\s*医\\s*生' },
];

/**
 * 扫描图层里的**文字层**，找出仍然含占位特征的文案。
 *
 * 跳过规则（都是"成品图上根本不会出现"的层，报了就是假红，假红会逼人把拦截关掉）：
 *   · 非文字层；
 *   · `hidden` 层 —— `drawPoster` 对 `layer.hidden` 直接 `continue`（见
 *     PosterStudio.jsx:790），隐藏层一个像素都不进导出图；
 *   · `opacity <= 0` 的层 —— 同上，`drawPoster` 对 alpha<=0 也是 `continue`；
 *   · 空白文案。
 *
 * @param {Array<{id?:string, name?:string, type?:string, text?:string, hidden?:boolean, opacity?:number}>} layers
 *   当前文档的图层数组（`doc.layers`）
 * @returns {Array<{layerId:string, layerName:string, text:string, matched:string[], labels:string[]}>}
 *   命中列表；`matched` 是命中的**原始字面**（去重），`labels` 是人话说明（去重）。
 *   0 命中返回空数组 —— 调用方据此决定"正常导出"。
 */
export function findPlaceholderTexts(layers) {
  const list = Array.isArray(layers) ? layers : [];
  const hits = [];
  for (const layer of list) {
    if (!layer || layer.type !== 'text') continue;
    if (layer.hidden) continue;
    if (Number(layer.opacity) <= 0) continue;
    const text = String(layer.text == null ? '' : layer.text);
    if (!text.trim()) continue;

    const matched = [];
    const labels = [];
    for (const rule of PLACEHOLDER_RULES) {
      // 每条规则现场编译（见 PLACEHOLDER_RULES 上方的 lastIndex 说明）
      const all = text.match(new RegExp(rule.source, 'g'));
      if (!all || all.length === 0) continue;
      for (const token of all) {
        const clean = String(token);
        if (matched.indexOf(clean) < 0) matched.push(clean);
      }
      if (labels.indexOf(rule.label) < 0) labels.push(rule.label);
    }
    if (matched.length === 0) continue;
    hits.push({
      layerId: String(layer.id == null ? '' : layer.id),
      layerName: String(layer.name == null ? '' : layer.name) || '未命名图层',
      text,
      matched,
      labels,
    });
  }
  return hits;
}

/**
 * 把一段文案里的**企业名占位**换成本企业真名。
 *
 * 只换「XX 口腔」这一整段原型短语，理由：
 *   · 企业名通常已经含「口腔」（如「康乐口腔」），逐字换 `XX` 会得到「康乐口腔 口腔」；
 *   · `XX 路 88 号` / `X 号线` / `X 站` 是**地址与站点**，企业资料里没有这些字段
 *     ⇒ 一个字节都不猜（猜出来的地址会把顾客导到别处去）。
 * 换不掉的那些，由 `findPlaceholderTexts()` 在导出前拦住并点名。
 *
 * 用**函数式替换**而不是 `'…' + name`：企业名里若含 `$&` / `$1` 这类字符，
 * 字符串形式的 replacement 会被当成替换模式解析，名字会被吃掉一部分。
 *
 * @param {any} text 原文
 * @param {any} companyName 企业名（`currentCompany.name`）
 * @returns {string} 填充后的文案；没有真名时原样返回（不动一个字符）
 */
export function fillCompanyPlaceholders(text, companyName) {
  const src = String(text == null ? '' : text);
  const name = cleanCompanyName(companyName);
  if (!src || !name) return src;
  return src.replace(/[XxＸｘ]{2,}\s*口腔/g, () => name);
}

/**
 * 对一个图层数组做企业名填充（只碰文字层，其它层原样带过去）。
 *
 * 为什么做成"返回新数组"而不是就地改：模板数据 `POSTER_TEMPLATES` 是模块级常量，
 * 就地改会污染下一次套用（第二家企业套同一套模板会拿到上一家的名字）。
 *
 * @param {object[]} layers `templateToLayers()` 产出的图层数组
 * @param {any} companyName 企业名
 * @returns {object[]} 填充后的图层数组；没有真名时返回**原数组**（调用方不必判空）
 */
export function fillCompanyNameInLayers(layers, companyName) {
  const list = Array.isArray(layers) ? layers : [];
  const name = cleanCompanyName(companyName);
  if (!name) return list;
  let changed = false;
  const next = list.map((layer) => {
    if (!layer || layer.type !== 'text') return layer;
    const before = String(layer.text == null ? '' : layer.text);
    const after = fillCompanyPlaceholders(before, name);
    if (after === before) return layer;
    changed = true;
    return Object.assign({}, layer, { text: after });
  });
  return changed ? next : list;
}

/**
 * 把模板图层换算到当前画布尺寸。
 *
 * 【为什么按比例缩放而不是清空重排】
 *   用户在 3:4 画布上套好模板、改完字，再切到 1:1 —— 如果清空重排，
 *   他刚改的文字全没了。按比例缩放至少保住相对位置与所有文案。
 *
 * 【字号为什么用 min(sx, sy)】
 *   16:9 的画布高度只有 1080 的一半，字号跟着 sy 缩会小到看不清；
 *   跟着 sx 走会溢出。取两者较小值 + 下限 14px 是实测最稳的口径。
 *
 * @param {string} name 模板名
 * @param {{width:number, height:number}} size 目标画布尺寸
 * @param {(type: string) => string} makeId 生成图层 id 的函数（由调用方提供，保证唯一）
 * @returns {object[]} 图层数组（id 已生成，可直接放进 state）
 */
export function templateToLayers(name, size, makeId) {
  const tpl = findTemplate(name);
  if (!tpl) return [];
  const target = size && Number(size.width) > 0 && Number(size.height) > 0 ? size : POSTER_BASE;
  const sx = Number(target.width) / POSTER_BASE.width;
  const sy = Number(target.height) / POSTER_BASE.height;
  const fontScale = Math.max(0.4, Math.min(sx, sy));
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return tpl.layers.map((src, index) => {
    const layer = {
      id: typeof makeId === 'function' ? makeId(src.type) : String(index + 1),
      name: src.name || '图层',
      type: src.type,
      x: Math.round(n(src.x) * sx),
      y: Math.round(n(src.y) * sy),
      w: Math.round(n(src.w) * sx),
      h: Math.round(n(src.h) * sy),
      opacity: Number.isFinite(Number(src.opacity)) ? Number(src.opacity) : 1,
      z: index + 1,
      hidden: false,
    };
    if (src.type === 'text') {
      layer.text = String(src.text == null ? '' : src.text);
      layer.fontSize = Math.max(14, Math.round(n(src.fontSize) * fontScale));
      layer.color = src.color || '#123328';
      layer.weight = n(src.weight) || 600;
      layer.align = src.align === 'center' ? 'center' : src.align === 'right' ? 'right' : 'left';
      layer.lineHeight = Number.isFinite(Number(src.lineHeight)) ? Number(src.lineHeight) : 1.4;
      layer.letterSpacing = n(src.letterSpacing);
      layer.maxLines = n(src.maxLines);
    } else if (src.type === 'shape') {
      layer.fill = src.fill || '#1f7a4d';
      layer.radius = Math.round(n(src.radius) * Math.min(sx, sy));
    } else if (src.type === 'image') {
      // 模板里的图片图层目前都是“占位待填”（`src` 为空）。字段必须原样带过去：
      // 少了 `placeholder` 预览里就没有虚线框，少了 `placeholderLabel` 用户不知道该放什么。
      layer.src = String(src.src == null ? '' : src.src);
      layer.fit = src.fit === 'contain' ? 'contain' : 'cover';
      layer.radius = Math.round(n(src.radius) * Math.min(sx, sy));
      layer.filters = Object.assign({}, src.filters || {});
      layer.placeholder = !!src.placeholder;
      layer.placeholderLabel = String(src.placeholderLabel || '放图片');
    }
    return layer;
  });
}
