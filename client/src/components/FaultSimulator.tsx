import React, { useEffect, useState } from 'react';
import type { BrokerFaultConfig, OutboxEvent, PollCycleResult, RetryPolicy } from '../../../shared/types.js';
import { RETRY_POLICY_LIMITS, retrySchedule } from '../../../shared/outbox-logic.js';
import { resetRetryPolicy, updateBrokerFault, updateRetryPolicy } from '../services/index.js';
import { formatClock } from '../utils/format.js';

type Mode = BrokerFaultConfig['mode'];

interface FaultSimulatorProps {
  currentMode: Mode;
  lastCycle: PollCycleResult | null;
  retrying: OutboxEvent[];
  retryPolicy: RetryPolicy;
  onConfigChanged: () => void;
}

const POLICY_FIELDS: Array<{ key: keyof RetryPolicy; id: string; label: string }> = [
  { key: 'maxAttempts', id: 'policy-attempts', label: 'Attempt limit' },
  { key: 'backoffBaseMs', id: 'policy-base', label: 'First retry delay (ms)' },
  { key: 'backoffMaxMs', id: 'policy-max', label: 'Longest delay (ms)' },
];

function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/** One sentence describing what happens after each failure under the policy. */
export function describeRetryPolicy(policy: RetryPolicy): string {
  if (policy.maxAttempts === 1) {
    return 'A failed delivery is not retried: the first failure moves the event to the dead-letter queue.';
  }
  const schedule = retrySchedule(policy).map(formatSeconds).join(', ');
  return `A failed delivery is retried after ${schedule} (starting at ${formatSeconds(policy.backoffBaseMs)}, doubling each time, at most ${formatSeconds(policy.backoffMaxMs)}). Failure number ${policy.maxAttempts} moves the event to the dead-letter queue.`;
}

type PolicyDraft = Record<keyof RetryPolicy, string>;

const toDraft = (policy: RetryPolicy): PolicyDraft => ({
  maxAttempts: String(policy.maxAttempts),
  backoffBaseMs: String(policy.backoffBaseMs),
  backoffMaxMs: String(policy.backoffMaxMs),
});

const MODES: Array<{ value: Mode; label: string; detail: string }> = [
  { value: 'HEALTHY', label: 'Healthy', detail: 'Every delivery succeeds.' },
  { value: 'PARTIAL_FAILURES', label: 'Partial failures', detail: 'Half of the deliveries time out.' },
  { value: 'FULL_OUTAGE', label: 'Full outage', detail: 'Every delivery is refused.' },
];

export const FaultSimulator: React.FC<FaultSimulatorProps> = ({ currentMode, lastCycle, retrying, retryPolicy, onConfigChanged }) => {
  const [selectedMode, setSelectedMode] = useState<Mode>(currentMode);
  const [latencyMs, setLatencyMs] = useState(30);
  const [isUpdating, setIsUpdating] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);

  const [policyDraft, setPolicyDraft] = useState<PolicyDraft>(() => toDraft(retryPolicy));
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [policyMessage, setPolicyMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const { maxAttempts, backoffBaseMs, backoffMaxMs } = retryPolicy;

  useEffect(() => {
    setSelectedMode(currentMode);
  }, [currentMode]);

  // Follow the saved policy when it changes (after an apply, a demo reset or another client).
  useEffect(() => {
    setPolicyDraft(toDraft({ maxAttempts, backoffBaseMs, backoffMaxMs }));
  }, [maxAttempts, backoffBaseMs, backoffMaxMs]);

  const handlePolicyApply = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingPolicy(true);
    setPolicyMessage(null);
    try {
      const saved = await updateRetryPolicy({
        maxAttempts: Number(policyDraft.maxAttempts),
        backoffBaseMs: Number(policyDraft.backoffBaseMs),
        backoffMaxMs: Number(policyDraft.backoffMaxMs),
      });
      const attempts = saved.maxAttempts === 1 ? '1 attempt' : `${saved.maxAttempts} attempts`;
      setPolicyMessage({ text: `Retry policy saved: ${attempts} before dead letter. It applies from each event's next failure.`, failed: false });
      onConfigChanged();
    } catch (err) {
      setPolicyMessage({ text: err instanceof Error ? err.message : 'The retry policy could not be changed', failed: true });
    } finally {
      setIsSavingPolicy(false);
    }
  };

  const handlePolicyReset = async () => {
    setIsSavingPolicy(true);
    setPolicyMessage(null);
    try {
      const restored = await resetRetryPolicy();
      const attempts = restored.maxAttempts === 1 ? '1 attempt' : `${restored.maxAttempts} attempts`;
      setPolicyMessage({ text: `Default retry policy restored: ${attempts} before dead letter.`, failed: false });
      onConfigChanged();
    } catch (err) {
      setPolicyMessage({ text: err instanceof Error ? err.message : 'The retry policy could not be reset', failed: true });
    } finally {
      setIsSavingPolicy(false);
    }
  };

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

        <form onSubmit={handlePolicyApply} className="fault-form" aria-labelledby="retry-policy-heading">
          <h3 id="retry-policy-heading" className="panel-heading">
            Retry policy
          </h3>
          <div className="policy-fields">
            {POLICY_FIELDS.map((field) => (
              <div key={field.key} className="field">
                <label className="field-label" htmlFor={field.id}>
                  {field.label}
                </label>
                <input
                  id={field.id}
                  type="number"
                  inputMode="numeric"
                  required
                  min={RETRY_POLICY_LIMITS[field.key].min}
                  max={RETRY_POLICY_LIMITS[field.key].max}
                  step={1}
                  value={policyDraft[field.key]}
                  onChange={(e) => setPolicyDraft((draft) => ({ ...draft, [field.key]: e.target.value }))}
                  disabled={isSavingPolicy}
                />
              </div>
            ))}
          </div>
          <div className="policy-actions">
            <button type="submit" className="btn btn-secondary" disabled={isSavingPolicy}>
              {isSavingPolicy ? 'Saving' : 'Apply retry policy'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={isSavingPolicy} onClick={handlePolicyReset}>
              Use default policy
            </button>
          </div>
          <output className="form-result">
            {policyMessage && <span className={policyMessage.failed ? 'text-bad' : undefined}>{policyMessage.text}</span>}
          </output>
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
            {describeRetryPolicy(retryPolicy)}
          </p>
          {retrying.length === 0 ? (
            <p className="empty-note">No events are waiting for a retry.</p>
          ) : (
            <ul className="dense-list">
              {retrying.map((evt) => (
                <li key={evt.id} className="dense-item">
                  <span className="mono item-title">{evt.id}</span>
                  <span className="item-meta mono">{`${evt.retryCount} of ${maxAttempts} attempts`}</span>
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
