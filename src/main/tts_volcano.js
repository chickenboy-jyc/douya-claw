/**
 * 语音合成 —— 火山引擎豆包语音合成大模型 2.0 (seed-tts-2.0)
 * 端点：POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 * 鉴权：X-Api-Key + X-Api-Resource-Id: seed-tts-2.0 + X-Api-Request-Id
 * 响应：HTTP Chunked，JSON 分片（NDJSON），每片 { code, data: base64 音频 }
 */
const https = require('https');
const crypto = require('crypto');

function volcanoTTS(apiKey, text, voice, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const speaker = voice || 'zh_female_tianmeixiaoyuan_uranus_bigtts';
    const body = JSON.stringify({
      user: { uid: 'douya-claw' },
      req_params: {
        text,
        speaker,
        audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: 0, loudness_rate: 0 },
        additions: JSON.stringify({ explicit_language: 'zh-cn' }),
      },
    });

    const req = https.request({
      hostname: 'openspeech.bytedance.com',
      path: '/api/v3/tts/unidirectional',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': 'seed-tts-2.0',
        'X-Api-Request-Id': crypto.randomUUID(),
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) {
        let raw = '';
        res.on('data', (d) => { raw += d.toString(); });
        res.on('end', () => reject(new Error('TTS 失败 (HTTP ' + res.statusCode + '): ' + raw.slice(0, 200))));
        return;
      }

      let buf = '';
      const chunks = [];
      const parseLine = (line) => {
        const t = line.trim();
        if (!t) return;
        try {
          const j = JSON.parse(t);
          if (j && typeof j.data === 'string' && j.data) {
            chunks.push(Buffer.from(j.data, 'base64'));
          }
          if (j && j.code && j.code !== 0 && j.code !== 20000000) {
            // 业务错误码
            if (!j.data) reject(new Error('TTS 失败：' + (j.message || ('code ' + j.code))));
          }
        } catch {}
      };

      res.on('data', (d) => {
        buf += d.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) parseLine(line);
      });
      res.on('end', () => {
        parseLine(buf);
        if (chunks.length === 0) reject(new Error('TTS 返回空音频'));
        else resolve(Buffer.concat(chunks));
      });
    });

    req.on('error', (e) => reject(new Error('TTS 连接失败: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('TTS 超时')); });
    req.write(body);
    req.end();
  });
}

module.exports = { volcanoTTS };
