/**
 * 设备指纹 —— 授权绑定的根
 * ================================================================
 *
 * 目的只有一个：**同一台机器每次算出同一串，换一台机器算出不同的串**。
 *
 * 为什么这件事最难，值得单独一个文件
 * ---------------------------------------------------------------
 * 「机器码」这类东西最容易写成「看起来能用、实际要么天天变、要么人人都一样」。
 * 两种坏法都很致命：
 *   · 天天变（比如把 IP、开机时间、可用内存算进去）⇒ 用户每次启动都要重新激活，
 *     投诉电话打爆，最后只能把校验关掉 —— 防护等于没做；
 *   · 人人都一样（比如只取主机名，而所有机器都叫 DESKTOP-XXXX）⇒ 绑定形同虚设，
 *     一份授权可以铺满全世界。
 *
 * 所以这里按「因子 → 稳定性」分级，**主因子拿不到就降级，但降级必须被记下来**，
 * 由服务端决定这个指纹够不够硬（见 strength 字段）。绝不因为某一项读不到就整个失败
 * —— 那会让一批正常用户被锁在门外。
 *
 * 因子与权重
 * ---------------------------------------------------------------
 * 准机器级（重装系统 / 换机器才会变）：
 *   machine-id  权重 100  OS 安装时生成的唯一 ID。首选，但**读不到是常态**：
 *                        这台开发机上 reg.exe 被安全软件列入程序黑名单，直接拒绝启动。
 *                        所以它只能算"锦上添花"，不能当唯一支柱。
 *   osInstall   权重  60  系统目录的 birthtime ≈ 系统安装时间。实测三次读数完全一致
 *                        （2024-04-01T07:21:16.184Z）。这是 machine-id 缺失时的主要替身。
 *   hostname    权重  40  主机名。Windows 默认形如 DESKTOP-4ECBE5I，后缀随机；
 *                        重名概率远低于"主机名都叫 PC"的直觉，配合其它因子足够。
 *
 * 辅助（有区分度但不该单靠）：
 *   cpu         权重  30  CPU 型号 + 逻辑核数。
 *   osVersion   权重  20  平台+版本+架构。只隔离"完全不同类的机器"。
 *   user        权重  20  用户目录名 + uid，区分同机不同账户。
 *   mac         权重  10  网卡 MAC —— **故意给低权重**：现在笔记本一堆虚拟网卡
 *                        （VMware / Hyper-V / WSL / Docker / VPN）随时增删，
 *                        把 MAC 当主因子是最常见的翻车点。
 *
 * 权重合计 280。实测本机（machine-id 取不到）为 180，仍高于阈值 120 ⇒ 强指纹。
 * 这个余量是故意留的：任何一个准机器级因子缺失，指纹都还站得住。
 *
 * 空值一律以 `-` 占位而不是跳过：跳过会让「读不到 machine-id」和「machine-id 恰好
 * 等于别的东西」产生同一个哈希，那就不是降级而是碰撞了。
 */

'use strict';

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 各因子的权重。改这里等于改指纹，所有已激活的机器都会失效 —— 慎重。 */
const WEIGHTS = Object.freeze({
  machineId: 100,
  osInstall: 60,
  hostname: 40,
  cpu: 30,
  osVersion: 20,
  user: 20,
  mac: 10,
});

/** 权重合计达到这个值才算「强指纹」，低于它的由服务端决定是否放行。 */
const STRONG_THRESHOLD = 120;

/** 因子顺序：**必须是固定数组**，绝不能依赖对象 key 顺序拼串。 */
const FACTOR_ORDER = Object.freeze([
  'machineId',
  'osInstall',
  'hostname',
  'cpu',
  'osVersion',
  'user',
  'mac',
]);

/**
 * 跑一条命令拿输出。任何失败都返回 null —— 指纹计算**永不抛异常**。
 * 为什么用 execFileSync 而不是 execSync：后者要把命令拼成一个字符串走 shell，
 * 路径里有空格/中文就会炸；前者传数组，参数不会被 shell 解释。
 */
function tryExec(file, args, opts) {
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...opts,
    });
    return String(out || '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * OS 级唯一机器 ID。
 *
 *   Windows：注册表 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`
 *            这是 Windows 安装时生成的 GUID，重装才变，是最可靠的来源。
 *            用 reg query 而不是读注册表 API —— 主进程里没有 native 模块可用，
 *            而 reg.exe 是系统自带的，不需要额外依赖。
 *   macOS  ：`IOPlatformUUID`，主板级 UUID。
 *   Linux  ：`/etc/machine-id`（systemd），退回 `/var/lib/dbus/machine-id`。
 *
 * 拿不到就返回 null，绝不编一个假的（编假的＝所有人同一指纹）。
 */
function readMachineId() {
  const platform = process.platform;

  if (platform === 'win32') {
    // 注意路径前缀：`HKLM\SOFTWARE\...` 在 32 位进程里会被重定向到 WOW6432Node，
    // 用 `reg query "HKLM\SOFTWARE\..." /reg:64` 明确指 64 位视图，避免两种进程
    // 读出两个不同的值 —— 那就成了「同一台机器、两个指纹」。
    const out = tryExec('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
      '/reg:64',
    ]);
    if (out) {
      // 输出形如：    MachineGuid    REG_SZ    d0e5f2b1-...
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{32,40})/);
      if (m) return m[1].toLowerCase();
      // 有些系统语言下 REG_SZ 后面是全角空格或换行，退化到「取最后一个非空 token」
      const tokens = out.split(/\s+/).filter(Boolean);
      const last = tokens[tokens.length - 1];
      if (last && /^[0-9a-fA-F-]{32,40}$/.test(last)) return last.toLowerCase();
    }
    return null;
  }

  if (platform === 'darwin') {
    const out = tryExec('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    if (out) {
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1].toLowerCase();
    }
    return null;
  }

  // Linux / 其它 unix
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id', '/sys/class/dmi/id/product_uuid']) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v.toLowerCase();
    } catch {
      // 下一个
    }
  }
  return null;
}

/**
 * 系统安装时间（≈ osInstall）。
 *
 * 为什么用「系统目录的 birthtime」当替身：
 *   machine-id 是最理想的机器级因子，但它要靠外部命令（reg.exe / ioreg）去读，
 *   而**安全软件经常会拦这些命令** —— 本机实测 reg.exe 直接被程序黑名单拒绝启动。
 *   一旦被拦，指纹强度就掉一大截，等于把「能不能激活」押在用户装了什么杀软上。
 *
 * 而系统目录的创建时间：
 *   · 纯 `fs.statSync`，不需要任何外部进程，杀软管不着；
 *   · 实测同机连读三次完全一致（`1711956076184.4348`）；
 *   · 只有重装系统才会变 —— 和 machine-id 的稳定性属于同一档。
 *
 * 精度处理：birthtimeMs 是浮点（NTFS 时间戳精度到 100ns），不同 node 版本
 * 可能在末几位抖动。**取整到天**（除以 86400000 后取整），
 * 这样既保留「哪天装的系统」这个有效信息，又不会被浮点末位毁掉稳定性。
 * 代价是：同一天装的两台机器在这一个因子上碰撞 —— 但它只是多个因子之一，可接受。
 */
function readOsInstall() {
  const candidates =
    process.platform === 'win32'
      ? [
          process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32',
          'C:\\Windows',
        ]
      : ['/etc', '/usr/bin', '/'];

  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      const ms = Number(st.birthtimeMs);
      // birthtime 无效时（某些文件系统返回 0 / 1970）不能用 —— 那会让所有这类机器撞一起
      if (!Number.isFinite(ms) || ms <= 0) continue;
      if (ms < Date.UTC(2000, 0, 1)) continue; // 2000 年之前视为「读不到」
      return String(Math.floor(ms / 86400000)); // 天序号
    } catch {
      // 下一个
    }
  }
  return null;
}

/** 主机名。Windows 默认 DESKTOP-XXXXXXX，后缀随机。 */
function readHostname() {
  try {
    const h = String(os.hostname() || '').trim().toLowerCase();
    // 空的、或明显是占位值的都不要（某些容器里 hostname 恒为 localhost）
    if (!h || h === 'localhost' || h === 'localhost.localdomain') return null;
    return h;
  } catch {
    return null;
  }
}

/** CPU 型号 + 物理核数。同型号会撞，只做辅助因子。 */
function readCpu() {
  const cpus = os.cpus() || [];
  if (!cpus.length) return null;
  const model = String(cpus[0].model || '').trim().replace(/\s+/g, ' ');
  const cores = cpus.length;
  return model ? `${model}|${cores}` : null;
}

/** 平台 + 版本。区分度低，只用来隔离「完全不同类的机器」。 */
function readOsVersion() {
  return `${process.platform}|${os.release()}|${process.arch}`;
}

/**
 * 用户标识。
 * 用 `os.homedir()` 的末级目录名 + 用户 uid。
 * 不直接用 username —— 域账户下 username 可能不含域名，两台不同域的同名用户会撞；
 * homedir 至少带上了域/机器前缀。
 */
function readUser() {
  let home = '';
  try {
    home = os.homedir() || '';
  } catch {
    home = '';
  }
  const leaf = home ? path.basename(home.replace(/[\\/]+$/, '')) : '';
  let uid = '';
  try {
    uid = typeof process.getuid === 'function' ? String(process.getuid()) : '';
  } catch {
    uid = '';
  }
  return leaf || uid ? `${leaf}|${uid}` : null;
}

/**
 * 网卡 MAC。
 * ⚠️ 只取**物理网卡**，且显式排除虚拟网卡 —— 否则装个 Docker 或连上 VPN，
 *    MAC 列表就变了，用户会被判成「换了机器」。
 * 排除规则按网卡名，而不是按 MAC 前缀：前缀规则各家虚拟机厂商不统一，且会误杀。
 */
function readMac() {
  const VIRTUAL = /^(veth|vmnet|vboxnet|docker|br-|virbr|utun|tun|tap|zt|wg|ppp|lo|bridge|hyper-v|vethernet|npcap|tap-|wsl)/i;
  let ifaces;
  try {
    ifaces = os.networkInterfaces() || {};
  } catch {
    return null;
  }

  const macs = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs || []) {
      // family 在 node 18+ 是字符串 'IPv4'，更早是数字 4；两种都认
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (!isV4) continue;
      if (a.internal) continue;
      const mac = String(a.mac || '').toLowerCase();
      if (!mac || mac === '00:00:00:00:00:00') continue;
      // 本地管理位（第一字节的 bit1）为 1 的通常是软件生成的地址，排除
      const first = parseInt(mac.slice(0, 2), 16);
      if (Number.isFinite(first) && (first & 0x02)) continue;
      macs.push(mac);
    }
  }
  if (!macs.length) return null;
  // 排序后取第一个：网卡枚举顺序在系统间不稳定，不排序会导致同一台机器算出不同值
  macs.sort();
  return macs[0];
}

/**
 * 计算指纹。
 *
 * @returns {{
 *   id: string,               // 32 位十六进制，对外只暴露这个
 *   strength: number,         // 命中的权重合计（0~180）
 *   strong: boolean,          // strength >= STRONG_THRESHOLD
 *   factors: Record<string, boolean>,  // 每个因子拿没拿到（**不暴露原值**）
 *   missing: string[],        // 缺失的因子名，排障用
 *   version: number           // 指纹算法版本，改算法时递增，服务端可据此要求重新激活
 * }}
 *
 * 注意：**绝不把原始因子返回给调用方**。原始值（尤其是 MachineGuid）一旦流到
 * 渲染层或日志里，就等于把「怎么伪造指纹」的配方交出去了。对外只有 id + 元信息。
 */
function computeFingerprint() {
  const raw = {
    machineId: readMachineId(),
    osInstall: readOsInstall(),
    hostname: readHostname(),
    cpu: readCpu(),
    osVersion: readOsVersion(),
    user: readUser(),
    mac: readMac(),
  };

  const parts = [];
  const factors = {};
  const missing = [];
  let strength = 0;

  for (const key of FACTOR_ORDER) {
    const val = raw[key];
    const got = val != null && String(val) !== '';
    factors[key] = got;
    if (got) strength += WEIGHTS[key];
    else missing.push(key);
    // ⚠️ 缺失时用 `-` 占位而不是跳过：
    //    跳过会让「machineId 缺失」与「machineId 恰好等于下一个因子」撞成同一个串。
    parts.push(`${key}=${got ? val : '-'}`);
  }

  const id = crypto
    .createHash('sha256')
    .update(`v2|${parts.join('|')}`, 'utf8')
    .digest('hex')
    .slice(0, 32);

  return {
    id,
    strength,
    strong: strength >= STRONG_THRESHOLD,
    factors,
    missing,
    version: 2,
  };
}

/**
 * 给用户看的短码（报障时念给客服听）。
 * 取指纹前 8 位、每 4 位一组，形如 `A1B2-C3D4`。
 * 只是展示用，**不能用于授权判定** —— 位数太少，碰撞率不可接受。
 */
function shortCode(fp) {
  const id = String((fp && fp.id) || '');
  if (id.length < 8) return '--------';
  const up = id.slice(0, 8).toUpperCase();
  return `${up.slice(0, 4)}-${up.slice(4, 8)}`;
}

module.exports = {
  computeFingerprint,
  shortCode,
  WEIGHTS,
  STRONG_THRESHOLD,
  FACTOR_ORDER,
  // 单独导出给测试用：验证每个因子在拿不到时是降级而不是崩
  __internals: {
    readMachineId,
    readOsInstall,
    readHostname,
    readCpu,
    readOsVersion,
    readUser,
    readMac,
    tryExec,
  },
};
