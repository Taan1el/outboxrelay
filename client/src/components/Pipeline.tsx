import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Play, RotateCcw } from 'lucide-react';
import type { OutboxEvent, OutboxEventStatus } from '../../../shared/types.js';
import { MAX_ATTEMPTS } from '../../../shared/outbox-logic.js';
import { retryDeadLetter } from '../services/index.js';
import { formatClock } from '../utils/format.js';
import { formatCount } from '../utils/pluralize.js';

const LANES: Array<{ status: OutboxEventStatus; title: string; hint: string; tone: 'idle' | 'warn' | 'ok' | 'bad' }> = [
  { status: 'PENDING', title: 'Pending', hint: 'waiting for a lease or a retry', tone: 'idle' },
  { status: 'LEASED', title: 'Leased', hint: 'claimed by the relay', tone: 'warn' },
  { status: 'PUBLISHED', title: 'Published', hint: 'delivered to consumers', tone: 'ok' },
  { status: 'DEAD_LETTER', title: 'Dead letter', hint: `failed ${MAX_ATTEMPTS} times, replay to try again`, tone: 'bad' },
];

const VISIBLE_ROWS = 4;

interface PipelineProps {
  events: OutboxEvent[];
  isPolling: boolean;
  onPollNow: () => void;
  onReplayed: () => void;
}

export const Pipeline: React.FC<PipelineProps> = ({ events, isPolling, onPollNow, onReplayed }) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  const handleReplay = async (eventId: string) => {
    setReplayingId(eventId);
    setReplayError(null);
    try {
      await retryDeadLetter(eventId);
      onReplayed();
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : 'The event could not be replayed');
    } finally {
      setReplayingId(null);
    }
  };

  return (
    <section aria-labelledby="pipeline-heading" className="pipeline">
      <h2 id="pipeline-heading" className="section-heading">
        Outbox rows
      </h2>

      <div className="relay-strip">
        <button type="button" className="btn btn-primary relay-btn" onClick={onPollNow} disabled={isPolling}>
          <Play size={16} strokeWidth={1.75} aria-hidden="true" />
          {isPolling ? 'Running cycle' : 'Run relay cycle'}
        </button>
      </div>

      {replayError && <p className="text-bad form-result">{replayError}</p>}

      <div className="lanes">
        {LANES.map((lane) => {
          const rows = events
            .filter((e) => e.status === lane.status)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          const expanded = showAll[lane.status] === true;
          const shown = expanded ? rows : rows.slice(0, VISIBLE_ROWS);
          const headingId = `lane-${lane.status}`;
          return (
            <section key={lane.status} className="lane" aria-labelledby={headingId}>
              <header className="lane-head">
                <h3 id={headingId} className="lane-title">
                  <span className={`status-dot ${lane.tone}`} aria-hidden="true" />
                  {lane.title}
                </h3>
                <p className="lane-count" aria-label={formatCount(rows.length, 'row')}>
                  {rows.length}
                </p>
                <p className="lane-hint">{lane.hint}</p>
              </header>

              {rows.length === 0 ? (
                <p className="empty-note">{`Nothing is ${lane.title.toLowerCase()}.`}</p>
              ) : (
                <ul className="lane-rows">
                  {shown.map((evt) => {
                    const open = expandedId === evt.id;
                    const retryAt = evt.status === 'PENDING' && evt.availableAt ? evt.availableAt : null;
                    return (
                      <li key={evt.id} className="lane-row">
                        <div className="lane-row-main">
                          <span className="mono row-id">{evt.id}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-expanded={open}
                            aria-label={`${open ? 'Hide' : 'Show'} payload for ${evt.id}`}
                            onClick={() => setExpandedId(open ? null : evt.id)}
                          >
                            {open ? <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />}
                          </button>
                        </div>
                        <p className="row-meta mono">{evt.eventType}</p>
                        <p className="row-meta mono">{`${evt.retryCount} of ${MAX_ATTEMPTS} attempts, created ${formatClock(evt.createdAt)}`}</p>
                        {retryAt && <p className="row-meta mono">{`retry at ${formatClock(retryAt)}`}</p>}
                        {evt.status === 'DEAD_LETTER' && (
                          <>
                            <p className="row-meta">{evt.errorMessage ?? 'No error recorded'}</p>
                            <button type="button" className="btn btn-secondary" onClick={() => handleReplay(evt.id)} disabled={replayingId === evt.id}>
                              <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
                              {replayingId === evt.id ? 'Replaying' : 'Replay'}
                              <span className="sr-only">{` ${evt.id}`}</span>
                            </button>
                          </>
                        )}
                        {open && (
                          <div className="detail">
                            {evt.errorMessage && <p className="detail-error">{`Last error: ${evt.errorMessage}`}</p>}
                            <pre className="payload-pre">
                              {JSON.stringify(
                                {
                                  aggregateType: evt.aggregateType,
                                  aggregateId: evt.aggregateId,
                                  payload: evt.payload,
                                  leasedUntil: evt.leasedUntil ? new Date(evt.leasedUntil).toISOString() : null,
                                  publishedAt: evt.publishedAt,
                                },
                                null,
                                2,
                              )}
                            </pre>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {rows.length > VISIBLE_ROWS && (
                <button
                  type="button"
                  className="link-btn lane-more"
                  aria-expanded={expanded}
                  onClick={() => setShowAll((s) => ({ ...s, [lane.status]: !expanded }))}
                >
                  {expanded ? 'Show newest only' : `Show all ${rows.length}`}
                  <span className="sr-only">{` ${lane.title.toLowerCase()} rows`}</span>
                </button>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
};
