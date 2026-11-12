import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/**
 * mediaAccountStore —— 新媒体「平台账号资产」数据层（第 8 项改造）。
 *
 * 解决的问题：平台账号矩阵原来只发「注册指引」，注册完用户无处回填账号，
 * 后续也没法一键跳到已登录的发文页。这里把账号变成一份可持久化的企业资产。
 *
 * 存储结构（localStorage key: douya-media-accounts）：
 * {
 *   [companyId]: {
 *     [platformKey]: { account: '账号/昵称', homepage: '主页链接', note: '备注', updatedAt: 1700000000000 }
 *   }
 * }
 * 严格按 companyId 隔离，切企业互不可见。
 */

export const MEDIA_ACCOUNTS_KEY = 'douya-media-accounts';

function asStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function loadAll() {
  try {
    const raw = localStorage.getItem(MEDIA_ACCOUNTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 归一化单条账号记录；account 与 homepage 都为空时视为未登记，返回 null。 */
export function normalizeAccount(rec) {
  const base = rec && typeof rec === 'object' ? rec : {};
  const account = asStr(base.account).trim();
  const homepage = asStr(base.homepage).trim();
  const note = asStr(base.note).trim();
  if (!account && !homepage) return null;
  return {
    account,
    homepage,
    note,
    updatedAt: Number(base.updatedAt) || Date.now(),
  };
}

const MediaAccountsContext = createContext(null);

export function MediaAccountProvider({ children }) {
  const [accounts, setAccounts] = useState(() => loadAll());

  useEffect(() => {
    try {
      localStorage.setItem(MEDIA_ACCOUNTS_KEY, JSON.stringify(accounts));
    } catch {
      /* localStorage 写失败（隐私模式/配额）时静默降级为内存态 */
    }
  }, [accounts]);

  /**
   * 保存/更新某企业在某平台的账号。
   * @param {string} companyId 企业 id
   * @param {string} platformKey 平台 key
   * @param {{account?:string, homepage?:string, note?:string}} patch 要写入的字段
   * @returns {{account:string, homepage:string, note:string, updatedAt:number}|null} 保存后的记录；全空则删除并返回 null
   */
  const saveAccount = useCallback((companyId, platformKey, patch) => {
    const cid = asStr(companyId);
    const pk = asStr(platformKey);
    if (!cid || !pk) return null;
    const next = normalizeAccount({ ...patch, updatedAt: Date.now() });
    setAccounts((prev) => {
      const all = { ...(prev || {}) };
      const byCompany = { ...(all[cid] || {}) };
      if (!next) {
        delete byCompany[pk];
      } else {
        byCompany[pk] = next;
      }
      if (Object.keys(byCompany).length === 0) delete all[cid];
      else all[cid] = byCompany;
      return all;
    });
    return next;
  }, []);

  /** 删除某企业在某平台的账号记录。 */
  const removeAccount = useCallback((companyId, platformKey) => {
    const cid = asStr(companyId);
    const pk = asStr(platformKey);
    if (!cid || !pk) return;
    setAccounts((prev) => {
      const all = { ...(prev || {}) };
      const byCompany = { ...(all[cid] || {}) };
      delete byCompany[pk];
      if (Object.keys(byCompany).length === 0) delete all[cid];
      else all[cid] = byCompany;
      return all;
    });
  }, []);

  /**
   * 列出某企业的全部已登记账号。
   * @param {string} companyId
   * @returns {Array<{platformKey:string, account:string, homepage:string, note:string, updatedAt:number}>}
   */
  const listForCompany = useCallback(
    (companyId) => {
      const cid = asStr(companyId);
      if (!cid) return [];
      const byCompany = (accounts || {})[cid] || {};
      return Object.keys(byCompany)
        .map((pk) => {
          const rec = normalizeAccount(byCompany[pk]);
          return rec ? { platformKey: pk, ...rec } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    [accounts],
  );

  /** 取某企业在某平台的单条账号；未登记返回 null。 */
  const getAccount = useCallback(
    (companyId, platformKey) => {
      const cid = asStr(companyId);
      const pk = asStr(platformKey);
      if (!cid || !pk) return null;
      return normalizeAccount(((accounts || {})[cid] || {})[pk]);
    },
    [accounts],
  );

  const value = useMemo(
    () => ({ accounts, saveAccount, removeAccount, listForCompany, getAccount }),
    [accounts, saveAccount, removeAccount, listForCompany, getAccount],
  );

  return <MediaAccountsContext.Provider value={value}>{children}</MediaAccountsContext.Provider>;
}

export function useMediaAccounts() {
  const ctx = useContext(MediaAccountsContext);
  if (!ctx) throw new Error('useMediaAccounts 必须在 <MediaAccountProvider> 子树内使用');
  return ctx;
}

export default MediaAccountProvider;
