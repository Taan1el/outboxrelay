import React, { useState } from 'react';
import type { OutboxEvent } from '../../../shared/types.js';
import { retryDeadLetter } from '../services/api.js';

interface OutboxEventFeedProps {
  events: OutboxEvent[];
  activeFilter: string;
  onFilterChange: (filter: string) => void;
  onEventRetried: () => void;
}

export const OutboxEventFeed: React.FC<OutboxEventFeedProps> = ({
  events,
  activeFilter,
  onFilterChange,
  onEventRetried,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const handleRetry = async (e: React.MouseEvent, eventId: string) => {
    e.stopPropagation();
    setRetryingId(eventId);
    try {
      await retryDeadLetter(eventId);
      onEventRetried();
    } catch (err: any) {
      alert(`Retry failed: ${err.message}`);
    } finally {
      setRetryingId(null);
    }
  };

  const filters = ['ALL', 'PENDING', 'LEASED', 'PUBLISHED', 'DEAD_LETTER'];

  return (
    <div className="feed-card">
      <div className="feed-header">
        <div className="feed-title-row">
          <h2 className="card-title">Transactional Outbox Event Stream ({events.length})</h2>
          <div className="filter-pill-group">
            {filters.map((f) => (
              <button
                key={f}
                className={`filter-pill ${activeFilter === f ? 'active' : ''}`}
                onClick={() => onFilterChange(f)}
              >
                {f.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="empty-feed">
          <span className="empty-icon">📭</span>
          <h3>No Outbox Events Found</h3>
          <p>No events match filter &ldquo;{activeFilter}&rdquo;. Commit a new order above to queue an outbox event.</p>
        </div>
      ) : (
        <div className="events-list">
          {events.map((evt) => {
            const isExpanded = expandedId === evt.id;
            const isDeadLetter = evt.status === 'DEAD_LETTER';

            return (
              <div
                key={evt.id}
                className={`event-item status-${evt.status.toLowerCase()} ${isExpanded ? 'expanded' : ''}`}
                onClick={() => setExpandedId(isExpanded ? null : evt.id)}
              >
                <div className="event-item-top">
                  <div className="event-ident">
                    <span className={`status-pill pill-${evt.status.toLowerCase()}`}>
                      {evt.status === 'PUBLISHED' && '✓ '}
                      {evt.status === 'PENDING' && '⏳ '}
                      {evt.status === 'LEASED' && '🔒 '}
                      {evt.status === 'DEAD_LETTER' && '☠️ '}
                      {evt.status.replace('_', ' ')}
                    </span>
                    <span className="event-type-name">{evt.eventType}</span>
                    <span className="event-id-tag"><code>{evt.id}</code></span>
                  </div>

                  <div className="event-meta-right">
                    <span className="retry-badge">
                      Attempts: {evt.retryCount}/3
                    </span>
                    <span className="timestamp-tag">
                      {new Date(evt.createdAt).toLocaleTimeString()}
                    </span>
                    {isDeadLetter && (
                      <button
                        className="btn btn-danger btn-xs"
                        onClick={(e) => handleRetry(e, evt.id)}
                        disabled={retryingId === evt.id}
                      >
                        {retryingId === evt.id ? 'Retrying...' : '🔁 Replay DLQ'}
                      </button>
                    )}
                  </div>
                </div>

                {evt.errorMessage && (
                  <div className="error-trace-banner">
                    ⚠️ <strong>Error:</strong> {evt.errorMessage}
                  </div>
                )}

                {isExpanded && (
                  <div className="event-payload-box" onClick={(e) => e.stopPropagation()}>
                    <div className="payload-header">Event Envelope &amp; Payload:</div>
                    <pre className="payload-pre">
                      {JSON.stringify(
                        {
                          id: evt.id,
                          aggregateType: evt.aggregateType,
                          aggregateId: evt.aggregateId,
                          eventType: evt.eventType,
                          payload: evt.payload,
                          leasedUntil: evt.leasedUntil ? new Date(evt.leasedUntil).toISOString() : null,
                          publishedAt: evt.publishedAt,
                        },
                        null,
                        2
                      )}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};