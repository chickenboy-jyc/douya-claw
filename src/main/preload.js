const { contextBridge, ipcRenderer, shell, webUtils } = require('electron');

// 暴露给渲染进程的接口（只读 + 受限能力）
contextBridge.exposeInMainWorld('api', {
  backendURL: 'http://127.0.0.1:10119',
  // 在系统默认浏览器中打开外部链接（用于 OAuth 授权页）
  openExternal: (url) => shell.openExternal(url),
  // 调用主进程 IPC（用于语音录音等）
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  // 监听主进程主动推送的事件（voice:result / voice:error / update:state）
  on: (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args)),
  // 监听自动更新状态推送（update:state）→ 驱动左上角更新卡片
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, state) => cb(state)),
  // 补拉当前更新状态：卡片组件在**窗口挂载之后**才订阅，而启动瞬间的首次检查推送发生在窗口创建
  // 之前（必然丢失），只靠 onUpdateState 会导致「有新版」卡片永不出现 ⇒ 挂载时必须补拉一次。
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  // 卡片点击「立即更新 / 稍后」→ 主进程 updater.js 的 updateAction
  updateAction: (action) => ipcRenderer.invoke('update:action', action),
  // 设置 → 高级配置：「当前版本」显示 + 手动「检查更新」。
  // getAppVersion 返回打包时的版本号；checkUpdate 返回
  // { ok:true, phase:'available', version } / { ok:true, phase:'none' } / { ok:false, message }。
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  // 拖拽文件：从原生 File 对象取绝对路径（在 preload 直接用 webUtils，避免跨 IPC 序列化丢 File）
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  // 选文件 / 选文件夹（弹系统对话框）
  pickFiles: () => ipcRenderer.invoke('file:pick'),
  pickFolder: () => ipcRenderer.invoke('file:pickFolder'),
  // 读文件文本（企业大脑/资产库上传用）
  readFileText: (p, maxBytes) => ipcRenderer.invoke('file:readText', p, maxBytes),
  // 打开成果文件 / 在资源管理器定位 / 打开工作区（让用户一键看到生成的东西）
  openPath: (p) => ipcRenderer.invoke('file:openPath', p),
  showInFolder: (p) => ipcRenderer.invoke('file:showInFolder', p),
  openWorkspace: (p) => ipcRenderer.invoke('file:openWorkspace', p),
  // 系统通知：让渲染层（定时任务结果告知等）请求主进程弹系统通知。
  // 返回 { ok, error }：ok=false 表示系统不支持/发送失败，调用方应降级成页内提示（绝不静默）。
  notify: (title, body, opts) => ipcRenderer.invoke('notify:send', { title, body, ...(opts || {}) }),
  // 后台常驻设置：关闭窗口是否常驻托盘 / 是否开机自启（供设置页使用）。
  getResidentSettings: () => ipcRenderer.invoke('resident:getSettings'),
  setResidentSettings: (patch) => ipcRenderer.invoke('resident:setSettings', patch),
  // 主题（2026-11-08 · 主题二期）：渲染层是主题的**权威方**（localStorage `douya-theme`），
  // 主进程只负责两件事 —— ① 窗口创建前读一份，用它设 `backgroundColor`（否则深色主题
  // 冷启动必闪一片浅灰）；② 切主题后立刻换当前窗口底色。
  // ★ `getTheme` 本轮 UI 不用（真相在 localStorage），留着是给「对账 / 排障」用；
  //   两条都返回归一化后的 key（'light' | 'dark'；老值 'green' 会被映射成 'light'），不抛错。
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  // 定时任务（第三层能力）：数据归主进程所有，渲染层只经 IPC 读写。
  // 形状照 resident:getSettings 既有约定（一律 invoke，回传纯数据）。
  automationList: () => ipcRenderer.invoke('automation:list'),
  automationCreate: (input) => ipcRenderer.invoke('automation:create', input),
  automationUpdate: (id, patch) => ipcRenderer.invoke('automation:update', id, patch),
  automationRemove: (id) => ipcRenderer.invoke('automation:remove', id),
  automationRunNow: (id) => ipcRenderer.invoke('automation:runNow', id),
  automationRuns: (query) => ipcRenderer.invoke('automation:runs', query),
  // 长期记忆（B 阶段 #247/#248/#249）：数据归主进程所有，渲染层只经 IPC 读写。
  // ★ 渲染层**没有**能力绕过这三条通道直接碰档案文件 —— 读、写开关、归档全部经此。
  //   ① memoryRead    读四层（identity/orgs/prefs/projects）+ 总数
  //   ② memoryLedger  读流水（who/when/why 的原始账本，时间线数据源）
  //   ③ memoryArchive 归档单条（用户删除，落 SUPERSEDE 账本，**不物理删除**）
  //   ④ get/setSettings 开关「生成对话记忆」（只关抽取，不关 Secret 门）
  memoryRead: () => ipcRenderer.invoke('memory:read'),
  memoryLedger: (query) => ipcRenderer.invoke('memory:ledger', query),
  memoryArchive: (input) => ipcRenderer.invoke('memory:archive', input),
  memoryGetSettings: () => ipcRenderer.invoke('memory:getSettings'),
  memorySetSettings: (patch) => ipcRenderer.invoke('memory:setSettings', patch),
  // ── 视频设计（通义万象 3.0 · 2026-10-21 老板需求）────────────────────────────
  // ★ 铁律：**渲染层绝不直连外网**。所有上游请求都在主进程 wanxProvider 里发，
  //   渲染层只经这 13 条通道拿结构化结果（原有 9 条 + 参考素材 4 条）。
  // ★ key 的活体只存在于主进程 + userData/wanx.json；这里返回的 status 里 key 是**掩码**
  //   （形如 sk-…），渲染层拿不到明文，也就无从写进日志/报错/剪贴板。
  // ★ 产物是**会过期的 OSS 签名 URL**（约 19h），所以 wanxVideo/wanxImage 返回的 url
  //   必须立刻交给 wanxSave 落地成本地文件；前端不要把这个 url 当长期地址存。
  wanxStatus: () => ipcRenderer.invoke('wanx:status'),
  wanxSaveKey: (key) => ipcRenderer.invoke('wanx:saveKey', key),
  // 把老的全局 key 复制到当前账号（显式动作，原件不动）。没有可导入的就回 {ok:false,error}
  wanxImportLegacyKey: () => ipcRenderer.invoke('wanx:importLegacyKey'),
  wanxSavePrefs: (patch) => ipcRenderer.invoke('wanx:savePrefs', patch),
  wanxBudget: () => ipcRenderer.invoke('wanx:budget'),
  wanxLedger: (limit) => ipcRenderer.invoke('wanx:ledger', limit),
  wanxVideo: (args) => ipcRenderer.invoke('wanx:video', args),
  wanxQuery: (taskId) => ipcRenderer.invoke('wanx:query', taskId),
  wanxImage: (args) => ipcRenderer.invoke('wanx:image', args),
  wanxSave: (args) => ipcRenderer.invoke('wanx:save', args),
  // ── 参考素材（图片/视频/音频输入 · 2026-10-21 补）────────────────────────────
  // ★ 上传这条路的关键设计：`wanxPickMedia` **只回 path/name/bytes/ext，不回文件内容**。
  //   20MB 图片转 base64 ≈ 27MB 字符串，在「选文件」这一步就转、再经 IPC 传给渲染层、
  //   渲染层再传回来，等于同一份数据在进程间搬两趟。编码只在**提交前**由主进程做
  //   （那时才知道上限是哪一档：视频首帧 20MB / 图生图单图 10MB）。
  // ★ 前端要自己显示「还能加几张」就读 wanxStatus().limits，别在界面里写死 10/3。
  wanxPickMedia: (args) => ipcRenderer.invoke('wanx:pickMedia', args),
  wanxOpenFolder: (args) => ipcRenderer.invoke('wanx:openFolder', args),
  wanxAssets: (args) => ipcRenderer.invoke('wanx:assets', args),
  wanxMediaDir: () => ipcRenderer.invoke('wanx:mediaDir'),
  // 登出时清掉主进程侧的账号标识 —— 否则登出后主进程仍按上一个账号派生产物目录。
  // ★ 只"忘记"账号，不删任何产物文件：重新登录同一账号，作品还在原处。
  // ★ 调用点必须容错（App.jsx 的 doLogout 用 try/catch）：通道缺失/主进程还没 ready
  //   都不许让登出这个动作失败 —— 登不出去比"多看到一个账号的作品"更严重。
  accountForget: () => ipcRenderer.invoke('account:forget'),

  // ── 视频精剪（Concat 0.2.9 · MCP over stdio）──────────────────────────
  // ★ 底层是一个**常驻会话**（src/main/concatStudio.js）：第一次调用才 spawn concat.exe，
  //   空闲 5 分钟自动关。不是每次编辑都重启 —— 重启要 1~2 秒，拖时间轴会完全拖不动。
  // ★ 所有写操作（concatEdit 的全部 op）都返回 `{ok, createdId?, ...snapshot}`：
  //   一次 IPC 就拿到新时间线，**不用**再调 concatSnapshot() 补一次。
  //   拖拽热路径上少一个往返就是少 1/3 的延迟。
  // ★ `clips` 是**扁平数组**，靠 `clip.track` 归属；`tracks[].index` **越大越在上层**。
  //   画轨道请按 index 排序，不要用数组下标或数组倒序。
  concatProbe: () => ipcRenderer.invoke('concat:probe'),
  concatOpen: (args) => ipcRenderer.invoke('concat:open', args),
  concatClose: (args) => ipcRenderer.invoke('concat:close', args),
  concatSnapshot: () => ipcRenderer.invoke('concat:snapshot'),
  concatImportMedia: (args) => ipcRenderer.invoke('concat:importMedia', args),
  // 系统对话框选素材（视频/音频/图片，可多选）。只回**路径**，不回文件内容。
  concatPickMedia: () => ipcRenderer.invoke('concat:pickMedia'),
  // 另存为 .mp4（主进程会把漏掉的后缀补回来）。
  concatPickOutput: (args) => ipcRenderer.invoke('concat:pickOutput', args),
  // ⚠️ 所有编辑都走这一条，靠 `{op, args}` 分流。op 见 main.js 的注释清单。
  concatEdit: (args) => ipcRenderer.invoke('concat:edit', args),
  // 抽一帧当预览：返回 `dataUrl`（data:image/png;base64,...），直接塞 <img src>。
  concatPreviewFrame: (args) => ipcRenderer.invoke('concat:previewFrame', args),
  concatExportStart: (args) => ipcRenderer.invoke('concat:exportStart', args),
  // 进度靠**轮询**这一条（不阻塞），取消按钮才点得动。
  concatExportStatus: (args) => ipcRenderer.invoke('concat:exportStatus', args),
  concatExportCancel: (args) => ipcRenderer.invoke('concat:exportCancel', args),
  concatUndo: () => ipcRenderer.invoke('concat:undo'),
  concatRedo: () => ipcRenderer.invoke('concat:redo'),

  // ── 授权（第三层技术防护）────────────────────────────────────
  // 全部是 invoke，渲染层 await 即可。主进程侧见 main/license/wire.js。
  // 注意：这些接口**读不到令牌**，只返回状态与机器码短码 ——
  // 故意不把 token 暴露给渲染层，否则一开 DevTools 就抄走了。
  license: {
    // 当前状态 { state, allowed, detail, machine, fingerprint:{strength,strong,missing}, vaultMode }
    status: () => ipcRenderer.invoke('license:status'),
    // 激活 { ok, state, detail }
    activate: (code) => ipcRenderer.invoke('license:activate', code),
    // 手动重试一次校验
    retry: () => ipcRenderer.invoke('license:retry'),
    // 解除本机授权（换机前用）
    deactivate: () => ipcRenderer.invoke('license:deactivate'),
    // 本机机器码短码，报障时念给客服
    machine: () => ipcRenderer.invoke('license:machine'),
    // 状态变化推送 { state, allowed, detail }
    onChange: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('license:changed', h);
      return () => ipcRenderer.removeListener('license:changed', h);
    },
  },
});
