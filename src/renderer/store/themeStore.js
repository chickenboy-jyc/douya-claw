import { useEffect, useState } from 'react';

/**
 * 全站主题状态（白色 / 深色）—— 四期工程第 1 期的地基。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【它负责什么，不负责什么】
 *   负责：记住用户选了哪套主题（localStorage `douya-theme`）、把它同步成
 *         `<html data-theme="…">`、通知订阅者。
 *   不负责：任何视觉效果。**两套主题的色值全在** `styles/theme-tokens.css`
 *         的 `--c-*` token 里，本文件一个色值都不写。
 *         分工是刻意划死的：改配色不用碰逻辑，改逻辑不用碰配色。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么只剩两套：green 已被产品决策删除（2026-11-08 后）】
 *   用户原话：「主题色是绿色 就白色和深色就行了」⇒ 绿色主题**整体下线**，
 *   `white`（白色）成为默认，`dark` 保留。老用户的 `localStorage` 里可能存着
 *   `douya-theme=green`，见 `normalizeTheme` 的**显式**迁移说明。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么 light（默认）**也**要落成 `data-theme="light"` 属性】
 *   `theme-tokens.css` 里两张表并存，分工不同：
 *     · `:root`                 = 白色主题的 `--c-*`（**首帧兜底**：JS 还没跑时
 *                                 CSS 一加载就已经是白色，不会闪一帧别的颜色）；
 *     · `html[data-theme="…"]`  = 旧 token（`--bg-*` / `--brand-*` / `--r15-*`）
 *                                 在白 / 深两套下的覆盖值。
 *   后者**必须**是 `html[data-theme="…"]`（0,1,1）：那 29 个旧 token 的真源在
 *   `style.css` / `styles/round14.css` / `styles/round15.css` 三张 `:root` 表里
 *   （0,1,0），而那三个文件在本文件之后加载 ⇒ 同权重的 `:root` 会输给它们。
 *   ⇒ 白色主题的旧 token 覆盖只能靠属性选择器的特异性赢，**所以白色必须带属性**。
 *
 *   ⚠️ 历史（别照着旧注释改回去）：绿色当默认时，`green` 是**移除**属性，
 *      理由是「默认态不该有属性，避免与 `:root` 同权重打架」。那条纪律的前提是
 *      「默认态的旧 token 不需要覆盖（绿 = 三张 `:root` 表的原值）」—— 现在默认态
 *      就是白色、且白色**必须**覆盖那 29 个旧 token，前提已经不存在了。
 *      现在的口径是：**两套主题都显式落属性**，`data-theme` 的取值与 `THEME_ORDER`
 *      一一对应，没有"默认态"这第三种隐式状态（少一个状态 = 少一种排查分支）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么在**模块加载时**就 apply 一次】
 *   如果等 React 挂载后再 apply，刷新时首帧渲染的是"没有 data-theme"的 `:root`
 *   兜底色，第二帧才跳到用户选的主题 —— 用户会看到**闪一下**。
 *   `index.jsx` 用一条副作用 import 引入本文件（在 `createRoot` 之前执行），
 *   于是 data-theme 在 React 渲染任何东西之前就已经在 `<html>` 上了。
 *   ⚠️ 这条 import **不能**挪到组件里、也不能改成懒加载，否则闪烁回来。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么存 'light' | 'dark' 而不是 'default' | 'light' | 'dark'】
 *   存盘值要能被**人**读懂（用户拿记事本打开 localStorage 也能看懂），
 *   同时它与 `data-theme` 的取值保持同构，没有一层"名字翻译"，
 *   减少一个"翻译表漏了一项"的出错面。非法值一律回落 `light`（默认）。
 * ════════════════════════════════════════════════════════════════════════════
 */

/** localStorage 键。前缀 `douya-` 与本仓其它持久化键一致。 */
export const THEME_KEY = 'douya-theme';

/** 两套主题的 key（顺序即 UI 上应当出现的顺序：白 → 深）。 */
export const THEME_ORDER = ['light', 'dark'];

/** 默认主题（白色，对应 theme-tokens.css 的 `:root`）。 */
export const THEME_DEFAULT = 'light';

/** 主题 key → 中文名（切换器直接用，避免各处再抄一遍文案）。 */
export const THEME_LABELS = {
  light: '白色',
  dark: '深色',
};

/**
 * 归一化主题值：只认两个合法 key，其余（null / '' / 'darkk' / 对象 / 数字）一律回落默认。
 *
 * ★ `'green'` 是**特判后回落默认**，不是"顺手删掉的旧值"：
 *   绿色主题下线前，它正是默认值，因此**存量用户的 localStorage 里就存着 `green`**
 *   （主进程 `userData/theme.json` 里也可能有，见 `src/main/main.js` 的同名映射）。
 *   新默认（白色）与老默认（绿色）在"用户没主动选过别的"这件事上语义等价，
 *   所以把 `green` 读成 `light` **不需要写盘迁移**：读取即等价，下次用户点一下
 *   主题就会自然被覆盖成 `light` / `dark`。这里显式写出来，是为了让下一个读代码的
 *   人一眼看到"老值有人管"，而不是以为漏了迁移分支。
 *
 * @param {unknown} value 待校验的值
 * @returns {'light'|'dark'} 合法主题 key
 */
export function normalizeTheme(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  // 存量值迁移：green（已下线的默认主题）⇒ light（新默认），语义等价、无需写盘。
  if (v === 'green') return 'light';
  return THEME_ORDER.includes(v) ? /** @type {'light'|'dark'} */ (v) : THEME_DEFAULT;
}

/** 当前主题（模块级单例：组件卸载不影响它，与 `store/mediaShots.js` 同一套思路）。 */
let currentTheme = THEME_DEFAULT;

/** 订阅者集合。 */
const listeners = new Set();

/**
 * 通知所有订阅者。单个监听器抛错不影响其他人（一条坏的订阅不该让主题切换整体失败）。
 *
 * @returns {void}
 */
function emit() {
  for (const fn of listeners) {
    try {
      fn(currentTheme);
    } catch (err) {
      // 订阅者自己的问题自己负责；这里只兜住，避免主题切换被一个坏监听器带崩。
      console.error('[themeStore] listener error:', err && err.message ? err.message : err);
    }
  }
}

/**
 * 从 localStorage 读主题。读不到 / 读坏了 / 环境没有 localStorage，一律默认。
 *
 * @returns {'light'|'dark'} 主题 key
 */
export function readStoredTheme() {
  try {
    if (typeof localStorage === 'undefined') return THEME_DEFAULT;
    return normalizeTheme(localStorage.getItem(THEME_KEY));
  } catch {
    // 隐私模式 / 存储被禁 / 配额异常 —— 主题不该因此崩掉。
    return THEME_DEFAULT;
  }
}

/**
 * 把主题写到 `<html>` 上（DOM 侧的唯一出口）。
 *
 * 两套主题都落成同名属性值：`light` ⇒ `data-theme="light"`、`dark` ⇒ `data-theme="dark"`。
 * 为什么白色也要带属性（而不是移除属性）见文件头「为什么 light（默认）**也**要落成…」。
 * 顺便设置 `color-scheme`，让滚动条、原生控件、表单控件跟着走，
 * 否则深色主题下会露出一条惨白的系统滚动条。
 *
 * @param {'light'|'dark'} theme 主题 key
 * @returns {'light'|'dark'} 实际生效的主题 key
 */
export function applyTheme(theme) {
  const t = normalizeTheme(theme);
  if (typeof document !== 'undefined' && document.documentElement) {
    const el = document.documentElement;
    el.setAttribute('data-theme', t);
    try {
      el.style.colorScheme = t === 'dark' ? 'dark' : 'light';
    } catch {
      // 极端情况下 style 不可写（某些测试替身）—— 不影响 data-theme 已生效。
    }
  }
  currentTheme = t;
  return t;
}

/**
 * 当前主题（同步读，不发通知）。
 *
 * @returns {'light'|'dark'} 主题 key
 */
export function getTheme() {
  return currentTheme;
}

/**
 * 切换主题：**先写盘、再落到 DOM、最后通知**。
 *
 * 顺序是有讲究的：先写盘保证"用户选了就记住"，即使后面 DOM 操作抛错，
 * 下次启动仍会正确应用；落 DOM 在通知之前，保证订阅者被叫醒时读到的
 * `document.documentElement.dataset.theme` 已经是新值（订阅者常常要读 DOM 做后续处理）。
 *
 * @param {'light'|'dark'|string} next 目标主题（非法值回落默认）
 * @returns {'light'|'dark'} 实际生效的主题 key
 */
export function setTheme(next) {
  const t = normalizeTheme(next);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, t);
  } catch {
    // 存不进去也要让本次会话生效 —— 只是下次启动会回默认。
  }
  const prev = currentTheme;
  applyTheme(t);
  if (prev !== t) emit();
  return t;
}

/**
 * 在"两套主题的顺序"里取下一套（将来切换按钮直接调它，不用自己算索引）。
 *
 * @param {'light'|'dark'} [from] 起点（默认当前主题）
 * @returns {'light'|'dark'} 下一套主题
 */
export function nextTheme(from) {
  const base = normalizeTheme(from === undefined ? currentTheme : from);
  const i = THEME_ORDER.indexOf(base);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length];
}

/**
 * 订阅主题变化。
 *
 * @param {(theme: 'light'|'dark') => void} fn 回调
 * @returns {() => void} 取消订阅
 */
export function subscribeTheme(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 启动时应用一次：读取存盘值并写到 DOM。
 * 由 `index.jsx` 的副作用 import 触发（模块末尾自动执行一次），也可重复调用（幂等）。
 *
 * @returns {'light'|'dark'} 实际生效的主题 key
 */
export function initTheme() {
  return applyTheme(readStoredTheme());
}

/**
 * React Hook：订阅主题。返回当前主题，变化时触发重渲染。
 *
 * @returns {'light'|'dark'} 当前主题 key
 */
export function useTheme() {
  const [theme, setLocal] = useState(currentTheme);
  useEffect(() => {
    // 挂载时对齐一次：模块加载到本组件挂载之间可能已经切过主题。
    setLocal(currentTheme);
    const off = subscribeTheme((t) => setLocal(t));
    return off;
  }, []);
  return theme;
}

/**
 * 多窗口同步：Electron 里可能同时开着多个窗口，一个窗口切主题，另一个也该跟上。
 * `storage` 事件只在**别的**窗口写入时触发，所以不会与本窗口的 setTheme 打回环。
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event && event.key && event.key !== THEME_KEY) return;
    const t = readStoredTheme();
    const prev = currentTheme;
    applyTheme(t);
    if (prev !== t) emit();
  });
}

/**
 * ⚠️ 模块加载即应用（防刷新闪一下默认主题）。
 * 放在文件末尾、import 语句之后，保证上面所有定义都已就绪。
 * 在 Node（无 document）下 applyTheme 内部会跳过 DOM 操作，不会抛错。
 */
initTheme();

export default {
  THEME_KEY,
  THEME_ORDER,
  THEME_DEFAULT,
  THEME_LABELS,
  normalizeTheme,
  readStoredTheme,
  applyTheme,
  getTheme,
  setTheme,
  nextTheme,
  subscribeTheme,
  initTheme,
  useTheme,
};
