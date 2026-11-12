/**
 * 语音识别 —— 双引擎：优先火山引擎 HTTP REST API，兜底 Windows 本地 SAPI
 */
const https = require('https');
const zlib = require('zlib');

// 口腔行业热词：ASR 对专业术语/品牌识别率低，把这些词作为热词直传，显著降低同音错别字。
// 火山限制 200 tokens 以内，这里控制数量（约 40 词）。
const HOTWORDS = [
  '车针', '机扩', '根测仪', '根管锉', '镍钛锉', '机用锉', 'K锉', 'H锉', '扩大针', '拔髓针',
  '树脂', '光固化', '复合树脂', '糊剂', '氢氧化钙', '牙胶尖', '吸潮纸尖', '成形片', '酸蚀剂', '粘接剂',
  '窝沟封闭', '抛光膏', '印模', '硅橡胶', '消毒盒', '车针盒', '打磨抛光', '钨钢', '金刚砂',
  '马尼', '登士柏', '3M', '科尔', '皓齿', '义获嘉', '康特', 'MANI', 'ProTaper', '临时冠', '氧化锆',
];

/**
 * 火山引擎豆包语音识别 — HTTP REST 接口 (录音文件极速版)
 * 文档：https://www.volcengine.com/docs/6561/1354869
 * 端点：POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
 */
function volcanoRecognizeREST(apiKey, pcmBuffer, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    // 将 PCM 16kHz/16bit/mono 转为 WAV
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);
    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(16000, 24); // sample rate
    header.writeUInt32LE(32000, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    const wav = Buffer.concat([header, pcmBuffer]);

    // 尝试两个 resource ID（不同版本的服务）
    const resourceIds = [
      'volc.bigasr.auc',          // 流式识别大模型
      'volc.seedasr.sauc.duration', // ASR 2.0
    ];

    let tried = 0;

    function tryResource() {
      if (tried >= resourceIds.length) {
        reject(new Error('语音识别服务未开通，请在火山引擎控制台开通豆包语音识别大模型'));
        return;
      }

      const resourceId = resourceIds[tried];
      tried++;

      const body = JSON.stringify({
        app: { appid: 'douya-claw' },
        user: { uid: 'douya-claw' },
        audio: {
          format: 'wav',
          data: wav.toString('base64'),
        },
        request: {
          model_name: 'bigmodel',
          enable_punc: true,
          enable_itn: true,
          // 热词直传：提升口腔专业术语/品牌的识别准确率，减少同音错字（如「车针」被识别成「车震」）
          context: JSON.stringify({ hotwords: HOTWORDS.map((w) => ({ word: w })) }),
        },
      });

      const url = new URL('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');

      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Request-Id': require('crypto').randomUUID(),
        },
        timeout: timeoutMs,
      }, (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d.toString(); });
        res.on('end', () => {
          if (res.statusCode === 403) {
            // 403 = 此 resource 未开通，尝试下一个
            tryResource();
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error('语音识别失败 (HTTP ' + res.statusCode + ')'));
            return;
          }
          try {
            const json = JSON.parse(raw);
            // 火山返回结构有两种形态：
            //   1) { result: [{ text: "..." }] }  （数组）
            //   2) { result: { text: "..." } }    （对象，常见）
            // 也可能直接在顶层带 text。统一取出最终文本。
            let text = '';
            if (json.result && Array.isArray(json.result)) {
              text = json.result.map(r => (r && r.text) || '').join('');
            } else if (json.result && typeof json.result.text === 'string') {
              text = json.result.text;
            } else if (typeof json.text === 'string') {
              text = json.text;
            }
            // 服务返回了错误码时优先抛出，便于排查（成功响应可能不带 code 字段）
            if (!text && json.code && json.code !== 1000) {
              reject(new Error('语音识别失败：' + (json.message || ('code ' + json.code))));
              return;
            }
            resolve(text || '');
          } catch {
            reject(new Error('语音识别响应解析失败'));
          }
        });
      });

      req.on('error', (e) => reject(new Error('语音识别连接失败: ' + e.message)));
      req.on('timeout', () => { req.destroy(); tryResource(); });
      req.write(body);
      req.end();
    }

    tryResource();
  });
}

module.exports = { volcanoRecognizeREST };
