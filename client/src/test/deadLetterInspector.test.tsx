import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeadLetterInspector } from '../components/DeadLetterInspector.js';
import { REVOKE_DELAY_MS } from '../utils/download.js';
import { axe } from './axe.js';
import type { OutboxEvent } from '../../../shared/types.js';

const base = {
  aggregateType: 'Order',
  aggregateId: 'ord_a',
  eventType: 'ORDER_CREATED',
  payload: {},
  leasedUntil: null,
  availableAt: null,
  createdAt: '2026-03-01T10:00:00.000Z',
  publishedAt: null,
};

const events: OutboxEvent[] = [
  { ...base, id: 'evt_dead_1', status: 'DEAD_LETTER', retryCount: 3, errorMessage: 'Broker refused connection' },
  { ...base, id: 'evt_dead_2', status: 'DEAD_LETTER', retryCount: 3, errorMessage: 'Broker refused connection' },
  { ...base, id: 'evt_pending', status: 'PENDING', retryCount: 1, errorMessage: 'Timeout' },
];

const csv = [
  'id,type,payload,retry_count,last_error',
  'evt_1,ORDER_CREATED,,3,Broker timeout after 3012 ms',
  'evt_2,ORDER_CREATED,,3,Broker timeout after 2990 ms',
  'evt_3,ORDER_CONFIRMED,,2,"Broker refused, HTTP 503"',
].join('\n');

// jsdom's Blob has no text(); browsers do. Read through FileReader, which jsdom implements.
if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function text(this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

let downloads: Array<{ name: string; text: Promise<string> }>;
let revoked: string[];

beforeEach(() => {
  downloads = [];
  revoked = [];
  let pending: Blob | null = null;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    pending = blob;
    return `blob:test/${downloads.length}`;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, text: pending!.text() });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fileInput(): HTMLInputElement {
  return screen.getByLabelText('Dead-letter file') as HTMLInputElement;
}

describe('DeadLetterInspector', () => {
  it('groups a CSV file by error, largest group first, with nothing selected', async () => {
    const user = userEvent.setup();
    render(<DeadLetterInspector events={events} />);

    await user.upload(fileInput(), new File([csv], 'dead.csv', { type: 'text/csv' }));

    expect(await screen.findByText('Loaded 3 events in 2 error groups from dead.csv.')).toBeInTheDocument();
    const groups = within(screen.getByRole('list', { name: 'Error groups' })).getAllByRole('listitem');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent('Broker timeout after <n> ms');
    expect(groups[0]).toHaveTextContent('2 events, ORDER_CREATED, attempts 3');
    expect(groups[0]).toHaveTextContent('evt_1, evt_2');
    expect(groups[1]).toHaveTextContent('1 event, ORDER_CONFIRMED, attempts 2');
    expect(screen.getByText('0 of 3 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export replay list (JSON)' })).toBeDisabled();
  });

  it('exports only the selected groups as JSON and CSV and revokes the download URL later', async () => {
    const user = userEvent.setup();
    render(<DeadLetterInspector events={events} />);
    await user.upload(fileInput(), new File([csv], 'dead.csv', { type: 'text/csv' }));

    await user.click(await screen.findByRole('checkbox', { name: /Broker timeout after <n> ms/ }));
    expect(screen.getByText('2 of 3 selected')).toBeInTheDocument();

    // user-event waits on timers itself, so the click under fake timers goes through fireEvent.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    fireEvent.click(screen.getByRole('button', { name: 'Export replay list (JSON)' }));
    expect(downloads[0].name).toBe('dead-letter-replay.json');
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(REVOKE_DELAY_MS - 1);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(['blob:test/0']);
    vi.useRealTimers();
    expect(JSON.parse(await downloads[0].text)).toEqual(['evt_1', 'evt_2']);
    expect(screen.getByText('Exported 2 event ids as JSON.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Export as CSV' }));
    expect(downloads[1].name).toBe('dead-letter-replay.csv');
    const written = await downloads[1].text;
    expect(written).toContain('evt_1,ORDER_CREATED,,3,Broker timeout after 3012 ms');
    expect(written).not.toContain('evt_3');
  });

  it('selects all groups and clears the selection', async () => {
    const user = userEvent.setup();
    render(<DeadLetterInspector events={events} />);
    await user.upload(fileInput(), new File([csv], 'dead.csv', { type: 'text/csv' }));

    await user.click(await screen.findByRole('button', { name: 'Select all groups' }));
    expect(screen.getByText('3 of 3 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select all groups' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByText('0 of 3 selected')).toBeInTheDocument();
  });

  it('reads the dead-letter lane without the events that are still retrying', async () => {
    const user = userEvent.setup();
    render(<DeadLetterInspector events={events} />);

    await user.click(screen.getByRole('button', { name: 'Use the dead-letter lane (2)' }));

    expect(screen.getByText(/^Loaded 2 events in 1 error group from the dead-letter lane at \d\d:\d\d:\d\d\.$/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Broker refused connection/ })).toBeInTheDocument();
    expect(screen.queryByText(/evt_pending/)).not.toBeInTheDocument();
  });

  it('disables the lane button when the lane is empty', () => {
    render(<DeadLetterInspector events={events.filter((e) => e.status !== 'DEAD_LETTER')} />);
    expect(screen.getByRole('button', { name: 'Use the dead-letter lane (0)' })).toBeDisabled();
  });

  it('shows the parse error and keeps the previous groups', async () => {
    const user = userEvent.setup();
    render(<DeadLetterInspector events={events} />);
    await user.upload(fileInput(), new File([csv], 'dead.csv', { type: 'text/csv' }));
    await screen.findByText('Loaded 3 events in 2 error groups from dead.csv.');

    await user.upload(fileInput(), new File(['id,type\nevt_1,T'], 'broken.csv', { type: 'text/csv' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'broken.csv, row 1: missing columns payload, retry_count, last_error. Expected id,type,payload,retry_count,last_error.',
    );
    expect(within(screen.getByRole('list', { name: 'Error groups' })).getAllByRole('listitem')).toHaveLength(2);
  });

  it('refuses a file over the size limit before reading it', async () => {
    const user = userEvent.setup();
    render(<DeadLetterInspector events={events} />);
    const big = new File(['x'], 'huge.json', { type: 'application/json' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    const read = vi.spyOn(big, 'text');

    await user.upload(fileInput(), big);

    expect(await screen.findByRole('alert')).toHaveTextContent('huge.json is 6.0 MB; the limit is 5 MB.');
    expect(read).not.toHaveBeenCalled();
  });

  it('has no accessibility violations with groups loaded and one selected', async () => {
    const user = userEvent.setup();
    const { container } = render(<DeadLetterInspector events={events} />);
    await user.upload(fileInput(), new File([csv], 'dead.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('checkbox', { name: /HTTP 503/ }));

    expect(await axe(container)).toHaveNoViolations();
  });
});
