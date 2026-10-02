import React from 'react';
import type { OutboxStats } from '../../../shared/types.js';
import { formatCount } from '../utils/pluralize.js';

interface StatsBarProps {
  stats: OutboxStats | null;
}

export const StatsBar: React.FC<StatsBarProps> = ({ stats }) => {
  if (!stats) {
    return <div className="stats-strip-loading">Loading statistics.</div>;
  }

  const rate = Math.min(100, Math.max(0, stats.deliverySuccessRate));

  return (
    <div className="stats-strip">
      <div className="stat-cell">
        <span className="stat-label">Delivery success</span>
        <span className="stat-value">{`${stats.deliverySuccessRate}%`}</span>
        <div className="stat-meter" role="meter" aria-label="Delivery success" aria-valuenow={rate} aria-valuemin={0} aria-valuemax={100}>
          <div className="stat-meter-fill" style={{ width: `${rate}%` }} />
        </div>
        <span className="stat-note">{`${stats.publishedEvents} published, ${stats.deadLetterEvents} dead-lettered`}</span>
      </div>

      <div className="stat-cell">
        <span className="stat-label">Waiting</span>
        <span className="stat-value">{stats.pendingEvents}</span>
        <span className="stat-note">{`${stats.leasedEvents} leased`}</span>
      </div>

      <div className="stat-cell">
        <span className="stat-label">Orders</span>
        <span className="stat-value">{stats.totalOrders}</span>
        <span className="stat-note">{formatCount(stats.totalEvents, 'outbox row')}</span>
      </div>

      <div className="stat-cell">
        <span className="stat-label">Dead-lettered</span>
        <span className="stat-value">{stats.deadLetterEvents}</span>
        <span className="stat-note">replay from the queue</span>
      </div>

      <div className="stat-cell">
        <span className="stat-label">Duplicates rejected</span>
        <span className="stat-value">{stats.consumerDuplicatesRejected}</span>
        <span className="stat-note">{formatCount(stats.consumerProcessed, 'delivery', 'deliveries')}</span>
      </div>
    </div>
  );
};
