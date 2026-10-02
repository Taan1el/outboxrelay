import React, { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { OutboxEvent } from '../../../shared/types.js';
import { MAX_ATTEMPTS } from '../../../shared/outbox-logic.js';
import { retryDeadLetter } from '../services/index.js';

interface DeadLetterQueueProps {
  events: OutboxEvent[];
  onReplayed: () => void;
}

export const DeadLetterQueue: React.FC<DeadLetterQueueProps> = ({ events, onReplayed }) => {
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleReplay = async (eventId: string) => {
    setReplayingId(eventId);
    setError(null);
    try {
      await retryDeadLetter(eventId);
      onReplayed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The event could not be replayed');
    } finally {
      setReplayingId(null);
    }
  };

  return (
    <section aria-labelledby="dlq-heading">
      <h2 id="dlq-heading" className="section-heading">
        Dead-letter queue
      </h2>
      <p className="section-description">
        {`Events that failed ${MAX_ATTEMPTS} times. Replaying one resets its attempts and queues it again.`}
      </p>
      {error && <p className="text-bad form-result">{error}</p>}
      {events.length === 0 ? (
        <p className="empty-note">The dead-letter queue is empty.</p>
      ) : (
        <ul className="dense-list">
          {events.map((evt) => (
            <li key={evt.id} className="dense-item dlq-item">
              <div className="dlq-text">
                <span className="mono item-title">{evt.id}</span>
                <span className="item-meta">{evt.errorMessage ?? 'No error recorded'}</span>
              </div>
              <span className="item-meta mono">{`${evt.retryCount} of ${MAX_ATTEMPTS} attempts`}</span>
              <button type="button" className="btn btn-secondary" onClick={() => handleReplay(evt.id)} disabled={replayingId === evt.id}>
                <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
                {replayingId === evt.id ? 'Replaying' : 'Replay'}
                <span className="sr-only">{` ${evt.id}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
