import React from 'react';
import type { OutboxStats } from '../../../shared/types.js';

interface StatsBarProps {
  stats: OutboxStats | null;
}

export const StatsBar: React.FC<StatsBarProps> = ({ stats }) => {
  if (!stats) {
    return <div className="stats-bar-skeleton">Loading broker telemetry...</div>;
  }

  return (
    <div className="stats-bar-grid">
      <div className="stat-card stat-success-rate">
        <div className="stat-header">
          <span className="stat-label">Delivery Success Rate</span>
          <span className="stat-icon">🎯</span>
        </div>
        <div className="stat-value-large">
          {stats.deliverySuccessRate}%
        </div>
        <div className="stat-progress-container">
          <div
            className="stat-progress-bar success-progress"
            style={{ width: `${Math.min(100, stats.deliverySuccessRate)}%` }}
          ></div>
        </div>
        <div className="stat-subtext">
          {stats.publishedEvents} published / {stats.deadLetterEvents} dead-lettered
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-header">
          <span className="stat-label">Pending Outbox Queue</span>
          <span className="stat-icon">⏳</span>
        </div>
        <div className="stat-value">
          {stats.pendingEvents} <span className="stat-dim">pending</span>
        </div>
        <div className="stat-subtext">
          {stats.leasedEvents} leased in-flight
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-header">
          <span className="stat-label">Orders (Dual-Writes)</span>
          <span className="stat-icon">🛒</span>
        </div>
        <div className="stat-value">
          {stats.totalOrders}
        </div>
        <div className="stat-subtext">
          100% ACID atomic commits
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-header">
          <span className="stat-label">Dead-Letter Queue</span>
          <span className="stat-icon">☠️</span>
        </div>
        <div className={`stat-value ${stats.deadLetterEvents > 0 ? 'text-rose' : ''}`}>
          {stats.deadLetterEvents}
        </div>
        <div className="stat-subtext">
          Requires manual triage / retry
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-header">
          <span className="stat-label">Consumer Deduplication</span>
          <span className="stat-icon">🛡️</span>
        </div>
        <div className="stat-value text-cyan">
          {stats.consumerDuplicatesRejected}
        </div>
        <div className="stat-subtext">
          {stats.consumerProcessed} valid consumer dispatches
        </div>
      </div>
    </div>
  );
};