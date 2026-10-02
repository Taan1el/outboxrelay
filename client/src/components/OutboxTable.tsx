import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { OutboxEvent, OutboxEventStatus } from '../../../shared/types.js';
import { MAX_ATTEMPTS } from '../../../shared/outbox-logic.js';
import { formatClock } from '../utils/format.js';
import { formatCount } from '../utils/pluralize.js';

export type StatusFilter = 'ALL' | OutboxEventStatus;

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'LEASED', label: 'Leased' },
  { value: 'PUBLISHED', label: 'Published' },
  { value: 'DEAD_LETTER', label: 'Dead letter' },
];

const STATUS: Record<OutboxEventStatus, { text: string; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = {
  PENDING: { text: 'Pending', tone: 'idle' },
  LEASED: { text: 'Leased', tone: 'warn' },
  PUBLISHED: { text: 'Published', tone: 'ok' },
  DEAD_LETTER: { text: 'Dead letter', tone: 'bad' },
};

interface OutboxTableProps {
  events: OutboxEvent[];
  activeFilter: StatusFilter;
  onFilterChange: (filter: StatusFilter) => void;
}

export const OutboxTable: React.FC<OutboxTableProps> = ({ events, activeFilter, onFilterChange }) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const visible = activeFilter === 'ALL' ? events : events.filter((e) => e.status === activeFilter);

  return (
    <section aria-labelledby="outbox-heading">
      <div className="section-head">
        <h2 id="outbox-heading" className="section-heading">
          Outbox rows
        </h2>
        <fieldset className="filter-set">
          <legend className="sr-only">Filter by status</legend>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`filter-btn${activeFilter === f.value ? ' active' : ''}`}
              aria-pressed={activeFilter === f.value}
              onClick={() => onFilterChange(f.value)}
            >
              {f.label}
            </button>
          ))}
        </fieldset>
      </div>

      {visible.length === 0 ? (
        <p className="empty-note">No outbox rows with this status.</p>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <caption className="sr-only">{formatCount(visible.length, 'outbox row')}</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Event</th>
                <th scope="col">Row</th>
                <th scope="col">Attempts</th>
                <th scope="col">Created</th>
                <th scope="col">
                  <span className="sr-only">Payload</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((evt) => {
                const status = STATUS[evt.status];
                const open = expandedId === evt.id;
                const retryAt = evt.status === 'PENDING' && evt.availableAt ? evt.availableAt : null;
                return (
                  <React.Fragment key={evt.id}>
                    <tr>
                      <td>
                        <span className="status-text">
                          <span className={`status-dot ${status.tone}`} aria-hidden="true" />
                          {status.text}
                        </span>
                        {retryAt && <span className="cell-note">{`retry at ${formatClock(retryAt)}`}</span>}
                      </td>
                      <td className="mono">{evt.eventType}</td>
                      <td className="mono">{evt.id}</td>
                      <td className="mono">{`${evt.retryCount} of ${MAX_ATTEMPTS}`}</td>
                      <td className="mono">{formatClock(evt.createdAt)}</td>
                      <td className="cell-action">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-expanded={open}
                          aria-label={`${open ? 'Hide' : 'Show'} payload for ${evt.id}`}
                          onClick={() => setExpandedId(open ? null : evt.id)}
                        >
                          {open ? <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="detail-row">
                        <td colSpan={6}>
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
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
