/**
 * 文字图元的绘制实现 —— 在 `[0,0,w,h]` 这个盒子里把 `TextLayer` 画出来。
 *
 * 引擎在调用本函数之前已经做完了**平移 + 旋转 + 透明度**，所以这里的原点就是图层左上角，
 * 不需要（也不许）再做任何缩放。本函数只负责三件事：换行（`wrap.ts`）、定位（`typeset.ts`）、
 * 落笔（`fillText`）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 两个刻意的决定（和现有 JSX 实现不同，都写清了理由）
 * ════════════════════════════════════════════════════════════════════════════
 * 1. **对齐只走一条代码路径**：始终 `textAlign = 'left'`，x 由「行宽」自己算。
 *    用 `textAlign = 'center'|'right'` 看起来更省事，但字间距非 0 时原生字距会把每行
 *    的推进量多算一个尾随字距 ⇒ 居中的行会整体右偏 `spacing/2`。既然逐字路径无论如何
 *    都要手算 x，那就让两条路径共用同一份 x，避免"字距为 0 时居中刚好、字距一加就歪"。
 * 2. **字体族显式给栈**（默认栈与回退路径 `PosterStudio.jsx:100` 字面一致，真源在
 *    `./font-stack`）。canvas 默认字体在不同机器上不一样，依赖默认值的结果是
 *    「本机排版刚好、用户机器上溢出」—— 这类 bug 在开发机上永远复现不了。
 *    图层可以用 `fontFamily` 覆盖它，空串走默认栈（复刻别人的海报时字体是第一要素）。
 */

import { isTextLayer } from '../model/layer';
import type { TextLayer } from '../model/layer';
import { registerLayerRenderer } from '../engine/registry';
import type { LayerDrawFn } from '../engine/registry';
import { DEFAULT_FONT_STACK } from './font-stack';
import { wrapText, widthOfText } from './wrap';
import type { MeasureFn } from './wrap';
import { applyLetterSpacing, textBaselineOffset, verticalOffsetFor } from './typeset';

/**
 * 字体栈：**唯一真源在 `./font-stack`**，值与回退路径 `PosterStudio.jsx:100` 逐字符相同。
 *
 * 为什么 `draw.ts` 只留一个别名而不持有值：本文件 228 行 / 门禁上限 250 行，
 * 真源留在这里会让「改一段注释就顶破上限」，而值与理由都属于 `font-stack.ts`。
 *
 * 名字保留 `FONT_STACK` 而不是让调用方改 import：`scripts/smoke/unit-poster-text.mjs`
 * 与若干探针按此名取栈，改名的收益只是好看，代价是一批验收资产要同步改。
 */
export { DEFAULT_FONT_STACK as FONT_STACK };

/**
 * 拼 `ctx.font` 字符串。
 *
 * 为什么单独一个函数：字体串拼错（漏 px、字重写成 bold）在 canvas 里**不会报错**，
 * 只会静默回退到默认字体，而默认字体的字宽不同 ⇒ 断行全变。集中一处好排查。
 *
 * ★ `fontFamily` 非空时拼成 `"<fontFamily>", <默认栈>`：用户字体优先、**找不到再回退默认栈**。
 *   不写成"只用这一个字体"（去掉默认栈）的理由：中文名或拼错的族名会让 canvas 掉进
 *   只带拉丁字形的默认字体，中文全变豆腐块 —— 而 canvas 对无效的 `font` **不报错**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 三层职责的分界（写在这里，因为这是唯一会被人读错的地方）
 * ════════════════════════════════════════════════════════════════════════════
 * 1. **清洗规则**（黑名单字符、64 长度上限、"非字符串 ⇒ 空串"）只有**唯一真源**：
 *    `layers/font-family.ts` 的 `fontFamilyOf`。逐字符理由都在那个文件里。
 * 2. 本函数里的 `typeof` / `trim` / `includes('"')` 是**语句级兜底**，不是第二套清洗规则。
 *    它们只保证"拼出来的 font 字符串语法合法"，**不重复那份黑名单**
 *    （这里不判逗号、分号、长度 —— 那是清洗层的事）。两边的分工是：
 *    清洗层决定"这个值合不合法"，本函数只决定"这个值能不能安全拼进字符串"。
 * 3. 兜底而**不抛异常**是刻意的，理由见下。
 *
 * ★ 为什么第三参兜底、而不是像数值字段那样抛：
 *   · 一致性 —— 同一个函数里 `fontSize` / `weight` 都已经是
 *     `Number.isFinite(...) ? ... : 默认值`。前两个参数有兜底、第三个没有，
 *     那不是"刻意的严格"，是不一致。
 *   · "尽早暴露"在这个位置不成立 —— 真正的暴露点是 `assertFiniteTextFields`（它存在的
 *     目的就是把 NaN 变成 `draw-threw` 诊断），而 `fontFamily` 是**字符串**，它没有
 *     "非有限数"的语义。硬套抛异常的路径等于把"字体名类型不对"升级成"整层画不出来"。
 *   · 更关键：`renderDoc` 的 `draw-threw` 诊断语义是「**这一层画不出来**」，是留给
 *     "渲染器真的失败"的通道。让一个**可以安全降级**的输入占用它，会让诊断本身掉价
 *     （用户看到"有层没画出来"，实际只是字体名传了个 null）。本仓禁止的是"静默变空"，
 *     而这里的降级结果不是空 —— 是**用默认字体画出来**，视觉上一定有字。
 *
 * @param fontSize 字号（px）
 * @param weight 字重（100~900）
 * @param fontFamily 图层指定的字体族名；空串（或调用方不传）= 用默认栈。
 *   非字符串（绕过 `normalizeLayer` 的脏输入，如 `null`）也按空串处理，**不抛**。
 * @returns CSS font 简写
 */
export function fontString(fontSize: number, weight: number, fontFamily: string = ''): string {
  const size = Number.isFinite(fontSize) ? Math.max(1, fontSize) : 1;
  const w = Number.isFinite(weight) ? Math.round(weight) : 400;
  // `trim()` 不是多余的：纯空格的 `fontFamily` 靠 `length > 0` 会拼出 `"  ", <默认栈第一个族名>…`
  // —— 引号里是一段空白，canvas 找不到这个族名会**逐个 fallback 到后面的默认栈**。
  // 最终画面碰巧是对的，但那是靠 fallback 兜的，不是靠判断兜的：
  // 一旦以后默认栈的第一个族名也不存在，这种"碰巧"就会变成"字体莫名其妙变了"。
  const usable = typeof fontFamily === 'string' ? fontFamily.trim() : '';
  const family = usable.length > 0 && !usable.includes('"')
    ? '"' + usable + '", ' + DEFAULT_FONT_STACK
    : DEFAULT_FONT_STACK;
  return String(w) + ' ' + String(size) + 'px ' + family;
}

/**
 * 文字层专属的数值字段守卫：**非有限数 ⇒ 抛异常**。
 *
 * `renderDoc` 的 `layerGuard.ts` 只管 `LayerBase` 的七个几何字段（`x/y/w/h/opacity/
 * rotation/z`）—— 它按设计**不认识** `TextLayer` 的字段（否则每加一个图元都要改引擎）。
 * 于是 `fontSize: NaN` 会掉进下面那些 `Number.isFinite(...) ? ... : 默认值` 分支，
 * 被静默换成 1px / 0 字距 / 不限行数。后果按"静默"程度排序：
 *   · `fontSize: NaN` ⇒ 1px 中文，画面上等于没有，而导出报成功；
 *   · `lineHeight: NaN` ⇒ 退回 1.0，多行文字挤在一起但"看得出有字"，最难归因；
 *   · `letterSpacing: NaN` ⇒ 退回 0，只有字距大的标题能看出不对。
 *
 * 抛异常而不是静默兜底，是因为 `renderDoc` 已经把渲染器异常转成 `draw-threw` 诊断，
 * 而它的契约是「**诊断数组非空 = 有层没画出来**」—— 静默兜底会绕开这条唯一的信号通道。
 *
 * `text` 也判：非字符串会走进 `wrapText` 里的 `typeof text === 'string' ? ... : ''`，
 * 变成一张**空白但成功**的图层。
 *
 * @param layer 文字图层
 * @throws Error 任一字段非法时，消息里点名全部非法字段（不是只报第一个）
 */
function assertFiniteTextFields(layer: TextLayer): void {
  const bad: string[] = [];
  const check = (name: string, value: unknown): void => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      bad.push(`${name}=${String(value)}`);
    }
  };
  check('fontSize', layer.fontSize);
  check('weight', layer.weight);
  check('lineHeight', layer.lineHeight);
  check('letterSpacing', layer.letterSpacing);
  check('maxLines', layer.maxLines);
  if (typeof layer.text !== 'string') bad.push(`text 不是字符串（${typeof layer.text}）`);
  if (bad.length > 0) {
    throw new Error(`文字层 ${layer.id} 字段非法：${bad.join('、')}（非有限数 / 非数字）`);
  }
}

/**
 * 画一个文字图层。
 *
 * 收窄用 `model/layer` 的 `isTextLayer`（不在这里另写一份 `layer.type === 'text'`）：
 * 判别联合的收窄函数只应该有一个真源，否则将来加字段时两边会漂。
 *
 * @param ctx 画布上下文（原点 = 图层左上角，已应用旋转与透明度）
 * @param layer 任意图层；不是文字层时直接返回
 */
export const drawTextLayer: LayerDrawFn = (ctx, layer): void => {
  if (!isTextLayer(layer)) return;

  const fontSize = Number.isFinite(layer.fontSize) ? Math.max(1, layer.fontSize) : 1;
  const weight = Number.isFinite(layer.weight) ? layer.weight : 400;
  const spacing = Number.isFinite(layer.letterSpacing) ? layer.letterSpacing : 0;
  const maxLines = Number.isFinite(layer.maxLines) ? Math.max(0, Math.floor(layer.maxLines)) : 0;
  const boxWidth = Number.isFinite(layer.w) ? Math.max(1, layer.w) : 1;
  const boxHeight = Number.isFinite(layer.h) ? Math.max(0, layer.h) : 0;

  // 文字层**独有的**数值字段必须在这里拦，不能靠 renderDoc 的 layerGuard：
  // 那张守卫清单只有 LayerBase 的七个几何字段（x/y/w/h/opacity/rotation/z），
  // `fontSize: NaN` 会一路走到下面的 `Number.isFinite(...) ? ... : 1` 被静默换成 1px ——
  // 1px 的中文字在海报上等于**看不见**，而导出"成功"。这就是本仓反复禁止的静默变空。
  // 抛出去由 renderDoc 记成 `draw-threw` 诊断（诊断数组非空 = 有层没画出来）。
  assertFiniteTextFields(layer);

  // save/restore 是必须的：font / fillStyle / textAlign / textBaseline / letterSpacing
  // 全是上下文级状态，漏恢复会让**后面所有图层**继承这一层的样子（文字变白、变粗、
  // 带上字距），而症状出现在下一个图元上，极难定位。
  ctx.save();
  try {
    ctx.font = fontString(fontSize, weight, layer.fontFamily);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left'; // 见文件头：对齐由 x 自己算，不交给上下文
    ctx.fillStyle = layer.color;
    // 测量期间把原生字距挂起：Chromium 的 measureText 会把 letterSpacing 算进返回值，
    // 而 wrapText 会按 (n-1)*spacing 自己补一次 ⇒ 不挂起就是双算，断行整体提前。
    const restoreSpacing = applyLetterSpacing(ctx, 0);
    try {
      const measure: MeasureFn = (text: string): number => ctx.measureText(text).width;
      const result = wrapText(layer.text, measure, {
        maxWidth: boxWidth,
        letterSpacing: spacing,
        maxLines,
      });
      // 非有限入参不许"回落成默认值继续画"：`wrapText` 只能回落（它要返回一个结果），
      // 但绘制层必须让调用方**知道**这一层的结果不可信。抛出去 ⇒ renderDoc 记
      // `draw-threw` ⇒ 调用方看到非空诊断数组。不抛的话画面看着正常，实际按默认参数
      // 排的版，而所有人都以为成功了。
      if (result.invalid) {
        throw new Error(
          `文字层 ${layer.id} 排版参数非法：${result.invalidFields.join(' / ')} 是 NaN（必须回落或修正后再导出）`,
        );
      }
      const step = textBaselineOffset(fontSize, layer.lineHeight);
      const top = verticalOffsetFor(layer, result.lines.length);

      // 只在「用户明确限制了行数（truncated）且内容仍比盒子高」时裁到盒子：那种情况下
      // 溢出到盒子外面与"只显示 maxLines 行"这个承诺自相矛盾。没截断时不裁 —— 溢出是
      // 布局错误，裁掉半个字比溢出更难排查。
      if (result.truncated && top + result.lines.length * step > boxHeight) {
        ctx.beginPath();
        ctx.rect(0, 0, boxWidth, boxHeight);
        ctx.clip();
      }

      for (let i = 0; i < result.lines.length; i += 1) {
        const line = result.lines[i];
        if (line === undefined) continue;
        const y = top + i * step;
        // 行宽用「墨迹宽」算：最后一个字之后没有字距，这才是视觉上那一行的宽度
        const lineWidth = widthOfText(line, measure, spacing);
        const x = layer.align === 'center' ? (boxWidth - lineWidth) / 2
          : layer.align === 'right' ? boxWidth - lineWidth
            : 0;
        if (spacing === 0) {
          ctx.fillText(line, x, y);
          continue;
        }
        // 逐字绘制：canvas 没有"手排字距"之外的可靠办法（原生字距在旧内核没有，
        // 且我们上面已经把它挂起，这里必须自己推进游标）。
        let cursor = x;
        for (const ch of Array.from(line)) {
          ctx.fillText(ch, cursor, y);
          cursor += ctx.measureText(ch).width + spacing;
        }
      }
    } finally {
      restoreSpacing();
    }
  } finally {
    ctx.restore();
  }
};

// 自注册：引擎按 kind 查表，不认识任何具体图元；本文件被 import 即完成接线。
registerLayerRenderer('text', drawTextLayer);
