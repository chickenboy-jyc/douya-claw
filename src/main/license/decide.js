/**
 * 授权闸的**判定**（唯一一处）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么单独抽出来
 * ═══════════════════════════════════════════════════════════════════════════
 *   原先这段判断写在 `backend.js` 的 HTTP 路由闭包里。闭包里的代码**单测启动不了**
 *   （要拉起整条后端 + Electron），于是"什么情况下该拦"这条判据永远没人监督。
 *   本仓踩过的同类事故：算出来了但没人读、或者判据在闭包里所以只能靠人肉 review。
 *   ⇒ 抽成纯函数：不读环境、不读盘、不联网，门禁可以喂假 gate 直接看输出并做变异自证。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条边界（这是本模块存在的全部意义，别"顺手加严"）
 * ═══════════════════════════════════════════════════════════════════════════
 *  ① **没有 gate ⇒ 放行。** 没接线不等于"没授权"。纯 node 单测、未来的其它壳、
 *     甚至哪天 wire 那行被人删了 —— 这些情况下的正确反应是"照常用"，不是"全体锁死"。
 *  ② **gate 自己抛异常 ⇒ 放行。** 铁律：授权门挂了不许锁用户。
 *     宁可漏拦一次（业务损失有限），也不许因为授权模块的一个 bug 让产品在用户机器上打不开。
 *  ③ **只认 `isAllowed()`，不认 `state` 字符串。** 哪些状态算"可以用"是
 *     `license/index.js` 的产品决策（ALLOWED_STATES），在这里再写一份枚举必然漂移。
 *
 * @module license/decide
 */

'use strict';

/**
 * 当前请求该不该被授权闸拦下。
 *
 * @param {object|null|undefined} gate `license/index.createLicenseGate()` 的实例（或任何同形对象）
 * @param {object} [opts]
 * @param {boolean} [opts.wired] 仅供诊断：显式覆盖"有没有接线"（生产不传）
 * @returns {{state:string, detail:string}|null} 非 null = 拦下；null = 放行
 */
function decideBlocked(gate, opts) {
  const g = gate;
  // 边界①：没有 gate ⇒ 放行。
  if (!g || typeof g !== 'object') return null;
  if (typeof g.isAllowed !== 'function') return null;   // 形状不对也按"没接线"处理

  try {
    if (g.isAllowed()) return null;
  } catch {
    // 边界②：授权门自己炸了 ⇒ 放行。
    return null;
  }

  // ★ `getStatus()` 单独兜，**不与 `isAllowed()` 共用一个 try**。
  //   理由：`isAllowed()` 已经**成功地**给出了"不允许"这个结论，说明 gate 是活的。
  //   此时 `getStatus()` 挂了只说明"说不出原因"，不构成"改判放行"的理由 ——
  //   共用一个 try 会让一个纯展示性方法的异常把整道闸打开（faile-open 的经典形态）。
  let st = null;
  try { st = (typeof g.getStatus === 'function') ? g.getStatus() : null; } catch { st = null; }
  return {
    // 拿不到状态就如实说 UNKNOWN，不编一个具体罪名。
    state: String((st && st.state) || 'UNKNOWN'),
    detail: String((st && st.detail) || ''),
  };
}

module.exports = { decideBlocked };
