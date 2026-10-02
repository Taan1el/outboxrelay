import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { BrokerFaultConfig, OutboxStats } from '../../../shared/types.js';
import { formatCount } from '../utils/pluralize.js';

interface HeaderProps {
  stats: OutboxStats | null;
  brokerMode: BrokerFaultConfig['mode'];
  onRefresh: () => void;
}

const MODE_LABEL: Record<BrokerFaultConfig['mode'], { text: string; tone: 'ok' | 'warn' | 'bad' }> = {
  HEALTHY: { text: 'healthy', tone: 'ok' },
  PARTIAL_FAILURES: { text: 'partial failures', tone: 'warn' },
  FULL_OUTAGE: { text: 'full outage', tone: 'bad' },
};

export const Header: React.FC<HeaderProps> = ({ stats, brokerMode, onRefresh }) => {
  const mode = MODE_LABEL[brokerMode];
  const rate = stats ? Math.min(100, Math.max(0, stats.deliverySuccessRate)) : 0;
  return (
    <header className="app-header">
      <div className="masthead">
        <h1 className="brand-name">OutboxRelay</h1>
        <p className="brand-subtitle">
          Saves each order and its event in one transaction, then relays events to consumers with retries and a dead-letter queue.
        </p>
        <div className="masthead-actions">
          <span className="broker-state">
            <span className={`status-dot ${mode.tone}`} aria-hidden="true" />
            {`Broker ${mode.text}`}
          </span>
          <button type="button" className="btn btn-secondary" onClick={onRefresh}>
            <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {stats ? (
        <dl className="tally">
          <div className="tally-row">
            <dt>Delivery success</dt>
            <dd className="tally-value">{`${stats.deliverySuccessRate}%`}</dd>
            <dd className="tally-meter-cell">
              <span className="tally-meter" role="meter" aria-label="Delivery success" aria-valuenow={rate} aria-valuemin={0} aria-valuemax={100}>
                <span className="tally-meter-fill" style={{ width: `${rate}%` }} />
              </span>
            </dd>
            <dd className="tally-note">{`${stats.publishedEvents} published, ${stats.deadLetterEvents} dead-lettered`}</dd>
          </div>
          <div className="tally-row">
            <dt>Orders</dt>
            <dd className="tally-value">{stats.totalOrders}</dd>
            <dd className="tally-note">{formatCount(stats.totalEvents, 'outbox row')}</dd>
          </div>
          <div className="tally-row">
            <dt>Duplicates rejected</dt>
            <dd className="tally-value">{stats.consumerDuplicatesRejected}</dd>
            <dd className="tally-note">{formatCount(stats.consumerProcessed, 'delivery', 'deliveries')}</dd>
          </div>
        </dl>
      ) : (
        <p className="tally-loading">Loading statistics.</p>
      )}
    </header>
  );
};
