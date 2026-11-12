/**
 * pptx-v1 —— PPT 任务的工作流配置（**执行系统真正读取的配置**，不是提示词）。
 *
 * 为什么要有这个文件（老板第三节 + 第六节）：
 *   「豆芽不应该每次从空白开始思考"我今天准备怎么做"。它应该识别任务类型，加载该类型的工作流，
 *     再让模型负责具体执行。」
 *   「关键是让 backend.js 真正执行它，而不是把它作为另一个提示词塞给模型。」
 *
 * 所以本文件的每一栏都有消费者，不是文档：
 *   · requiredStages  → workflowRunner.advance() 按它推进 / evaluate() 按它算缺哪些阶段
 *   · requiredChecks  → evaluate() 逐项跑真检查（.pptx 用 zip 解析数真页数，不看模型自述）
 *   · repairPolicy    → evaluate() 的 openIssues 上限与「同题反复失败必须换策略」判据
 *   · deliverable     → detectWorkflow() 用来判「用户到底要的是 pptx 还是网页」
 *
 * ★ 版本策略：文件名带版本（pptx-v1），workflowId 与之一致。改了行为必须换版本号，
 *   否则同一份 trace 里两个不同的验收标准会共用一个 id，事后无法复现「当时按什么标准判的」。
 *   已有 run 记录里存的是 workflowId + version，不随配置漂移。
 *
 * ★ 关于 rendered_pages_checked 的诚实边界：
 *   逐页渲染检查需要本机有能调用的渲染器。实测本机只有 Microsoft PowerPoint（无 soffice），
 *   命令行渲染不稳定且可能弹窗 ⇒ 本版把它定为 best-effort：
 *     · 有渲染器 → 真渲染、真检查；
 *     · 没有 → 记一条 limitation 进交付报告并**明确告知用户**，但**不单独因此把任务判成未完成**。
 *   区分「做不到」与「没做」：前者是能力边界（必须说出来），后者是偷懒（必须判不合格）。
 *   `renderPolicy` 可改成 'require'（无渲染器即判 PARTIAL），留给后面按老板的判断调整。
 */

/** 阶段顺序：数组下标就是先后次序，advance() 不允许跳着往前走 */
const STAGES = [
  'brief',            // 理解需求：受众/目标/交付格式/素材/限制
  'outline',          // 形成任务规格：页数范围、大纲、视觉规范、图片位、验收清单
  'asset_inventory',  // 盘点素材：用户图片/文件类型/尺寸/用途/缺失
  'build',            // 生成可编辑 pptx（真文件，不能用网页顶替）
  'render',           // 渲染成图（受能力限制，见上头说明）
  'validate',         // 逐页检查：溢出/错位/字体/图片/重复页
  'repair',           // 定向修复：每个失败项一条修复动作 + 复验受影响页
  'final_validate',   // 完整复验：文件可开、页数对、交付项齐、未完成项明确
  'deliver',          // 交付归档：文件 + 验证结果 + 待确认事项 + 本次运行记录
];

/**
 * 验收项。severity 两档：
 *   must        —— 不过就不许判 COMPLETE（老板：「交付标准不可以随着模型心情变化」）
 *   best-effort —— 环境不具备时记 limitation，不单独否决（区分「做不到」与「没做」）
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-26【验收契约切口】六项检查的**实现**从通用引擎搬到了这里。
 *
 * 为什么必须搬（真读数驱动，不是形式主义）：
 *   修之前 `workflowRunner.evaluate()` 里硬编码着这六条（12 处 `add('...')` 调用），
 *   `requiredChecks` 只被用来反查 severity —— 也就是说「把标准写进配置」在验收侧是假的。
 *   于是接进注册表的一个 `.txt` 工作流跑完，验收结果里出现的**仍然是** PPT 的六项：
 *   它自己的 `noop_out_written` 一次都没被执行（实测：`results` 六个 id 全是 PPT，
 *   本工作流的检查 id 出现 0 次）。
 *
 * 现在的形状（唯一形状，只此一种）：
 *   `requiredChecks[i].run(ctx)` —— 引擎遍历契约、逐项调用、把返回值归一到四态
 *   （pass / fail / unverified / config-error），再按 severity 聚合 verdict。
 *   引擎**不认识**任何一个具体 check id，标准怎么写由本文件说了算。
 *
 * 迁移纪律（一个字都不许变）：
 *   · id 六个字符串原样；severity 原样（`rendered_pages_checked` 是 best-effort，其余 must）；
 *   · 实际行为原样：`inspectPptx` 真页数 / 重复页 / 渲染 best-effort / 失败原因文案原样
 *     （「只产出了 X，用户要的是 pptx」「没有可检查的 pptx」…）；
 *   · 返回结构原样：`reports` / `planned` / `limitation` 这些额外字段仍然带出去。
 * ⚠️ 反假绿：六项**不许**换成六个空实现（`{pass:true}`）。每一条都必须还在真读数上判，
 *   证据由引擎通过 `ctx` 给（`artifactsMatching` / `inspect` / `formatMatches` / `planned`）。
 *
 * 每条验收项声明「真读数长什么样」（`evidenceHints`）。
 *
 * ★ 为什么要标准自己声明：`evidenceQuality.gradeVerifyEvidence` 要判的是
 *   「这条检查有没有回答**这一项**」，它需要知道每一项在结果里长什么样。
 *   这份知识属于**标准**（pptx-v1 关心页数、重复页），不属于判据引擎 ——
 *   放在引擎里就成了"引擎替你定义你的验收项"，换一套工作流立刻失真。
 *
 * ★ 与老板的挑战 2 直接相关：「看似全绿、实际上没有检查目标问题的测试集」。
 *   只要结果对不上任何一条 hints，它就只是 `numeric`（有数字没对准）或 `prose`（纯表态），
 *   **不算验收证据** —— 于是"每轮换个假绿脚本"不再能冒充进展。
 *   写法是正则源码字符串（大小写不敏感），命中任意一条即算对上。
 *
 * 字段说明：
 *   `coversFormat` —— 本项负责比对「交付格式 vs 实际产物格式」。**必须恰好有一项声明**：
 *                    引擎会检查"契约声明了交付格式却没有一项 coversFormat"这种漏声明，
 *                    并直接判配置错误（否则漏声明 = 静默全绿）。
 *   `terminal`     —— 本项是**自指的终态一致性检查**（输入是"前面那些检查的结果"）。
 *                    调用方在试算阶段要把它从失败清单里排除，这个语义必须由契约声明，
 *                    不能靠通用引擎记住某个 check id（换一套工作流就失效）。
 */
const CHECKS = [
  {
    id: 'requested_format_matches',
    severity: 'must',
    coversFormat: true,
    label: '交付格式与用户要求一致（要 .pptx 就必须是 .pptx，不能用网页顶替）',
    evidenceHints: ['\\.pptx\\b', 'pptx', '格式'],
    /**
     * 格式比对只有**一份实现**（引擎的 `formatMatches`）：它读的是 `deliverable.extensions`
     * 与 `deliverable.rejectsAsDeliverable`，与本文件声明的交付契约同源。
     * 本项只负责"这属于我"，不负责"怎么比"。
     */
    run(c) {
      return c.formatMatches();
    },
  },
  {
    id: 'file_opens',
    severity: 'must',
    label: '产物真能被打开（pptx 按 zip 结构解析，不是"文件存在"就算数）',
    evidenceHints: ['openable', '可打开', 'zip', '解析', 'unzip', 'PK\\\\x03\\\\x04'],
    /** 真解析：`inspect` 就是 `workflowRunner.inspectPptx`（可被门禁注入内存 Buffer）。 */
    run(c) {
      const decks = c.artifactsMatching(['.pptx']);
      if (!decks.length) return { pass: false, why: '没有可检查的 pptx' };
      const reports = decks.map((p) => ({ path: p, info: c.inspect(p) || {} }));
      const bad = reports.filter((r) => r.info.openable !== true);
      return {
        pass: bad.length === 0,
        why: bad.length ? bad.map((r) => r.path + '：' + (r.info.error || '无法解析')).join('；') : '',
        reports: reports.map((r) => ({
          path: r.path,
          slideCount: Number(r.info.slideCount) || 0,
          slideFiles: Number(r.info.slideFiles) || 0,
        })),
      };
    },
  },
  {
    id: 'slide_count_matches_plan',
    severity: 'must',
    label: '实际页数与任务规格一致（规格给了范围就落在范围内，给了确切数字就必须相等）',
    evidenceHints: ['slideCount', 'slide_count', '页数', '\\d+\\s*页', 'slides?\\s*[=:：]'],
    /** 页数按**真解析**出来的 `slideCount`（presentation.xml 的 sldId 条数）判，不看模型自述。 */
    run(c) {
      const decks = c.artifactsMatching(['.pptx']);
      if (!decks.length) return { pass: false, why: '没有可检查的 pptx' };
      const planned = c.planned || null;
      if (!planned) {
        // 没有页数规格 ⇒ 不判（不许凭空定一个标准）。
        return { pass: true, why: '未给出页数规格 ⇒ 不做页数判定（不许凭空定一个标准）', planned };
      }
      let ok = true;
      let why = '';
      for (const p of decks) {
        const n = Number((c.inspect(p) || {}).slideCount) || 0;
        if (planned.mode === 'exact' && n !== planned.count) {
          ok = false;
          why += p + ' 实际 ' + n + ' 页，规格要求恰好 ' + planned.count + ' 页；';
        } else if (planned.mode === 'range' && (n < planned.min || n > planned.max)) {
          ok = false;
          why += p + ' 实际 ' + n + ' 页，规格范围 ' + planned.min + '-' + planned.max + '；';
        }
      }
      return { pass: ok, why: why.replace(/；$/, ''), planned };
    },
  },
  {
    id: 'no_duplicate_pages',
    severity: 'must',
    label: '没有重复页（老板提到的 19 页变 22 页、第 10–12 页重复）',
    evidenceHints: ['duplicate', '重复'],
    /** 重复页按每页文本节点 sha1 分组判（`inspectPptx` 的真实读数）。 */
    run(c) {
      const decks = c.artifactsMatching(['.pptx']);
      if (!decks.length) return { pass: false, why: '没有可检查的 pptx' };
      const dup = decks
        .map((p) => ({ path: p, info: c.inspect(p) || {} }))
        .filter((r) => (r.info.duplicateGroups || []).length);
      return {
        pass: dup.length === 0,
        why: dup.length
          ? dup.map((r) => r.path + ' 重复页：' + r.info.duplicateGroups.map((g) => g.pages.join('=')).join(' / ')).join('；')
          : '',
      };
    },
  },
  {
    id: 'rendered_pages_checked',
    severity: 'best-effort',
    label: '逐页渲染检查过（无渲染器时记 limitation，不冒充做过）',
    evidenceHints: ['render', '渲染', '逐页', '\\.png\\b'],
    /**
     * 三档，语义见文件头的「诚实边界」：
     *   真渲染过 ⇒ 通过；有渲染器却没渲染 / 配置要求必须渲染 ⇒ **失败**（这是"没做"）；
     *   无渲染器 + best-effort ⇒ 通过但带 `limitation: true`（这是"做不到"，必须说出来，不否决）。
     */
    run(c) {
      if (c.rendered === true) return { pass: true, why: '' };
      if (c.renderPolicy === 'require' || c.rendererAvailable === true) {
        return {
          pass: false,
          why: c.rendererAvailable === true
            ? '本机有渲染器但本次没有做逐页渲染检查'
            : '配置要求必须渲染，但本机无可用渲染器',
        };
      }
      return {
        pass: true,
        limitation: true,
        why: '本机无 pptx 渲染器，未做逐页渲染检查（已知限制，非"没做"）',
      };
    },
  },
  {
    id: 'final_status_matches_validation',
    severity: 'must',
    terminal: true,
    label: '最终状态与验收结果一致（验收没过就不许显示完成）',
    evidenceHints: ['verdict', '结论', '状态一致', 'terminal'],
    /**
     * 自指约束：输入是**前面已经算出的** must 项结果 + 缺口阶段（`c.mustProblems()` /
     * `c.missingStages()`），所以它永远等于「前面全过且阶段齐」——
     * 任何缝隙（失败 / 证据不足 / 配置错误）都会被它抓住，不允许"验收没过却判完成"。
     * ⚠️ 它**不读**自己的结果（那会自指），只读快照。
     */
    run(c) {
      const bad = c.mustProblems().map((x) => x.id);
      const miss = c.missingStages();
      if (bad.length) return { pass: false, why: bad.join(', ') + ' 未通过' };
      if (miss.length) return { pass: false, why: '缺少阶段：' + miss.join(', ') };
      return { pass: true, why: '' };
    },
  },
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 工作流契约（2026-10-25）：把「阶段名」「产物类型」「重做判据」三件属于**本工作流**的知识
 * 声明在这里；`backend.js` 只读声明，不再各持一份字面量。
 *
 * 为什么必须搬（行为实验证据，不是形式主义）：一个故意用 `build` 阶段名、产物是 `.txt` 的
 * 合成工作流接进注册表后被三处字面量误伤 —— `priorBuild` 读字面量 `'build'`、`markBuild`
 * 只认 `.pptx`、复用闸门无条件套用 PPT 重做判据 ⇒ 注册非 PPT 工作流严格劣于不注册。
 * 三处字面量的病根是同一句话：把「PPT 的身份」写进了通用主循环。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 阶段契约：本工作流把哪个阶段当作「产物已落地」（`backend.js` 的 `priorBuild` / `markBuild` 读它）。
 *
 * ★ 为什么是声明而不是字面量：`build` 只是 `STAGES` 里的一个**阶段名**，它本身不表示
 *   "这是 PPT 任务"。要判「上一次请求是否已做完产物阶段」，必须问"本工作流把哪个阶段叫产物阶段"。
 * ⚠️ 缺这一栏的后果：`priorBuild` 恒 false（跨请求复用闸门永不武装）、`markBuild` 拒绝标阶段
 *   （该工作流的产物阶段永远不可达）。所以新工作流**必须**显式声明。
 */
const BUILD_STAGE = 'build';

/**
 * 产物类型契约：哪些扩展名算本工作流的产物（`backend.js` 的 `markBuild` 读它）。
 *
 * ★ 与 `deliverable.extensions` 的分工：那个是"交付给用户的格式"（`detectWorkflow` 判格式用），
 *   这个是"落地时算不算产物阶段已完成"（阶段机用）。今天同值、语义不同，不许合并。
 * ⚠️ **没有全局回落**：`backend.js` 缺这一栏时明确跳过产物阶段认定（不默认 `.pptx`）。
 *   默认回落会把通用执行入口重新绑死到 PPT —— 那正是本次要拆掉的耦合。
 */
const BUILD_EXTS = ['.pptx'];

/**
 * 产出本工作流产物的**那个技能**的 id。
 *
 * ★ 与 `BUILD_EXTS` 同源：扩展名说"什么算产物"，本常量说"谁负责产出它"。
 *   两处必须同时成立才算一笔活得对（产物类型对、也是本工作流的技能产出的）。
 * ⚠️ 只有 `pageBudget` 读它（今天）；不要顺手拿它去当"允许调用的工具白名单"——
 *   白名单是**误拦**的高发区（模型改走 `file-write` + `shell-exec` 一样能出片，
 *   见 `regenKind` 头注里那条实测），拦工具必须按效果判、不能按名字判。
 */
const BUILD_SKILL = 'ppt-generate';

/**
 * 页数预算契约：**哪个技能的哪个入参**能收「期望总页数」。
 *
 * ★ 为什么这必须由工作流声明、而不是在 `backend.js` 里写死 `'ppt-generate'`：
 *   与 `buildStage` / `buildExts` 同一条纪律 —— 执行引擎不许持有任何具体工作流的身份。
 *   换一套工作流时，"谁产出本工作流的产物"由那套工作流自己说。
 * ★ 为什么这件事必须是**产品侧注入**而不是"把算术写进提示词让模型自己传"：
 *   实测（snap-inject A/B 的 seed5 与 seed6，输入逐字相同、提示词里既写了
 *   「会自动加一页封面，slides 只传 4 页正文」又点了 4 个标题）：
 *   seed6 照样传了 5 条 ⇒ 产出 6 页，`slide_count_matches_plan`（must）判失败。
 *   把校验做成"被校验者自愿传参才生效"，等于没有校验。
 * ★ 契约只在这里**声明**，注入逻辑只有一处（`backend.js` 的 `withPageBudget`），
 *   与 `markBuild` 一样读 `cfg`，不新增第二份判据。
 * ⚠️ 缺这一栏 ⇒ 产品不注入（失败关闭，绝不猜一个技能名去塞参数）。
 * ⚠️ **覆盖范围（这是边界，不是遗漏）**：注入点只有任务流里的那三处 `runSkill` 调用
 *   （并联 1 处 + 串行 2 处）。`backend.js` 的 `handleSkillRun`（HTTP 端点 `/api/skill/run`）
 *   **不做**预算注入 —— 它不在任务流里，既没有 `state.run.spec` 也没有 `wfCtl`，
 *   而"从别的来源凑一个页数塞进去"正是本仓反复吃亏的第二份判据。
 *   ⇒ 走 HTTP 端点直接调 `ppt-generate` 时，预算只能由**调用方自己**传 `expected_pages`；
 *   不传就等同于"没给预算"，技能按自己的正文条数出片（与改造前一致）。
 */
const PAGE_BUDGET = {
  /** 收预算的技能 id */
  skill: BUILD_SKILL,
  /** 该技能 manifest 里声明的可选参数名（整数，总页数、含封面） */
  param: 'expected_pages',
};

/**
 * ══ 重做判据（原 `backend.js` 的 `pptxRegenKind`，2026-10-25 整体迁入）══
 *
 * ★ 为什么判据属于工作流：它问的是「这次调用会不会重做**本工作流的产物**」。
 *   pptx 工作流眼里 `file-write build_ppt.py` + `shell-exec python` 是重做；
 *   一个 `.txt` 工作流的正常写入不该因为这个被拦。
 *   `backend.js` 只负责"该问谁"（注册表选中的那一套），不再负责"怎么判"。
 *
 * ★ 迁移纪律：逻辑**逐字搬运** —— 四类窄判据、正则语义、入参形状一个字都没改。
 *   原有注释（为什么特征表故意不含裸 `pptx` 这个词等）一并带过来，理由仍然成立。
 *
 * ★★ 原 `backend.js` 那段的取值纪律（原样带过来，理由仍然成立）：
 *   2026-10-23 第四轮把 ③ 从「按工具名白名单」改成「**按效果**判」。
 *   为什么改（真读数，不是假想）：真实模型端到端第 2 次跑（taskId=live_e2e_20261023100854），
 *   恢复臂里模型**没有**调 ppt-generate，而是走 `file-write build_pptx.py` +
 *   `shell-exec python build_pptx.py` 这条路重新生成了 pptx。闸门按名字白名单放行
 *   ⇒ **完全没看见**（`.last-run.json` 全文 0 处 `reuse-gate`、0 处「本次调用没有执行」）。
 *   这条比"模型不听话"严重得多：**它是可以被稳定绕过的** —— 只要模型选另一条合法路径。
 *   判据取值纪律不变（宁窄勿宽）：**误拦**（把正常 file-read / file-list 拦了）比漏拦更糟，
 *   因为误拦会打断正常任务。所以只在下面四类上判，且写文件/跑命令必须
 *   「**生成特征 AND 写动作**」同时成立：
 *     ① 工具名就是 ppt-generate（原路径，保留）
 *     ② file-write 且 path 以 .pptx 结尾（直接写 pptx）
 *     ③ file-write 且 content 里 `Presentation(` 与 `.save(` **同时**出现
 *        （python-pptx 的生成骨架），或 `python-pptx` 字样与 `.save(` 同时出现
 *     ④ shell-exec 且 command 里 pptx 迹象与写动作（save/writeFile/>/cp/mv/copy）**同时**出现
 *   ⚠️ 特征表**故意不含裸 `pptx` 这个词**：python 脚本里 `import pptx`、读 pptx 都正常，
 *     把 `pptx` 当特征会把"读一份 pptx"也拦掉 —— 那是误拦，比漏拦更糟。
 */
const PPTX_REGEN_TOOLS = new Set(['ppt-generate']);
/** pptx 迹象（只用于 shell-exec 的命令文本；窄表，见上）。 */
const PPTX_GEN_MARKER_RE = /(\.pptx|Presentation\s*\(|python-pptx|pptxgenjs)/i;
/** 「写」动作（只用于 shell-exec 的命令文本）。 */
const PPTX_WRITE_ACTION_RE = /(save|writeFile|>|cp |mv |copy )/i;
/** python-pptx 生成骨架的两个特征（必须**同时**命中才算生成）。 */
const PPTX_PY_PRESENTATION_RE = /Presentation\s*\(/;
const PPTX_PY_SAVE_RE = /\.save\s*\(/;
const PPTX_PY_LIB_RE = /python-pptx/i;

/**
 * 「这次调用**可能**重做 pptx 吗？」——按**效果**判，不按工具名白名单判。
 * @param {string} name 技能 id
 * @param {Object} params 调用参数（可能是 null / 非对象，一律兜底成 {}）
 * @return {string} 命中原因（'' = 不拦；非空串会进 trace，便于事后审计"哪条判据命中的"）
 */
function regenKind(name, params) {
  const nm = String(name || '');
  const prm = (params && typeof params === 'object') ? params : {};
  if (PPTX_REGEN_TOOLS.has(nm)) return 'tool:' + nm;
  const asPath = String(prm.path == null ? '' : prm.path).trim();
  const asContent = String(prm.content == null ? '' : prm.content);
  const asCommand = String(prm.command == null ? '' : prm.command);
  if (nm === 'file-write') {
    if (/\.pptx$/i.test(asPath)) return 'file-write:path(.pptx)';
    const save = PPTX_PY_SAVE_RE.test(asContent);
    if (PPTX_PY_PRESENTATION_RE.test(asContent) && save) return 'file-write:content(Presentation+.save)';
    if (PPTX_PY_LIB_RE.test(asContent) && save) return 'file-write:content(python-pptx+.save)';
    return '';
  }
  if (nm === 'shell-exec') {
    // ★ 两个条件必须同时成立：只有"生成特征"（例如 `python -c "import pptx"`）不拦；
    //   只有"写动作"（例如 `dir > out.txt`）也不拦。
    if (!PPTX_GEN_MARKER_RE.test(asCommand)) return '';
    if (!PPTX_WRITE_ACTION_RE.test(asCommand)) return '';
    return 'shell-exec:cmd(pptx+write)';
  }
  return '';
}

module.exports = {
  workflowId: 'pptx-v1',
  version: 1,
  taskType: 'presentation',

  /**
   * ★ 生命周期声明（注册表化新增）：'full' = 这是一套**完整可执行**的工作流。
   *
   * 含义（与 `general-v1` 的 `'none'` 成对照）：
   *   `backend.js` 的 `startWorkflowRun` 为 `'full'` 的项建控制器（阶段机 / 跨请求状态 /
   *   收尾验收 / 终态判定），为 `'none'` 的项**什么都不建、直接返回 null**。
   *   注册表（`./index.js`）只认**显式** 'full'；缺失或拼错归 'none'。
   * ⚠️ 少了这一行（或拼错，例如写成 `'ful'`）：lifecycle 归 none ⇒ `cfg:null` ⇒
   *   `unit-workflow-backend-wiring` 的 **B2-0 会红**（`ok(!!ctl)` 直接判否），
   *   而且下一行 `ctl.snapshot()` 对 null 会抛 **TypeError**（该文件那处没有 guard）——
   *   报错形态是"崩"不是"红断言"，所以看到 TypeError 先查这一行。
   *   **B1 段不受影响**（B1 本来就是非 PPT 输入，期望返回 null，四条仍然全绿）。
   *   自 2026-10-24 起 `index.js` 还会为非法声明打一条 `console.warn`（每 id 一次），
   *   免得这种错被静默吞掉。
   */
  lifecycle: 'full',

  /**
   * 注册表统一识别入口：**这次请求是不是要做 PPT**。
   *
   * ★ 判据**一个字都不重写**：直接把 `workflowRunner.detectWorkflow` 原样借过来（传本配置），
   *   返回它抽出的硬规格；未命中返回 null（注册表据此试下一项）。
   *
   * 为什么"借"而不是"在这里再写一份正则"：
   *   这张识别网在 2026-10-23 被实测修过两次 ——
   *     ① `\bppt\b` 不吃 pptx 的前缀（W1-e：「网页上放一个 PPT 下载入口」不许判成 PPT 任务）；
   *     ② 「汇报一下订单」单独出现**不能**算（弱判据必须配页数证据，否则纯查询任务被套上
   *        pptx 验收标准 ⇒ 做对的活被判成没做完）。
   *   一旦这里再长出一份"差不多"的判据，就会出现两套"什么叫 PPT 任务"，
   *   而它们会各自漂移、各自被门禁钉在各自的读数上。所以识别只有一份实现：
   *   `workflowRunner.detectWorkflow`（纯函数、可单独变异、已被 W1-* 系列断言钉住）。
   *
   * ★ 为什么用函数体内的惰性 require（不是顶层 require）：
   *   本模块在 `workflows/index.js` 里是**顶层** require 的，而 `match` 又要用 `workflowRunner`。
   *   把 `require('../workflowRunner')` 提到本文件顶层，会在"注册表求值期"就把 workflowRunner
   *   整棵树拉起来（它自己还 require fs/zlib/crypto）—— 今天**不会成环**
   *   （`workflowRunner.js` 唯一一处 require 本模块在 `detectWorkflow` 函数体内、是惰性的），
   *   但这会让加载顺序从"谁先被 require 谁先算"变成隐式依赖，一旦将来 workflowRunner 顶层
   *   新增了对本模块或 `./index` 的引用就会真的成环、且症状是启动期半初始化对象。
   *   放在函数体里，两边都只在自己的**调用期**取对方，加载顺序与调用顺序解耦。
   *
   * ★ cfg 用 `this` 而不是 `module.exports`：
   *   注册表持有的是**加载期**抓住的 `entry` 引用；`selectWorkflow` 以 `entry.match(t, ctx)`
   *   的方法形式调用（`this === entry`）。今天 `this` 与 `module.exports` 是同一个对象，
   *   但本仓门禁做内存变异时会碰 `require.cache` / 给 export 套包装这类手法 ——
   *   一旦两者分叉，"识别时用的 cfg"与"交给 backend 的 cfg"就不是同一份，
   *   症状是"识别出的 workflowId 与运行记录里的不一致"，而且**不报错**。
   *   用 `this` 可以保证"谁被选中，就用谁的配置去识别"。
   *
   * @param {string} text 用户原话
   * @returns {object|null} 命中 ⇒ spec（`{ slideCount, explicitPptx }`）；未命中 ⇒ null
   */
  match(text) {
    const runner = require('../workflowRunner');
    const d = runner.detectWorkflow(text, this);
    return d ? d.spec : null;
  },

  /** 阶段契约：产物阶段的名字（见 BUILD_STAGE 头注） */
  buildStage: BUILD_STAGE,
  /** 产物类型契约：算作产物的扩展名（见 BUILD_EXTS 头注；无全局回落） */
  buildExts: BUILD_EXTS,
  /** 页数预算契约：产品在调哪个技能时、往哪个入参里塞「期望总页数」（见 PAGE_BUDGET 头注） */
  pageBudget: PAGE_BUDGET,
  /** 重做判据（见 regenKind 头注）：返回命中原因，'' = 不拦 */
  regenKind,

  /** 交付物：必须是真 pptx。注意这里同时否掉了「先做网页也算完成」 */
  deliverable: {
    format: 'pptx',
    extensions: ['.pptx'],
    // 只声明格式还不够 —— 下面 explicitlyRejectsHtml 是给 detectWorkflow 用的判据注释：
    // 用户说「PPT / 幻灯片 / 汇报 / 路演」但没提网页时，不得以 .html 交付。
    rejectsAsDeliverable: ['.html', '.htm', '.md'],
  },

  stages: STAGES,
  requiredStages: STAGES.slice(),   // 本版全部 9 个阶段都是必需的

  /**
   * ★ 可以被「豁免」的阶段白名单（2026-10-23 接入 backend 主循环时新增）。
   *
   * 为什么必须有这个东西：requiredStages 全必需 ⇒ 只要有一个阶段拿不到证据，evaluate 就永远判 PARTIAL。
   *   而 `render` 在**本机根本不可能拿到证据**（无 soffice、PowerPoint 无稳定 CLI），
   *   于是「每份 PPT 任务都判未完成」——这跟「每份都判完成」是同一种谎，只是方向相反。
   *   `repair` 同理：validate 没发现问题时，它**没有任何可执行动作**，不是"没做"。
   *
   * 三条纪律（缺一条这个豁免就会变成后门）：
   *   ① 只有白名单里的阶段能豁免 —— build / validate / final_validate / brief / outline /
   *      asset_inventory / deliver **不可豁免**。「有没有真的产出 pptx」「有没有真的验过」永远不能豁免。
   *   ② 豁免必须写理由，且进入交付报告（waivedStages），不许静默跳过。
   *   ③ 豁免不是"打勾"：它不进 completedStages，单独记 waivedStages ⇒ 事后能一眼数出
   *      「这次 9 个阶段里有几个是真做了、几个是环境不允许」。
   */
  waivableStages: ['render', 'repair'],

  requiredChecks: CHECKS,

  repairPolicy: {
    maxAttemptsPerIssue: 3,               // 老板建议的初始策略，可配
    changeStrategyAfterRepeatedFailure: true,
    requireRevalidation: true,            // 修完必须复验受影响项
    maxOpenIssuesBeforeStop: 20,          // 防 openIssues 无限膨胀
  },

  renderPolicy: 'best-effort',            // 'require' | 'best-effort'，见文件头说明

  /** 页数规格的默认值：只有在用户**没说页数**时才生效（用户说了就必须按用户说的） */
  defaultSlideCount: { mode: 'range', min: 8, max: 20 },
};
