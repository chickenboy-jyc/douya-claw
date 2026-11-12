/**
 * 授权凭据的加密落盘
 * ================================================================
 *
 * 存在的理由只有一条：**把整个 userData 目录拷到另一台机器，里面的授权要解不开。**
 *
 * 如果只做「服务端校验 + 本地明文存 token」，攻击者根本不用破解：
 * 把 `%APPDATA%\豆芽CLAW\` 整个拷给同事，同事那边 token 在、指纹是**他自己机器的**，
 * 服务端一比对就拒 —— 这条能挡住。但更省事的攻击是：拷过来的 token 是明文，
 * 直接读出来贴进自己的客户端、再把指纹计算那几行改成常量，就通了。
 *
 * 所以这里做两层：
 *
 *   1. **载体加密**。凭据不以明文落地。
 *      · 有 Electron `safeStorage` 时用它 —— Windows 走 DPAPI，密钥绑「当前用户+当前机器」，
 *        换机器、换用户都解不开。这是最省事也最可靠的一层。
 *      · 没有 Electron（纯 node 单测 / 服务端复用）时，退化为
 *        **用设备指纹派生密钥的 AES-256-GCM**。指纹不同 ⇒ 密钥不同 ⇒ 解不开。
 *
 *   2. **指纹短码一起存**。不是为了安全，是为了**排障**：
 *      用户打来问「为什么说我的授权无效」，日志里能看到
 *      「vault 存的是 FA2C-C3C7，现在这台是 9D31-77E0」——
 *      一眼就知道是换了机器，而不是对着「授权无效」四个字瞎猜。
 *
 * 为什么不用 Electron 自带的 `app.getPath('userData')` 之外的位置：
 *   不藏。藏到临时目录 / 注册表 / 隐藏文件只会让**杀软把正常软件当木马**，
 *   而且用户换机迁移时数据丢失、投诉更多。安全应该来自「解不开」，而不是「找不到」。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** 落盘文件名。与 `auth-token.json` / `current-account.json` 同级（都在 dataDir 下）。 */
const VAULT_NAME = 'license.vault';

/**
 * 派生密钥时拌进去的固定盐串。
 * 这不是密码学意义上的秘密，它的作用只是**把本 vault 的密钥和其它用途的密钥隔离**
 * —— 同一个人用同一台机器做别的事，不该派生出同一个密钥。
 */
const KDF_CONTEXT = 'douya-license-vault-v1';

/** scrypt 参数。N=2^15 在普通机器上约 60~100ms，足够慢到让暴力枚举不划算，又不至于卡启动。 */
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32 });

/**
 * 用指纹派生 32 字节密钥。
 * 加盐（salt）是为了让「同一指纹 + 不同 vault 文件」的密钥不同 —— 防止
 * 攻击者预先算好一张指纹→密钥的表（彩虹表式）直接解所有用户的 vault。
 */
function deriveKey(fpId, salt) {
  const material = `${String(fpId)}|${KDF_CONTEXT}`;
  return crypto.scryptSync(material, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    // scrypt 的默认 maxmem 对 N=32768 不够（需要约 128*N*r ≈ 33MB），必须放宽
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
}

/**
 * 读取结果的原因码。
 * 这几个值的区分**非常关键** —— 它们对应完全不同的用户动作：
 *   ENOENT          没激活过（第一次用）           ⇒ 弹激活窗
 *   DECRYPT_FAILED  解不开，极大概率换了机器       ⇒ 要求重新激活，**不要**报「文件损坏」
 *   CORRUPT         文件在但格式不对（写坏了）      ⇒ 可自愈：删掉重来
 *   NO_FP           指纹算不出来                   ⇒ 环境异常，别删用户数据
 */
const Reason = Object.freeze({
  OK: 'OK',
  ENOENT: 'ENOENT',
  DECRYPT_FAILED: 'DECRYPT_FAILED',
  CORRUPT: 'CORRUPT',
  NO_FP: 'NO_FP',
  IO_ERROR: 'IO_ERROR',
});

/** AES-256-GCM 的 IV 固定 12 字节（GCM 推荐长度，比 16 更快且同样安全）。 */
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * 创建 vault 实例。
 *
 * @param {object} opts
 * @param {string} opts.dataDir        凭据落盘目录（Electron 下是 app.getPath('userData')）
 * @param {Function} opts.getFingerprint 返回 { id, strength, ... }；每次读写都会重新取，
 *                                     **不缓存** —— 缓存会让「运行中换了网卡」这种变化
 *                                     在下次启动时才被发现，表现为"昨天还好今天打不开"
 * @param {object} [opts.safeStorage] Electron 的 safeStorage（可选）。
 *                                    传了就优先用它；不传或不可用则用指纹派生。
 * @param {string} [opts.fileName]    覆盖落盘文件名（测试用）
 */
function createVault(opts) {
  const dataDir = String((opts && opts.dataDir) || '');
  if (!dataDir) throw new Error('createVault: 缺少 dataDir');

  const getFingerprint = opts.getFingerprint;
  if (typeof getFingerprint !== 'function') {
    throw new Error('createVault: 缺少 getFingerprint');
  }

  const safeStorage = opts.safeStorage || null;
  const fileName = opts.fileName || VAULT_NAME;
  const filePath = path.join(dataDir, fileName);

  /** safeStorage 是否真的可用。`isEncryptionAvailable()` 在部分 Linux 桌面下会返回 false。 */
  function osCryptoAvailable() {
    if (!safeStorage) return false;
    try {
      if (typeof safeStorage.isEncryptionAvailable === 'function') {
        return safeStorage.isEncryptionAvailable() === true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function currentFp() {
    try {
      const fp = getFingerprint();
      if (!fp || !fp.id) return null;
      return fp;
    } catch {
      return null;
    }
  }

  /**
   * 把一个对象加密成可落盘的文本。
   * 两种模式的产物形状一致（都是 JSON，带 mode 标记），读取时按 mode 分流。
   */
  function seal(obj, fp) {
    const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');

    if (osCryptoAvailable()) {
      const buf = safeStorage.encryptString(plaintext.toString('utf8'));
      return {
        v: 1,
        mode: 'os',
        fpShort: shortFp(fp.id),
        updatedAt: Date.now(),
        blob: Buffer.from(buf).toString('base64'),
      };
    }

    // 降级：指纹派生
    const salt = crypto.randomBytes(16);
    const key = deriveKey(fp.id, salt);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      v: 1,
      mode: 'fp',
      fpShort: shortFp(fp.id),
      updatedAt: Date.now(),
      salt: salt.toString('base64'),
      // iv|tag|ct 拼一起，少三个字段、少一次出错机会
      blob: Buffer.concat([iv, tag, ct]).toString('base64'),
    };
  }

  /** 解密。失败一律返回 { ok:false, reason } —— **绝不抛异常**给调用方。 */
  function unseal(envelope, fp) {
    try {
      const blob = Buffer.from(String(envelope.blob || ''), 'base64');
      if (!blob.length) return { ok: false, reason: Reason.CORRUPT };

      if (envelope.mode === 'os') {
        if (!osCryptoAvailable()) {
          // 换到没有 safeStorage 的环境（或换了用户），OS 层就解不开了
          return { ok: false, reason: Reason.DECRYPT_FAILED };
        }
        const text = safeStorage.decryptString(blob);
        return { ok: true, data: JSON.parse(text) };
      }

      if (envelope.mode === 'fp') {
        const salt = Buffer.from(String(envelope.salt || ''), 'base64');
        if (salt.length !== 16) return { ok: false, reason: Reason.CORRUPT };
        if (blob.length < IV_LEN + TAG_LEN + 1) return { ok: false, reason: Reason.CORRUPT };

        const iv = blob.subarray(0, IV_LEN);
        const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
        const ct = blob.subarray(IV_LEN + TAG_LEN);

        const key = deriveKey(fp.id, salt);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        // GCM 的 authTag 不匹配时会在这里 throw —— 正是"换了机器"的判定点
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return { ok: true, data: JSON.parse(pt.toString('utf8')) };
      }

      return { ok: false, reason: Reason.CORRUPT };
    } catch (e) {
      // 区分「认证失败」和「格式坏」：
      //   GCM 认证失败 = 密钥不对 = 换了机器/被篡改 ⇒ DECRYPT_FAILED
      //   其它（JSON.parse 失败等）= 文件坏了 ⇒ CORRUPT
      const msg = String((e && e.message) || '');
      if (/unable to authenticate|bad decrypt|Invalid ciphertext|Unsupported state/i.test(msg)) {
        return { ok: false, reason: Reason.DECRYPT_FAILED };
      }
      if (e instanceof SyntaxError) return { ok: false, reason: Reason.CORRUPT };
      return { ok: false, reason: Reason.DECRYPT_FAILED };
    }
  }

  return {
    filePath,
    Reason,

    /** 实际使用的加密模式（'os' | 'fp'）。诊断/日志用。 */
    mode() {
      return osCryptoAvailable() ? 'os' : 'fp';
    },

    /**
     * 读。
     * @returns {{ ok:boolean, data?:object, reason?:string, fpShortStored?:string }}
     */
    read() {
      const fp = currentFp();
      if (!fp) return { ok: false, reason: Reason.NO_FP };

      let text;
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        if (e && e.code === 'ENOENT') return { ok: false, reason: Reason.ENOENT };
        return { ok: false, reason: Reason.IO_ERROR };
      }

      let envelope;
      try {
        envelope = JSON.parse(text);
      } catch {
        return { ok: false, reason: Reason.CORRUPT };
      }
      if (!envelope || typeof envelope !== 'object' || !envelope.blob) {
        return { ok: false, reason: Reason.CORRUPT };
      }

      const r = unseal(envelope, fp);
      if (!r.ok) {
        return { ok: false, reason: r.reason, fpShortStored: envelope.fpShort || null };
      }
      return { ok: true, data: r.data, fpShortStored: envelope.fpShort || null };
    },

    /**
     * 写。
     * 用「先写临时文件再 rename」—— 直接覆写的话，断电/崩溃会留下半截文件，
     * 而半截文件解析失败会被判成 CORRUPT，用户就要重新激活。rename 在同一分区上是原子的。
     */
    write(obj) {
      const fp = currentFp();
      if (!fp) return { ok: false, reason: Reason.NO_FP };

      let envelope;
      try {
        envelope = seal(obj, fp);
      } catch {
        return { ok: false, reason: Reason.IO_ERROR };
      }

      const tmp = `${filePath}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
        fs.renameSync(tmp, filePath);
        return { ok: true, mode: envelope.mode };
      } catch {
        try { fs.unlinkSync(tmp); } catch { /* 清临时文件失败不影响主流程 */ }
        return { ok: false, reason: Reason.IO_ERROR };
      }
    },

    /** 删掉（重新激活前调用）。删不掉也不算致命。 */
    clear() {
      try {
        fs.unlinkSync(filePath);
        return { ok: true };
      } catch (e) {
        if (e && e.code === 'ENOENT') return { ok: true };
        return { ok: false };
      }
    },

    /** 文件在不在（不解析）。 */
    exists() {
      try {
        fs.accessSync(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** 指纹 id → 展示短码（与 fingerprint.shortCode 同规则，这里复制一份避免循环依赖）。 */
function shortFp(id) {
  const s = String(id || '');
  if (s.length < 8) return '--------';
  const up = s.slice(0, 8).toUpperCase();
  return `${up.slice(0, 4)}-${up.slice(4, 8)}`;
}

module.exports = {
  createVault,
  shortFp,
  VAULT_NAME,
  KDF_CONTEXT,
  SCRYPT,
  Reason,
  __internals: { deriveKey, IV_LEN, TAG_LEN },
};
