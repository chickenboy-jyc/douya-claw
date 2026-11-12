/**
 * llmTest —— 模型连通性实测（唯一事实源）。
 *
 * 契约与 App.jsx 设置面板里的「测试 AI 连接」完全一致：
 *   POST `${BACKEND}/api/llm/test`  body `{ baseURL, apiKey, model }`
 *   → 成功 `{ ok:true, latencyMs, reply }`；失败 `{ ok:false, error }`。
 *
 * 首登「屏 2 · 连上 AI」与 App 设置面板共用本函数：**必须真打接口**（返回真实 latencyMs/reply），
 * 不许只判「填了没填」。
 *
 * 设计要点：
 *   · **永不自抛** —— 网络异常 / JSON 解析失败 / 非 200 一律归一为 `{ ok:false, error }`；
 *   · 网络层异常额外带 `network:true` 标记，供调用方区分「请求失败」与「接口返回失败」的提示文案。
 */

/** 后端地址：默认 Electron 本地服务；允许 window.__DOUYA_BACKEND__ 覆盖（真实浏览器验收用）。 */
const BACKEND =
  (typeof window !== 'undefined' && window.__DOUYA_BACKEND__) || 'http://127.0.0.1:10119';

function asStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * 实测模型连接。
 * @param {{baseURL?: string, apiKey?: string, model?: string}} [input]
 * @returns {Promise<{ok:true, latencyMs:number, reply:string} | {ok:false, error:string, network?:boolean}>}
 */
export async function testLLM(input = {}) {
  const baseURL = asStr(input && input.baseURL);
  const apiKey = asStr(input && input.apiKey);
  const model = asStr(input && input.model);
  try {
    const resp = await fetch(`${BACKEND}/api/llm/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL, apiKey, model }),
    });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    if (data && data.ok) {
      const latencyMs = Number(data.latencyMs);
      return {
        ok: true,
        latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0,
        reply: asStr(data.reply),
      };
    }
    return { ok: false, error: (data && data.error) ? asStr(data.error) : '连接失败' };
  } catch (e) {
    return {
      ok: false,
      error: (e && e.message) ? String(e.message) : '请求失败',
      network: true,
    };
  }
}

export default testLLM;
