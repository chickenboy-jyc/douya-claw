// miniprogram-scaffold: 一次生成微信小程序项目骨架（app.json / 页面四件套 / project.config.json）
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKSPACE = path.resolve(process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace'));

module.exports.run = async function (params, ctx) {
  const basedir = String((params && params.basedir) || 'miniprogram').trim() || 'miniprogram';
  const name = String((params && params.name) || '').trim() || basedir;

  // AppID：优先显式传参，否则读后端注入的配置（ctx.wx.appId）
  let appid = String((params && params.appid) || '').trim();
  if (!appid && ctx && ctx.wx && ctx.wx.appId) {
    appid = String(ctx.wx.appId).trim();
  }

  let pages;
  try {
    pages = JSON.parse((params && params.pages) || '["index"]');
  } catch (e) {
    return '错误：pages 参数不是合法 JSON，请传 ["index","list","detail"] 数组';
  }
  if (!Array.isArray(pages) || pages.length === 0) pages = ['index'];
  // 页面名统一去分隔符，避免出现 pages/a/b 这种异常路径
  const pagePaths = pages.map((p) => String(p).replace(/[\\/]/g, '').trim()).filter(Boolean);
  if (pagePaths.length === 0) pagePaths.push('index');

  const root = path.resolve(WORKSPACE, basedir);
  if (root !== WORKSPACE && !root.startsWith(WORKSPACE + path.sep)) {
    return '错误：basedir 不能越出工作区目录';
  }

  const files = {};

  files['project.config.json'] = JSON.stringify(
    {
      appid: appid,
      projectname: name,
      compileType: 'miniprogram',
      setting: {
        urlCheck: true,
        es6: true,
        enhance: true,
        postcss: true,
        minified: true,
        newFeature: true,
      },
    },
    null,
    2
  );

  files['app.json'] = JSON.stringify(
    {
      pages: pagePaths.map((p) => 'pages/' + p + '/' + p),
      window: {
        navigationBarBackgroundColor: '#ffffff',
        navigationBarTextStyle: 'black',
        navigationBarTitleText: name,
        backgroundColor: '#f5f5f5',
        backgroundTextStyle: 'light',
      },
    },
    null,
    2
  );

  files['app.js'] = 'App({\n  onLaunch() {\n    // 小程序启动\n  },\n});\n';
  files['app.wxss'] = 'page {\n  background-color: #f5f5f5;\n  font-size: 28rpx;\n}\n';
  files['sitemap.json'] = JSON.stringify({ rules: [{ action: 'allow', page: '*' }] }, null, 2);

  for (const p of pagePaths) {
    files[path.join('pages', p, p + '.wxml')] =
      '<view class="page">\n  <text>' + p + '</text>\n</view>\n';
    files[path.join('pages', p, p + '.wxss')] = '.page {\n  padding: 32rpx;\n}\n';
    files[path.join('pages', p, p + '.js')] =
      'Page({\n  data: {},\n  onLoad(options) {\n    // 页面加载\n  },\n});\n';
    files[path.join('pages', p, p + '.json')] = JSON.stringify({ usingComponents: {} }, null, 2);
  }

  const created = [];
  for (const rel of Object.keys(files)) {
    const full = path.resolve(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel], 'utf-8');
    created.push(full);
  }

  return (
    '已生成微信小程序骨架（AppID: ' +
    (appid || '未填，请在 project.config.json 里补') +
    '）：\n' +
    created.join('\n')
  );
};
