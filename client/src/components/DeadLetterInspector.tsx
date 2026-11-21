import React, { useMemo, useRef, useState } from 'react';
import { Download, FileUp, Inbox } from 'lucide-react';
import type { OutboxEvent } from '../../../shared/types.js';
import {
  DeadLetterParseError,
  MAX_FILE_BYTES,
  fromOutboxEvents,
  groupByError,
  parseDeadLetterFile,
  toReplayCsv,
  toReplayJson,
  type DeadLetterRecord,
} from '../utils/deadLetters.js';
import { downloadText } from '../utils/download.js';
import { formatClock } from '../utils/format.js';
import { formatCount } from '../utils/pluralize.js';

interface DeadLetterInspectorProps {
  events: OutboxEvent[];
}

interface Loaded {
  source: string;
  records: DeadLetterRecord[];
}

const PREVIEW_IDS = 4;

export const DeadLetterInspector: React.FC<DeadLetterInspectorProps> = ({ events }) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const laneRecords = useMemo(() => fromOutboxEvents(events), [events]);
  const groups = useMemo(() => (loaded ? groupByError(loaded.records) : []), [loaded]);
  const chosen = groups.filter((group) => selected.has(group.key)).flatMap((group) => group.records);

  const show = (next: Loaded) => {
    const groupCount = groupByError(next.records).length;
    setLoaded(next);
    setSelected(new Set());
    setError(null);
    setNotice(
      `Loaded ${formatCount(next.records.length, 'event')} in ${formatCount(groupCount, 'error group')} from ${next.source}.`,
    );
  };

  const takeLane = () => {
    show({ source: `the dead-letter lane at ${formatClock(Date.now())}`, records: laneRecords });
  };

  const readFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear the input so choosing the same file again after a fix reads it again.
    e.target.value = '';
    if (!file) return;
    setNotice('');
    if (file.size > MAX_FILE_BYTES) {
      setError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      return;
    }
    try {
      const records = parseDeadLetterFile(file.name, await file.text());
      show({ source: file.name, records });
    } catch (err) {
      setError(err instanceof DeadLetterParseError ? err.message : `${file.name} could not be read.`);
    }
  };

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const exportList = (format: 'json' | 'csv') => {
    if (format === 'json') downloadText('dead-letter-replay.json', toReplayJson(chosen), 'application/json');
    else downloadText('dead-letter-replay.csv', toReplayCsv(chosen), 'text/csv');
    setNotice(`Exported ${formatCount(chosen.length, 'event id')} as ${format.toUpperCase()}.`);
  };

  return (
    <section aria-labelledby="inspector-heading" className="inspector">
      <h2 id="inspector-heading" className="section-heading">
        Inspect dead letters
      </h2>
      <p className="section-description">
        Group dead-lettered events by their last error, pick the failures you have fixed, and export their ids as a replay list. Files are read in this browser and never uploaded.
      </p>

      <div className="inspector-sources">
        <button type="button" className="btn btn-secondary" onClick={takeLane} disabled={laneRecords.length === 0}>
          <Inbox size={16} strokeWidth={1.75} aria-hidden="true" />
          {`Use the dead-letter lane (${laneRecords.length})`}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => fileInput.current?.click()}>
          <FileUp size={16} strokeWidth={1.75} aria-hidden="true" />
          Load a JSON or CSV file
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          aria-label="Dead-letter file"
          hidden
          onChange={(e) => void readFile(e)}
        />
      </div>
      <p className="inspector-format">
        CSV columns: <code>id,type,payload,retry_count,last_error</code>. JSON: an array of objects with those fields, or a saved{' '}
        <code>GET /api/outbox/events?status=DEAD_LETTER</code> response.
      </p>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <output className="form-result">{notice}</output>

      {loaded &&
        (groups.length === 0 ? (
          <p className="empty-note">The dead-letter lane was empty when it was read.</p>
        ) : (
          <>
            <ul className="error-groups" aria-label="Error groups">
              {groups.map((group) => {
                const ids = group.records.map((record) => record.id);
                const attempts =
                  group.minAttempts === group.maxAttempts ? `${group.minAttempts}` : `${group.minAttempts} to ${group.maxAttempts}`;
                return (
                  <li key={group.key} className="error-group">
                    <label className={`check-option${selected.has(group.key) ? ' selected' : ''}`}>
                      <input type="checkbox" checked={selected.has(group.key)} onChange={() => toggle(group.key)} />
                      <span className="error-group-text">
                        <strong className="mono">{group.key}</strong>
                        <small>{`${formatCount(group.records.length, 'event')}, ${group.types.join(', ')}, attempts ${attempts}`}</small>
                      </span>
                      <span className="error-group-count mono">{group.records.length}</span>
                    </label>
                    <p className="error-group-ids mono">
                      {ids.slice(0, PREVIEW_IDS).join(', ')}
                      {ids.length > PREVIEW_IDS ? ` and ${ids.length - PREVIEW_IDS} more` : ''}
                    </p>
                  </li>
                );
              })}
            </ul>

            <div className="inspector-actions">
              <span className="inspector-selection mono">{`${chosen.length} of ${loaded.records.length} selected`}</span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setSelected(new Set(groups.map((group) => group.key)))}
                disabled={selected.size === groups.length}
              >
                Select all groups
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                Clear selection
              </button>
              <button type="button" className="btn btn-primary" onClick={() => exportList('json')} disabled={chosen.length === 0}>
                <Download size={16} strokeWidth={1.75} aria-hidden="true" />
                Export replay list (JSON)
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => exportList('csv')} disabled={chosen.length === 0}>
                Export as CSV
              </button>
            </div>
          </>
        ))}
    </section>
  );
};
