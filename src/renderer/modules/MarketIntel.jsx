import React from 'react';
import { Tabs } from 'antd';
import CompetitorAnalysis from './CompetitorAnalysis.jsx';
import PrCrisis from './PrCrisis.jsx';

/**
 * 市场情报（合并容器）：竞品对比 + 公关危机。
 * 都是"盯着外面"——一个盯竞品动作，一个盯舆情口碑，收进一个入口。
 */
export default function MarketIntel({ geoProxy, onSelectModule }) {
  const items = [
    {
      key: 'competitor',
      label: '竞品对比',
      children: <CompetitorAnalysis onSelectModule={onSelectModule} />,
    },
    {
      key: 'crisis',
      label: '公关危机',
      children: <PrCrisis geoProxy={geoProxy} onSelectModule={onSelectModule} />,
    },
  ];

  return (
    <div className="merged-tabs">
      <Tabs defaultActiveKey="competitor" destroyInactiveTabPane={false} items={items} />
    </div>
  );
}
