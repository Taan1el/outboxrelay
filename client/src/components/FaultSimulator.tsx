import React, { useEffect, useState } from 'react';
import type { BrokerFaultConfig, OutboxEvent, PollCycleResult } from '../../../shared/types.js';
import { BACKOFF_BASE_MS, MAX_ATTEMPTS, backoffDelayMs } from '../../../shared/outbox-logic.js';
import { updateBrokerFault } from '../services/index.js';
import { formatClock } from '../utils/format.js';

type Mode = BrokerFaultConfig['mode'];

interface FaultSimulatorProps {
  currentMode: Mode;
  lastCycle: PollCycleResult | null;
  retrying: OutboxEvent[];
  onConfigChanged: () => void;
}

const MODES: Array<{ value: Mode; label: string; detail: string }> = [
  { value: 'HEALTHY', label: 'Healthy', detail: 'Every delivery succeeds.' },
  { value: 'PARTIAL_FAILURES', label: 'Partial failures', detail: 'Half of the deliveries time out.' },
  { value: 'FULL_OUTAGE', label: 'Full outage', detail: 'Every delivery is refused.' },
];

export const FaultSimulator: React.FC<FaultSimulatorProps> = ({ currentMode, lastCycle, retrying, onConfigChanged }) => {
  const [selectedMode, setSelectedMode] = useState<Mode>(currentMode);
  const [latencyMs, setLatencyMs] = useState(30);
  const [isUpdating, setIsUpdating] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);

  useEffect(() => {
    setSelectedMode(currentMode);
  }, [currentMode]);

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdating(true);
    setMessage(null);
    try {
      await updateBrokerFault({ mode: selectedMode, simulatedLatencyMs: latencyMs });
      setMessage({ text: `Broker set to ${MODES.find((m) => m.value === selectedMode)?.label.toLowerCase()}.`, failed: false });
      onConfigChanged();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'The broker setting could not be changed', failed: true });
    } finally {
      setIsUpdating(false);
    }
  };

  const schedule = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => `${backoffDelayMs(i + 1) / 1000} s`).join(', ');

  return (
    <section aria-labelledby="faults-heading">
      <h2 id="faults-heading" className="section-heading">
        Fault simulator
      </h2>
      <div className="fault-layout">
        <form onSubmit={handleApply} className="fault-form">
          <fieldset className="radio-set">
            <legend className="field-label">Broker state</legend>
            {MODES.map((m) => (
              <label key={m.value} className={`radio-option${selectedMode === m.value ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="broker-mode"
                  value={m.value}
                  checked={selectedMode === m.value}
                  onChange={() => setSelectedMode(m.value)}
                  disabled={isUpdating}
                />
                <span>
                  <strong>{m.label}</strong>
                  <small>{m.detail}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="field">
            <div className="field-row">
              <label className="field-label" htmlFor="broker-latency">
                Delivery latency
              </label>
              <span className="field-value">{`${latencyMs} ms`}</span>
            </div>
            <input
              id="broker-latency"
              type="range"
              min={0}
              max={200}
              step={10}
              value={latencyMs}
              onChange={(e) => setLatencyMs(Number(e.target.value))}
              disabled={isUpdating}
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={isUpdating}>
            {isUpdating ? 'Applying' : 'Apply broker settings'}
          </button>
          <output className="form-result">{message && <span className={message.failed ? 'text-bad' : undefined}>{message.text}</span>}</output>
        </form>

        <div className="fault-results">
          <h3 className="panel-heading">Last relay cycle</h3>
          {lastCycle ? (
            <dl className="result-list">
              <div>
                <dt>Leased</dt>
                <dd>{lastCycle.leasedCount}</dd>
              </div>
              <div>
                <dt>Published</dt>
                <dd>{lastCycle.dispatchedCount}</dd>
              </div>
              <div>
                <dt>Failed</dt>
                <dd>{lastCycle.failedCount}</dd>
              </div>
              <div>
                <dt>Dead-lettered</dt>
                <dd>{lastCycle.deadLetterCount}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{`${lastCycle.durationMs} ms`}</dd>
              </div>
            </dl>
          ) : (
            <p className="empty-note">No cycle run from this page yet. Use Run relay cycle.</p>
          )}

          <h3 className="panel-heading">Waiting for retry</h3>
          <p className="section-description">
            {`A failed delivery is retried after ${schedule} (starting at ${BACKOFF_BASE_MS / 1000} s, doubling each time). Failure number ${MAX_ATTEMPTS} moves the event to the dead-letter queue.`}
          </p>
          {retrying.length === 0 ? (
            <p className="empty-note">No events are waiting for a retry.</p>
          ) : (
            <ul className="dense-list">
              {retrying.map((evt) => (
                <li key={evt.id} className="dense-item">
                  <span className="mono item-title">{evt.id}</span>
                  <span className="item-meta mono">{`${evt.retryCount} of ${MAX_ATTEMPTS} attempts`}</span>
                  <span className="item-meta mono">{evt.availableAt ? `retry at ${formatClock(evt.availableAt)}` : 'due now'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
};
