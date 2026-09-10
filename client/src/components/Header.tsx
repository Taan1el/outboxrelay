import React from 'react';

interface HeaderProps {
  brokerMode: 'HEALTHY' | 'PARTIAL_FAILURES' | 'FULL_OUTAGE';
  pendingCount: number;
  onPollNow: () => void;
  isPolling: boolean;
}

export const Header: React.FC<HeaderProps> = ({ brokerMode, pendingCount, onPollNow, isPolling }) => {
  return (
    <header className="app-header">
      <div className="header-brand">
        <div className="brand-logo">
          <span className="brand-icon">📦</span>
          <div className="pulse-ring"></div>
        </div>
        <div className="brand-titles">
          <div className="brand-row">
            <h1 className="brand-name">OutboxRelay</h1>
            <span className="badge badge-version">v1.0</span>
            <span className={`badge badge-broker ${brokerMode.toLowerCase()}`}>
              Broker: {brokerMode.replace('_', ' ')}
            </span>
          </div>
          <p className="brand-subtitle">
            Transactional Outbox Pattern, Atomicity Dual-Write Engine & Exactly-Once Event Broker
          </p>
        </div>
      </div>

      <div className="header-actions">
        <div className="live-pill">
          <span className={`live-dot ${pendingCount > 0 ? 'pulse-amber' : ''}`}></span>
          <span>{pendingCount} outbox queued</span>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={onPollNow}
          disabled={isPolling}
          title="Manually trigger relay poller"
        >
          {isPolling ? 'Relaying...' : '⚡ Poll & Relay Now'}
        </button>
      </div>
    </header>
  );
};