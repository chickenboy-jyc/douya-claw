/**
 * learnFetchReport —— 把「一次学习中心抓取」的真实结果翻译成给用户看的话。
 *
 * 【为什么要单独一个模块（0.21.27 · 老板「学习中心内容十分糟糕，是不是根本爬不到内容」）】
 * 改前 `LearningStation.crawlNews` 只解构 `crawlSources` 的 `items`，把 `failed` 整个丢掉，
 * 外层 `catch` 也只写一句注释；于是「5 个 RSS 源全挂 + 期刊目录也挂 + AI 兜底也失败」
 * 走到 `total === 0` 时，界面统一说一句：
 *     「这次抓到的都是已有资讯，没有新增」
 * —— 这是**把"全军覆没"读成"今天没有新内容"**，正是老板会当成"你在骗我"的那句话。
 *
 * 本模块把汇总文案做成**纯函数**（无 IO、无 React），目的有二：
 *   ① 让三态（全部失败 / 部分失败 / 真的没有新增）只有一处实现，UI 不再各写一套；
 *   ② 门禁可以直接喂一份"所有源都失败"的结果，断言输出里没有那句假话、
 *      并且**列出了失败源的中文名**（`scripts/smoke/entry-interact.jsx` 的学习中心区块）。
 *
 * 约定：`name` 一律用用户看得懂的中文名（`knowledgeCatalog.SEED_SOURCES[].name` /
 * `JOURNAL_SOURCES[].name`），绝不印 `csa` / `medicalxpress` 这种内部 id。
 */

/** 「真的没有新增」——只有在**所有尝试的源都抓通**且确实没有新条目时才允许出现。 */
export const FETCH_NO_NEW_TEXT = '这次抓到的都是已有资讯，没有新增';

/** 取整并夹到非负；脏输入一律当 0（不让 NaN 参与文案）。 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 只保留「有名字或有原因」的失败项，并统一成 { name, error } 形状。 */
function failList(v) {
  const arr = Array.isArray(v) ? v : [];
  return arr
    .map((x) => (x && typeof x === 'object' ? x : {}))
    .filter((x) => String(x.name || '').trim() || String(x.error || '').trim());
}

/** 一条失败 → 「中文源名（原因）」。 */
export function describeFailure(f) {
  const o = f && typeof f === 'object' ? f : {};
  const name = String(o.name || '').trim() || '未知来源';
  const error = String(o.error || '').trim() || '抓取失败（未给出原因）';
  return `${name}（${error}）`;
}

/**
 * 把抓取结果翻译成一条提示文案 + 一条失败明细。
 *
 * @param {object} result crawlNews / fetchIndustryNews 的汇总结果
 *   { added, localAdded, aiAdded, skipped, journalAdded, journalTotal, journalFailed,
 *     rssTotal, rssFailed }
 * @returns {{level:'success'|'warning'|'info', text:string, detail:string, namesText:string,
 *            allFailed:boolean, attempted:number, okCount:number, failedCount:number,
 *            failedNames:string[]}}
 */
export function describeFetchNotice(result) {
  const r = result && typeof result === 'object' ? result : {};
  const added = num(r.added);
  const localAdded = num(r.localAdded);
  const aiAdded = num(r.aiAdded);
  const skipped = num(r.skipped);
  const journalAdded = num(r.journalAdded);
  // `localAdded` 是「期刊目录 + RSS」两级之和，展示时要拆开，否则期刊那几条会被数两遍
  const rssAdded = Math.max(0, localAdded - journalAdded);

  const journalFailed = failList(r.journalFailed);
  const rssFailed = failList(r.rssFailed);
  const failed = journalFailed.concat(rssFailed);
  const attempted = num(r.journalTotal) + num(r.rssTotal);
  const failedCount = failed.length;
  const okCount = Math.max(0, attempted - failedCount);
  // 「全部失败」= 试过的源一个都没抓通。attempted=0（压根没有可用源）单列，也算全挂。
  const allFailed = failedCount > 0 && okCount === 0;
  const failedNames = failed.map((f) => String(f.name || '').trim() || '未知来源');
  const namesText = failedNames.join('、');
  const detail = failed.length > 0 ? `未抓通的源：${failed.map(describeFailure).join('；')}` : '';

  const base = { detail, namesText, allFailed, attempted, okCount, failedCount, failedNames };

  // ① 抓到了内容
  if (added > 0) {
    const parts = [];
    if (journalAdded > 0) parts.push(`中华医学期刊 ${journalAdded} 篇`);
    if (rssAdded > 0) parts.push(`本地 RSS ${rssAdded} 条`);
    if (aiAdded > 0) parts.push(`AI 补充 ${aiAdded} 条`);
    let text = `已抓取 ${parts.join(' + ') || `${added} 条`}${skipped ? `（跳过 ${skipped} 条重复）` : ''}`;
    if (failedCount > 0) text += `；本次抓通 ${okCount}/${attempted} 个源`;
    return { ...base, level: failedCount > 0 ? 'warning' : 'success', text };
  }

  // ② 一条没抓到，而且试过的源全部失败 —— 这一格**不许**说「没有新增」
  if (allFailed) {
    return {
      ...base,
      level: 'warning',
      text: `抓取全部失败：${attempted} 个来源一个都没抓通（${namesText}）。这不是「今天没有新内容」，而是抓取本身失败了，请检查网络后重试。`,
    };
  }

  // ③ 没有可用源（配置问题，同样不是「今天没有新内容」）
  if (attempted === 0) {
    return {
      ...base,
      level: 'warning',
      text: '这次没有可用的资讯源（源清单里没有配置订阅地址），所以一条都没抓到。',
    };
  }

  // ④ 部分源失败
  if (failedCount > 0) {
    return {
      ...base,
      level: 'warning',
      text: `这次没有新增：抓通 ${okCount} 个源、${failedCount} 个源未通（${namesText}）`,
    };
  }

  // ⑤ 全部抓通、确实都是已有资讯 —— 只有这一格才允许说这句话
  return { ...base, level: 'info', text: FETCH_NO_NEW_TEXT };
}

export default { describeFetchNotice, describeFailure, FETCH_NO_NEW_TEXT };
