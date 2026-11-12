/**
 * StoreOps —— 门店运营（牙医 / 诊所专属）
 *
 * 【老板 2026-10-14 原始需求，逐条对应】
 *   牙医/诊所：
 *     1. 自动补货 —— 库存低于 XXX 自动下单补货；非必须材料自动选优惠力度大的
 *                    （牙线/手套/一次性用品）                → 页签「库存补货」
 *     2. 活动预告 —— 参加 XX 活动能得什么奖品、参与方式（薅羊毛用） → 页签「活动预告」
 *     3. 3 公里竞品 —— 按地区路段分析，如"上海某小区 3 公里内 7 家牙医店，
 *                    怎么获取更多用户 / 分析竞品店 / 帮忙做运营"    → 页签「周边竞品」
 *     4. 公关危机 —— 小红书/美团/高德地图差评提醒       → 见PrCrisis（本模块只放入口）
 *     5. 牙医课程碎片化学习                          → 见 LearningStation（本模块只放入口）
 *     6. AI 电子病历                                  → 页签「电子病历」
 *
 * 【为什么单独建模块而不是塞进现有页】
 * 这六项是**牙医/诊所的日常经营动作**，与厂家/平台关心的（内容、媒体、竞品大盘）
 * 完全不同。按老板确认的「侧栏按身份变」，这个模块只对
 * clinic / doctor 可见，manufacturer / platform 侧栏里根本不出现。
 *
 * 【数据现状】除「库存补货」外，仍来自 clinicDealerSeed.js 的种子数据，页面上明确标「示例数据」。
 * 【需求 1「自动补货」已在 0.21.14 迁到独立页面「AI 补货」（`modules/Replenish.jsx`）】
 *   本模块的「库存补货」页签保留锚点与页签名，但内容换成一张引导卡 + 跳转按钮
 *   （`[data-so-goto-replenish]`）；旧的种子库存行与补货算法已整条删除 ——
 *   那一版的驱动模型（本地库存水位）与老板要的（商城现货）不是一件事。
 */
import React, { useMemo, useState } from 'react';
import { Button, InputNumber, Modal, Segmented, Tag, Tooltip } from 'antd';
import LineIcon from '../components/LineIcon.jsx';
import {
  SEED_NEARBY, SEED_OPS_ACTIONS,
  SEED_CAMPAIGNS, SEED_PATIENTS, SEED_META,
} from '../data/clinicDealerSeed.js';

import '../styles/store-ops.css';

/** 数据源徽章：不让种子数据看起来像真结果。 */
function SeedTag() {
  return <span className="so-seedtag" title={SEED_META.note}>示例数据</span>;
}

/* ══════════════════════════════════════════════════════════
   页签 1：库存补货 —— **已迁走**，这里只留一张引导卡（0.21.14 · 需求 3）
   ══════════════════════════════════════════════════════════ */
/**
 * 旧「库存与自动补货」的下线说明 + 跳转入口。
 *
 * 为什么不是「删页签」而是「换内容」（PRD Q10 定案）：
 *   ① 用户的肌肉记忆还在「门店运营 → 库存补货」，直接删会找不到；
 *   ② `scripts/tmp-probe/newmods-probe.mjs` 有一条 5 页签断言，删页签会连带打断它 ——
 *      留锚点只改内容，门禁只需改一条断言。
 *
 * 为什么内容必须换掉（而不是留着当参考）：
 *   那一版是**种子假数据**驱动的（写死的库存水位 + 供应商报价），而老板要的是
 *   「商城现在有没有货 → 有货就提醒我买」。两套模型混在一页里，用户只会困惑
 *   「到底哪个数字说了算」；0.21.13 刚因为假数据被批过一次。
 *
 * ⚠️ 这一块**不许**再长出任何库存数字：库存现在只有「有货 / 没货」两态
 *    （上游给的是一句话的真假，不是件数，见 PRD AC-3.12b）。
 *
 * @param {object} props
 * @param {Function} [props.onSelectModule] 由 `App.jsx` 注入的模块切换函数
 */
function StockGuidePanel({ onSelectModule }) {
  return (
    <div className="so-panel" data-so-replenish-guide="1">
      <div className="so-sec-hd">
        <span className="so-sec-t">库存补货</span>
      </div>
      <p className="so-lead">
        补货搬到独立页面了：<b>AI 补货</b>。那边用商城的真实商品，不再用示例数据。
      </p>
      <p className="so-lead">常买的东西可以存成清单，也能上传表格。</p>
      <p className="so-lead">哪件没货，可以看看同品类有没有替代。</p>
      <p className="so-lead">有货了，左边导航会给你数字提醒。</p>
      <p className="so-lead">平常补货只比价格，能设最高单价，也能勾「优先选打折的」。</p>
      <div style={{ marginTop: 12 }}>
        <Button type="primary" data-so-goto-replenish="1" onClick={() => onSelectModule && onSelectModule('replenish')}>
          去 AI 补货
        </Button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   页签 2：周边竞品（需求 3）
   ══════════════════════════════════════════════════════════ */
function NearbyPanel() {
  const [sel, setSel] = useState(SEED_NEARBY.competitors[0].id);
  const cur = SEED_NEARBY.competitors.find((c) => c.id === sel);
  const avg = Math.round(SEED_NEARBY.competitors.reduce((s, c) => s + c.perCapita, 0) / SEED_NEARBY.competitors.length);

  return (
    <div className="so-panel">
      <div className="so-sec-hd">
        <span className="so-sec-t">周边 {SEED_NEARBY.center.radiusKm} 公里竞品</span>
        <SeedTag />
      </div>
      <p className="so-lead">
        范围：<b>{SEED_NEARBY.center.name}</b>（{SEED_NEARBY.center.address}）· 半径 {SEED_NEARBY.center.radiusKm} km ·
        共 <b>{SEED_NEARBY.competitors.length}</b> 家 · 客单价均值 <b>¥{avg}</b>
      </p>

      <div className="so-near-grid">
        <div className="so-near-list">
          {SEED_NEARBY.competitors.map((c) => (
            <button
              key={c.id}
              type="button"
              className={'so-near-item' + (sel === c.id ? ' on' : '')}
              onClick={() => setSel(c.id)}
            >
              <div className="so-near-hd">
                <span className="so-near-n">{c.name}</span>
                <span className="so-near-d">{c.distKm} km</span>
              </div>
              <div className="so-near-meta">
                <span className={'so-star' + (c.rating >= 4.5 ? ' hi' : '')}>★ {c.rating}</span>
                <span>{c.reviews} 评价</span>
                <span>客单 ¥{c.perCapita}</span>
              </div>
              <div className="so-near-tag">{c.strength}</div>
            </button>
          ))}
        </div>

        <div className="so-near-detail">
          <div className="so-map">
            <div className="so-map-ring r1" />
            <div className="so-map-ring r2" />
            <div className="so-map-ring r3" />
            <div className="so-map-me"><LineIcon name="home" size={15} variant="plain" /></div>
            {SEED_NEARBY.competitors.map((c, i) => (
              <div
                key={c.id}
                className={'so-map-pin' + (sel === c.id ? ' on' : '')}
                style={{
                  // 极简示意：按序号分布在一个圆上，不做真实地理投影
                  left: `${50 + 34 * Math.cos((i / SEED_NEARBY.competitors.length) * Math.PI * 2 - Math.PI / 2)}%`,
                  top: `${50 + 34 * Math.sin((i / SEED_NEARBY.competitors.length) * Math.PI * 2 - Math.PI / 2)}%`,
                }}
                title={c.name}
              >
                {i + 1}
              </div>
            ))}
            <div className="so-map-scale">{SEED_NEARBY.center.radiusKm} km</div>
          </div>

          {cur && (
            <div className="so-near-card">
              <div className="so-near-card-t">{cur.name}</div>
              <div className="so-kv"><span>距离</span><b>{cur.distKm} km</b></div>
              <div className="so-kv"><span>评分 / 评价</span><b>★ {cur.rating}（{cur.reviews}）</b></div>
              <div className="so-kv"><span>客单价</span><b>¥{cur.perCapita}</b></div>
              <div className="so-kv"><span>强项</span><b>{cur.strength}</b></div>
              <div className="so-kv"><span>短板</span><b className="warn">{cur.weak}</b></div>
              <div className="so-kv"><span>获客投放</span><b>{cur.adSpend}</b></div>
              <div className="so-note">{cur.note}</div>
            </div>
          )}
        </div>
      </div>

      <div className="so-sec-hd mt">
        <span className="so-sec-t">运营建议（按可抢的缺口排序）</span>
      </div>
      <div className="so-ops">
        {SEED_OPS_ACTIONS.map((a) => (
          <div className={'so-ops-item ' + a.priority} key={a.id}>
            <div className="so-ops-hd">
              <span className="so-ops-t">{a.title}</span>
              <Tag color={a.priority === 'high' ? 'volcano' : a.priority === 'mid' ? 'gold' : 'default'}>
                {a.priority === 'high' ? '优先做' : a.priority === 'mid' ? '可以做' : '机会'}
              </Tag>
            </div>
            <div className="so-ops-basis">依据：{a.basis}</div>
            <ul className="so-ops-list">
              {a.actions.map((x, i) => <li key={i}>{x}</li>)}
            </ul>
            <div className="so-ops-expect">预期：{a.expect}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   页签 3：活动预告（需求 2·薅羊毛）
   ══════════════════════════════════════════════════════════ */
const CAMPAIGN_STATUS = {
  ongoing: { label: '进行中', color: 'green' },
  upcoming: { label: '即将开始', color: 'gold' },
  ended: { label: '已结束', color: 'default' },
};

function CampaignPanel() {
  const [f, setF] = useState('all');
  const list = SEED_CAMPAIGNS.filter((c) => f === 'all' || c.status === f);

  return (
    <div className="so-panel">
      <div className="so-sec-hd">
        <span className="so-sec-t">活动预告</span>
        <SeedTag />
        <div className="so-sec-right">
          <Segmented
            size="small"
            value={f}
            onChange={setF}
            options={[
              { label: '全部', value: 'all' },
              { label: '进行中', value: 'ongoing' },
              { label: '即将开始', value: 'upcoming' },
              { label: '已结束', value: 'ended' },
            ]}
          />
        </div>
      </div>
      <p className="so-lead">能领什么奖品、怎么参与 —— 能薅的别错过。</p>

      <div className="so-camps">
        {list.map((c) => {
          const st = CAMPAIGN_STATUS[c.status];
          return (
            <div className={'so-camp ' + c.status} key={c.id}>
              <div className="so-camp-hd">
                <div>
                  <div className="so-camp-t">{c.title}</div>
                  <div className="so-camp-meta">
                    <span>{c.org}</span>
                    <span className="dot" />
                    <span>{c.period}</span>
                  </div>
                </div>
                <Tag color={st.color}>{st.label}</Tag>
              </div>

              <div className="so-prizes">
                {c.prizes.map((p, i) => (
                  <div className="so-prize" key={i}>
                    <div className="so-prize-v">{p.value}</div>
                    <div className="so-prize-n">{p.name}</div>
                    <div className="so-prize-c">条件：{p.need}</div>
                  </div>
                ))}
              </div>

              <div className="so-how">
                <span className="so-how-t">怎么参与</span>
                <ol>{c.how.map((h, i) => <li key={i}>{h}</li>)}</ol>
              </div>

              <div className="so-camp-ft">
                <span className="so-deadline">截止 {c.deadline}</span>
                <Button
                  type="primary" size="small" disabled={c.status === 'ended'}
                  onClick={() => Modal.info({ title: c.title, content: '报名入口将在接入真实活动系统后开放。' })}
                >
                  {c.status === 'ended' ? '已结束' : '去报名'}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   页签 4：电子病历（需求 6）
   ══════════════════════════════════════════════════════════ */
function ChartPanel() {
  const [pid, setPid] = useState(SEED_PATIENTS[0].id);
  const p = SEED_PATIENTS.find((x) => x.id === pid);

  return (
    <div className="so-panel">
      <div className="so-sec-hd">
        <span className="so-sec-t">AI 电子病历</span>
        <SeedTag />
      </div>
      <p className="so-lead">
        记录病史与牙位，AI 给出<b>辅助判断</b>（仅供参考，需医生复核）。
      </p>

      <div className="so-chart-grid">
        <div className="so-pt-list">
          {SEED_PATIENTS.map((x) => (
            <button
              key={x.id}
              type="button"
              className={'so-pt' + (pid === x.id ? ' on' : '')}
              onClick={() => setPid(x.id)}
            >
              <div className="so-pt-hd">
                <span className="so-pt-n">{x.name}</span>
                <span className="so-pt-a">{x.gender} · {x.age}岁</span>
              </div>
              <div className="so-pt-meta">
                <span>最近 {x.lastVisit}</span>
              </div>
              <div className="so-pt-tags">
                {x.tags.map((t) => <Tag key={t} className="so-tag">{t}</Tag>)}
              </div>
            </button>
          ))}
        </div>

        <div className="so-chart-detail">
          {p && (
            <>
              <div className="so-chart-hd">
                <div>
                  <div className="so-chart-n">{p.name}</div>
                  <div className="so-chart-meta">{p.gender} · {p.age}岁 · {p.phone}</div>
                </div>
                <Button size="small" type="primary">新建就诊记录</Button>
              </div>

              {p.records.map((r) => (
                <div className="so-rec" key={r.id}>
                  <div className="so-rec-hd">
                    <span className="so-rec-date">{r.date}</span>
                    <span className="so-rec-tooth">{r.tooth} {r.toothName}</span>
                    <Tag color="green" className="so-tag">{r.type}</Tag>
                  </div>
                  <div className="so-rec-note">{r.note}</div>
                  {r.attachments.length > 0 && (
                    <div className="so-rec-attach">
                      {r.attachments.map((a) => (
                        <span className="so-attach" key={a}>
                          <LineIcon name="image" size={14} variant="plain" />{a}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="so-rec-ai">
                    <span className="so-ai-tag">
                      <LineIcon name="sparkle" size={13} variant="plain" />AI 辅助
                    </span>
                    <span className="so-ai-text">{r.ai}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   页签 5：危机提醒 / 学习（需求 4、5 的入口）
   ══════════════════════════════════════════════════════════ */
function WatchPanel({ onGoCrisis, onGoLearn }) {
  const items = [
    {
      k: 'crisis', t: '公关危机提醒', d: '小红书 / 美团 / 高德地图差评与舆情监控',
      btn: '去处理', go: onGoCrisis, ic: 'shield',
      extra: '当前平台覆盖：小红书 / 贴吧 / 微博 / 公众号（美团、高德接入中）',
    },
    {
      k: 'learn', t: '牙医课程 · 碎片化学习', d: '每日 10 分钟，学完能用',
      btn: '去学习', go: onGoLearn, ic: 'book',
      extra: '已按牙医/诊所口径折叠课程与推荐',
    },
  ];
  return (
    <div className="so-panel">
      <div className="so-sec-hd"><span className="so-sec-t">监控与学习</span></div>
      <p className="so-lead">这两项已有独立页面，这里只做入口，不重复造。</p>
      <div className="so-watch">
        {items.map((x) => (
          <div className="so-watch-item" key={x.k}>
            <div className="so-watch-ic"><LineIcon name={x.ic} size={22} variant="plain" /></div>
            <div className="so-watch-main">
              <div className="so-watch-t">{x.t}</div>
              <div className="so-watch-d">{x.d}</div>
              <div className="so-watch-x">{x.extra}</div>
            </div>
            <Button size="small" onClick={x.go}>{x.btn}</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   模块外壳
   ══════════════════════════════════════════════════════════ */
const TABS = [
  { key: 'stock', label: '库存补货', ic: 'box' },
  { key: 'near', label: '周边竞品', ic: 'radar' },
  { key: 'camp', label: '活动预告', ic: 'gift' },
  { key: 'chart', label: '电子病历', ic: 'doc' },
  { key: 'watch', label: '危机 · 学习', ic: 'shield' },
];

export default function StoreOps({ onSelectModule }) {
  const [tab, setTab] = useState('stock');

  return (
    <div className="module-page store-ops">
      <div className="page-banner">
        <div className="page-banner-ic" aria-hidden="true">
          <span className="page-banner-ic-halo" />
          <LineIcon name="store" size={38} variant="plain" />
        </div>
        <div className="page-banner-txt">
          <h2 className="page-banner-title">门店运营</h2>
          <div className="page-banner-sub">
            库存自动补货、周边 3 公里竞品、活动薅羊毛、电子病历 —— 诊所每天要办的四件事。
          </div>
        </div>
        <div className="page-banner-slogan" aria-hidden="true">
          <span className="page-banner-slogan-t">把开诊所的琐事，交给豆芽</span>
          <svg className="page-banner-slogan-line" viewBox="0 0 120 10" preserveAspectRatio="none">
            <path d="M2 7 C 30 2, 90 2, 118 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      <div className="so-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={'so-tab' + (tab === t.key ? ' on' : '')}
            onClick={() => setTab(t.key)}
            data-so-tab={t.key}
          >
            <LineIcon name={t.ic} size={16} variant="plain" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'stock' && <StockGuidePanel onSelectModule={onSelectModule} />}
      {tab === 'near' && <NearbyPanel />}
      {tab === 'camp' && <CampaignPanel />}
      {tab === 'chart' && <ChartPanel />}
      {tab === 'watch' && (
        <WatchPanel
          onGoCrisis={() => onSelectModule && onSelectModule('crisis')}
          onGoLearn={() => onSelectModule && onSelectModule('learn')}
        />
      )}
    </div>
  );
}