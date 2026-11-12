/**
 * DealerPurchase —— 经销商采购专区（仅 dealer 可见）
 *
 * 【老板 2026-10-14 原始需求】
 *   经销商：1. 就是买东西，批量买东西
 *           2. 看优惠的商品
 *
 * 两个页签对应两件事：
 *   批量采购 —— 阶梯价（买得越多单价越低）+ 起订量 + 一键凑单比价
 *   优惠专区 —— 限时折扣专区，标清原价/现价/截止
 *
 * 数据来自 clinicDealerSeed.js 的 SEED_BULK_PRODUCTS / SEED_PROMOS（种子，页面已标）。
 * 阶梯价算法是纯函数 tierPriceOf()，接真实商品接口后只换数据源。
 */
import React, { useMemo, useState } from 'react';
import { Button, InputNumber, Segmented, Tag, Modal } from 'antd';
import LineIcon from '../components/LineIcon.jsx';
import { SEED_BULK_PRODUCTS, SEED_PROMOS, SEED_META } from '../data/clinicDealerSeed.js';
import '../styles/dealer-purchase.css';

/**
 * 阶梯价：给定数量，返回命中的档位与最终单价。
 * @param {object} product 含 tiers: [{ qty, unitPrice }]
 * @param {number} qty 采购数量
 */
export function tierPriceOf(product, qty) {
  const tiers = [...(product?.tiers || [])].sort((a, b) => a.qty - b.qty);
  let hit = null;
  for (const t of tiers) if (qty >= t.qty) hit = t;
  // 不足最低档：按最低档单价算，但标注「未达起订量」
  const unit = (hit || tiers[0])?.unitPrice ?? 0;
  return {
    tier: hit,
    unit,
    total: unit * qty,
    belowMoq: !hit,
    nextTier: tiers.find((t) => qty < t.qty) || null,
  };
}

function SeedTag() {
  return <span className="dp-seedtag" title={SEED_META.note}>示例数据</span>;
}

/* ── 页签 1：批量采购 ── */
function BulkPanel({ onSubmit }) {
  const [qty, setQty] = useState({});
  const qOf = (p) => qty[p.id] ?? p.moq;
  const total = useMemo(
    () => SEED_BULK_PRODUCTS.reduce((s, p) => s + tierPriceOf(p, qOf(p)).total, 0),
    [qty]
  );
  const saved = useMemo(
    () => SEED_BULK_PRODUCTS.reduce((s, p) => {
      const base = p.tiers[0].unitPrice * qOf(p);
      return s + Math.max(base - tierPriceOf(p, qOf(p)).total, 0);
    }, 0),
    [qty]
  );

  return (
    <div className="dp-panel">
      <div className="dp-sec-hd">
        <span className="dp-sec-t">批量采购</span>
        <SeedTag />
      </div>
      <p className="dp-lead">
        改数量自动命中阶梯价 —— 买得越多单价越低。当前比按最低档单价<b>省 ¥{saved.toFixed(2)}</b>。
      </p>

      <div className="dp-bulk-list">
        {SEED_BULK_PRODUCTS.map((p) => {
          const q = qOf(p);
          const pr = tierPriceOf(p, q);
          const cur = p.tiers.find((t) => t.unitPrice === pr.unit);
          return (
            <div className="dp-bulk" key={p.id}>
              <div className="dp-bulk-main">
                <div className="dp-bulk-t">
                  {p.name}
                  {p.hot && <Tag color="volcano" className="dp-tag">热销</Tag>}
                  <span className="dp-bulk-cat">{p.cat} · {p.spec}</span>
                </div>

                <div className="dp-tiers">
                  {p.tiers.map((t, i) => (
                    <span key={t.qty} className={'dp-tier' + (cur === t ? ' on' : '')}>
                      ≥{t.qty} 件 ¥{t.unitPrice}
                    </span>
                  ))}
                </div>

                <div className="dp-bulk-meta">
                  <span>库存 {p.stock.toLocaleString()}</span>
                  <span>起订 {p.moq} 件</span>
                  {pr.nextTier && (
                    <span className="dp-next">
                      再买 {pr.nextTier.qty - q} 件，单价降到 ¥{pr.nextTier.unitPrice}
                    </span>
                  )}
                  {pr.belowMoq && (
                    <span className="dp-warn">未达最低档 ¥{p.tiers[0].unitPrice}</span>
                  )}
                </div>
              </div>

              <div className="dp-bulk-side">
                <div className="dp-price">
                  <span className="dp-price-n">¥{pr.unit}</span>
                  <span className="dp-price-u">/ 件</span>
                </div>
                <InputNumber
                  size="small" min={1} max={99999} value={q}
                  onChange={(v) => v && setQty({ ...qty, [p.id]: v })}
                />
                <div className="dp-sub">小计 ¥{pr.total.toFixed(2)}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="dp-bar">
        <span>
          合计 <b>¥{total.toFixed(2)}</b>
          {saved > 0 && <em>（已省 ¥{saved.toFixed(2)}）</em>}
        </span>
        <Button
          type="primary" size="large"
          onClick={() => onSubmit(SEED_BULK_PRODUCTS.map((p) => ({
            id: p.id, name: p.name, qty: qOf(p),
            unit: tierPriceOf(p, qOf(p)).unit,
            total: tierPriceOf(p, qOf(p)).total,
          })), total)}
        >
          生成采购单
        </Button>
      </div>
    </div>
  );
}

/* ── 页签 2：优惠专区 ── */
function PromoPanel({ onBuy }) {
  return (
    <div className="dp-panel">
      <div className="dp-sec-hd">
        <span className="dp-sec-t">优惠专区</span>
        <SeedTag />
      </div>
      <p className="dp-lead">限时折扣 —— 截止前囤货最划算。</p>

      <div className="dp-promos">
        {SEED_PROMOS.map((r) => {
          const p = SEED_BULK_PRODUCTS.find((x) => x.id === r.productId);
          if (!p) return null;
          const off = Math.round(((r.from - r.to) / r.from) * 100);
          return (
            <div className="dp-promo" key={r.id}>
              <div className="dp-promo-badge">{r.tag}</div>
              <div className="dp-promo-t">{r.title}</div>
              <div className="dp-promo-p">{p.name}</div>
              <div className="dp-promo-price">
                <s>¥{r.from}</s>
                <b>¥{r.to}</b>
                <em>省 {off}%</em>
              </div>
              <div className="dp-promo-note">{r.note}</div>
              <div className="dp-promo-ft">
                <span className="dp-promo-end">截止 {r.endAt}</span>
                <Button size="small" type="primary" onClick={() => onBuy(r, p)}>去看看</Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DealerPurchase() {
  const [tab, setTab] = useState('bulk');

  return (
    <div className="module-page dealer-purchase">
      <div className="page-banner">
        <div className="page-banner-ic" aria-hidden="true">
          <span className="page-banner-ic-halo" />
          <LineIcon name="cart" size={38} variant="plain" />
        </div>
        <div className="page-banner-txt">
          <h2 className="page-banner-title">采购专区</h2>
          <div className="page-banner-sub">批量采购走阶梯价，优惠专区捡漏 —— 进货只看这两件事。</div>
        </div>
        <div className="page-banner-slogan" aria-hidden="true">
          <span className="page-banner-slogan-t">进得越多，单价越低</span>
          <svg className="page-banner-slogan-line" viewBox="0 0 120 10" preserveAspectRatio="none">
            <path d="M2 7 C 30 2, 90 2, 118 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      <div className="so-tabs">
        <button
          type="button"
          className={'so-tab' + (tab === 'bulk' ? ' on' : '')}
          onClick={() => setTab('bulk')} data-dp-tab="bulk"
        >
          <LineIcon name="box" size={16} variant="plain" />批量采购
        </button>
        <button
          type="button"
          className={'so-tab' + (tab === 'promo' ? ' on' : '')}
          onClick={() => setTab('promo')} data-dp-tab="promo"
        >
          <LineIcon name="gift" size={16} variant="plain" />优惠专区
        </button>
      </div>

      {tab === 'bulk' && (
        <BulkPanel
          onSubmit={(lines, total) => Modal.info({
            title: '采购单已生成',
            content: `共 ${lines.length} 项 · 合计 ¥${total.toFixed(2)}（示例数据，接入商城后可直接下单）`,
          })}
        />
      )}
      {tab === 'promo' && (
        <PromoPanel
          onBuy={(r, p) => Modal.info({
            title: r.title,
            content: `${p.name} 优惠价 ¥${r.to}，截止 ${r.endAt}`,
          })}
        />
      )}
    </div>
  );
}