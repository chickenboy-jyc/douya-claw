/**
 * geoPlatforms —— GEO 平台账号矩阵的基础数据（第 8 项改造）。
 *
 * 与旧版 GEO_PLATFORMS 的区别：
 * - 旧版只有「注册入口 + 推荐理由 + 注册指引」，用户注册完无处回填；
 * - 新版把「注册」和「发文」拆开：registerUrl 用于首次开通，publishUrl 用于已登录的创作者后台一键发文。
 *
 * 字段约定：
 * - key        平台唯一标识，localStorage 里按 key 存账号，改名不影响历史数据。
 * - name       平台中文名（展示用）。
 * - icon       emoji 图标（不用图片资源，避免打包体积）。
 * - registerUrl 注册/入驻入口。
 * - publishUrl  创作者后台「发文页」直达地址。**必须是发文页，不是注册页**。
 *               不确定的一律留空字符串，前端 UI 会禁用按钮并提示「暂不支持」，避免跳到错误的页面。
 * - audience   这个平台承接什么人；B2B 企业据此判断值不值得投入。
 * - hasData    publishUrl 是否已确认可用（false = 暂不支持一键发文）。
 */

export const GEO_PLATFORMS = [
  {
    key: 'zhihu',
    name: '知乎',
    icon: '🧠',
    registerUrl: 'https://www.zhihu.com/signup',
    publishUrl: 'https://zhuanlan.zhihu.com/write',
    audience: '行业决策者 / 采购前调研人群，长尾搜索承接强，B2B 专业背书主阵地',
    hasData: true,
  },
  {
    key: 'xiaohongshu',
    name: '小红书',
    icon: '📕',
    registerUrl: 'https://creator.xiaohongshu.com',
    publishUrl: '',
    audience: '以个人消费者为主；B2B 仅适合雇主品牌与科普内容，不是主阵地',
    hasData: false,
  },
  {
    key: 'toutiao',
    name: '头条号',
    icon: '📰',
    registerUrl: 'https://mp.toutiao.com',
    publishUrl: 'https://mp.toutiao.com/profile_v4/weitoutiao/publish',
    audience: '泛行业资讯读者，头条 + 字节系搜索收录，适合企业动态与行业观点',
    hasData: true,
  },
  {
    key: 'baijiahao',
    name: '百家号',
    icon: '🔎',
    registerUrl: 'https://baijiahao.baidu.com',
    publishUrl: 'https://baijiahao.baidu.com/builder/rc/edit',
    audience: '百度搜索核心内容源，B2B 关键词收录与官网引流的首选阵地',
    hasData: true,
  },
  {
    key: 'weibo',
    name: '微博',
    icon: '💬',
    registerUrl: 'https://weibo.com/signup',
    publishUrl: 'https://weibo.com/',
    audience: '品牌事件传播与舆情发声，登录态下首页即可直接发博',
    hasData: true,
  },
  {
    key: 'dayu',
    name: '大鱼号',
    icon: '🐟',
    registerUrl: 'https://mp.dayu.com',
    publishUrl: 'https://mp.dayu.com/',
    audience: 'UC / 阿里系多端分发，作为搜索收录的补充渠道',
    hasData: true,
  },
  {
    key: 'qqom',
    name: '企鹅号',
    icon: '🐧',
    registerUrl: 'https://om.qq.com',
    publishUrl: '',
    audience: '腾讯内容生态，可同步腾讯新闻，作为收录补充渠道',
    hasData: false,
  },
];

/** 按 key 取平台定义；取不到返回 null（调用方自行兜底）。 */
export function getGeoPlatform(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  for (const p of GEO_PLATFORMS) {
    if (p.key === k) return p;
  }
  return null;
}

/** 已经在 data 层确认过发文页的平台数量，用于前端提示覆盖率。 */
export function countPublishable() {
  return GEO_PLATFORMS.filter((p) => !!p.publishUrl).length;
}

export default GEO_PLATFORMS;
