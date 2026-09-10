import React, { useState } from 'react';
import type { ConsumerInboxItem } from '../../../shared/types.js';
import { updateBrokerFault } from '../services/api.js';

interface ChaosControlsProps {
  currentMode: 'HEALTHY' | 'PARTIAL_FAILURES' | 'FULL_OUTAGE';
  consumerInbox: ConsumerInboxItem[];
  onConfigChanged: () => void;
}

export const ChaosControls: React.FC<ChaosControlsProps> = ({
  currentMode,
  consumerInbox,
  onConfigChanged,
}) => {
  const [selectedMode, setSelectedMode] = useState<'HEALTHY' | 'PARTIAL_FAILURES' | 'FULL_OUTAGE'>(currentMode);
  const [latencyMs, setLatencyMs] = useState(30);
  const [isUpdating, setIsUpdating] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Group consumer inbox items by consumerId
  const consumers = ['consumer-notifications', 'consumer-inventory', 'consumer-analytics'];
  const consumerStats = consumers.map((cid) => {
    const items = consumerInbox.filter((i) => i.consumerId === cid);
    const duplicates = items.reduce((acc, i) => acc + (i.duplicateDetected ? 1 : 0), 0);
    const lastItem = items[0];
    return {
      consumerId: cid,
      totalProcessed: items.length,
      duplicatesRejected: duplicates,
      lastProcessedAt: lastItem ? lastItem.processedAt : null,
    };
  });

  const handleApply = async () => {
    setIsUpdating(true);
    setSuccessMsg(null);
    try {
      await updateBrokerFault({
        mode: selectedMode,
        simulatedLatencyMs: latencyMs,
      });
      setSuccessMsg(`Broker state set to ${selectedMode}`);
      onConfigChanged();
    } catch (err: any) {
      alert(`Failed to update broker mode: ${err.message}`);
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="chaos-container">
      {/* Broker Chaos Injection Panel */}
      <div className="chaos-card">
        <div className="card-header">
          <span className="section-badge">Fault Injection &amp; Resilience</span>
          <h2 className="card-title">Message Broker Chaos Controls</h2>
          <p className="card-subtitle">
            Simulate network partitions and broker outages to observe automatic row-leasing retries, exponential backoff, and DLQ trapping.
          </p>
        </div>

        <div className="chaos-options-grid">
          <button
            type="button"
            className={`chaos-btn mode-healthy ${selectedMode === 'HEALTHY' ? 'active' : ''}`}
            onClick={() => setSelectedMode('HEALTHY')}
            disabled={isUpdating}
          >
            <span className="mode-icon">🟢</span>
            <strong>HEALTHY</strong>
            <span>0% error rate, standard broker delivery</span>
          </button>

          <button
            type="button"
            className={`chaos-btn mode-partial ${selectedMode === 'PARTIAL_FAILURES' ? 'active' : ''}`}
            onClick={() => setSelectedMode('PARTIAL_FAILURES')}
            disabled={isUpdating}
          >
            <span className="mode-icon">🟡</span>
            <strong>PARTIAL JITTER</strong>
            <span>50% transient timeouts &amp; connection retries</span>
          </button>

          <button
            type="button"
            className={`chaos-btn mode-outage ${selectedMode === 'FULL_OUTAGE' ? 'active' : ''}`}
            onClick={() => setSelectedMode('FULL_OUTAGE')}
            disabled={isUpdating}
          >
            <span className="mode-icon">🔴</span>
            <strong>FULL OUTAGE</strong>
            <span>100% broker down &rarr; triggers DLQ after 3 retries</span>
          </button>
        </div>

        <div className="chaos-latency-row">
          <div className="latency-label-wrap">
            <span className="form-label">Simulated Broker Latency</span>
            <span className="latency-badge">{latencyMs} ms</span>
          </div>
          <input
            type="range"
            min="0"
            max="200"
            step="10"
            value={latencyMs}
            onChange={(e) => setLatencyMs(Number(e.target.value))}
            className="slider-range"
            disabled={isUpdating}
          />
        </div>

        <div className="chaos-action-row">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleApply}
            disabled={isUpdating}
          >
            {isUpdating ? 'Applying...' : 'Apply Fault Configuration'}
          </button>
          {successMsg && <span className="text-emerald">{successMsg}</span>}
        </div>
      </div>

      {/* Downstream Consumer Fleet & Idempotency Visualizer */}
      <div className="consumer-card">
        <div className="card-header">
          <span className="section-badge badge-purple">Idempotent Consumers</span>
          <h2 className="card-title">Downstream Consumer Fleet &amp; Inbox</h2>
          <p className="card-subtitle">
            Downstream services verify event idempotency. Even if broker retries redeliver an event multiple times, exactly-once processing is preserved.
          </p>
        </div>

        <div className="consumer-fleet-grid">
          {consumerStats.map((c) => (
            <div key={c.consumerId} className="consumer-node-card">
              <div className="consumer-node-header">
                <span className="consumer-name">{c.consumerId}</span>
                <span className="badge badge-success">Active</span>
              </div>
              <div className="consumer-node-metrics">
                <div className="c-metric">
                  <span className="c-label">Processed</span>
                  <span className="c-val">{c.totalProcessed}</span>
                </div>
                <div className="c-metric">
                  <span className="c-label">Duplicates Filtered</span>
                  <span className="c-val text-cyan">{c.duplicatesRejected}</span>
                </div>
              </div>
              <div className="c-footer">
                Last: {c.lastProcessedAt ? new Date(c.lastProcessedAt).toLocaleTimeString() : 'Awaiting events'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};