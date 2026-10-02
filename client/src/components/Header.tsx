import React from 'react';
import { Play, RefreshCw } from 'lucide-react';
import type { BrokerFaultConfig } from '../../../shared/types.js';

interface HeaderProps {
  brokerMode: BrokerFaultConfig['mode'];
  onPollNow: () => void;
  onRefresh: () => void;
  isPolling: boolean;
}

const MODE_LABEL: Record<BrokerFaultConfig['mode'], { text: string; tone: 'ok' | 'warn' | 'bad' }> = {
  HEALTHY: { text: 'healthy', tone: 'ok' },
  PARTIAL_FAILURES: { text: 'partial failures', tone: 'warn' },
  FULL_OUTAGE: { text: 'full outage', tone: 'bad' },
};

export const Header: React.FC<HeaderProps> = ({ brokerMode, onPollNow, onRefresh, isPolling }) => {
  const mode = MODE_LABEL[brokerMode];
  return (
    <header className="app-header">
      <div className="header-inner">
        <div>
          <h1 className="brand-name">OutboxRelay</h1>
          <p className="brand-subtitle">
            Saves each order and its event in one transaction, then relays events to consumers with retries and a dead-letter queue.
          </p>
          <div className="header-meta">
            <span className="badge">v1.0</span>
            <span className="badge">
              <span className={`status-dot ${mode.tone}`} aria-hidden="true" />
              Broker {mode.text}
            </span>
          </div>
        </div>

        <div className="header-actions">
          <button type="button" className="btn btn-secondary" onClick={onRefresh}>
            <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
            Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={onPollNow} disabled={isPolling}>
            <Play size={16} strokeWidth={1.75} aria-hidden="true" />
            {isPolling ? 'Running cycle' : 'Run relay cycle'}
          </button>
        </div>
      </div>
    </header>
  );
};
