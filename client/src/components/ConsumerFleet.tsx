import React from 'react';
import type { ConsumerStats } from '../../../shared/types.js';
import { formatClock } from '../utils/format.js';
import { formatCount } from '../utils/pluralize.js';

interface ConsumerFleetProps {
  consumers: ConsumerStats[];
}

export const ConsumerFleet: React.FC<ConsumerFleetProps> = ({ consumers }) => (
  <section aria-labelledby="consumers-heading">
    <h2 id="consumers-heading" className="section-heading">
      Consumers
    </h2>
    <p className="section-description">
      Each consumer records an event id once; a repeated delivery is counted and ignored.
    </p>
    {consumers.length === 0 ? (
      <p className="empty-note">No consumer data yet.</p>
    ) : (
      <ul className="dense-list">
        {consumers.map((c) => (
          <li key={c.consumerId} className="dense-item">
            <span className="mono item-title">{c.consumerId}</span>
            <span className="item-meta mono">{formatCount(c.processed, 'event')}</span>
            <span className="item-meta mono">{`${c.duplicatesRejected} duplicates rejected`}</span>
            <span className="item-meta mono">{c.lastProcessedAt ? `last ${formatClock(c.lastProcessedAt)}` : 'no deliveries yet'}</span>
          </li>
        ))}
      </ul>
    )}
  </section>
);
