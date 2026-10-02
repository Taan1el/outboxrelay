import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pipeline } from '../components/Pipeline.js';
import type { OutboxEvent } from '../../../shared/types.js';

const published = (n: number): OutboxEvent => ({
  id: `evt_${n}`,
  aggregateType: 'Order',
  aggregateId: `ord_${n}`,
  eventType: 'ORDER_CONFIRMED',
  payload: {},
  status: 'PUBLISHED',
  retryCount: 0,
  leasedUntil: null,
  availableAt: null,
  createdAt: new Date(Date.UTC(2026, 2, 1, 10, 0, n)).toISOString(),
  publishedAt: null,
  errorMessage: null,
});

describe('Pipeline lanes', () => {
  it('lists the newest rows first and expands the rest on demand', async () => {
    const user = userEvent.setup();
    const events = [1, 2, 3, 4, 5, 6].map(published);
    render(<Pipeline events={events} isPolling={false} onPollNow={() => {}} onReplayed={() => {}} />);
    const lane = screen.getByRole('heading', { name: 'Published' }).closest('section')!;
    expect(within(lane).getByLabelText('6 rows')).toBeInTheDocument();
    expect(within(lane).getAllByRole('listitem')).toHaveLength(4);
    expect(within(lane).getAllByRole('listitem')[0]).toHaveTextContent('evt_6');
    await user.click(within(lane).getByRole('button', { name: /Show all 6/ }));
    expect(within(lane).getAllByRole('listitem')).toHaveLength(6);
    await user.click(within(lane).getByRole('button', { name: /Show newest only/ }));
    expect(within(lane).getAllByRole('listitem')).toHaveLength(4);
  });

  it('disables the relay button while a cycle runs', () => {
    render(<Pipeline events={[]} isPolling onPollNow={() => {}} onReplayed={() => {}} />);
    expect(screen.getByRole('button', { name: 'Running cycle' })).toBeDisabled();
  });
});
