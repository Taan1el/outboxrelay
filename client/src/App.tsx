import React, { useState, useEffect, useCallback } from 'react';
import type { OutboxStats, Order, OutboxEvent, ConsumerInboxItem } from '../../shared/types.js';
import {
  fetchStats,
  fetchOrders,
  fetchOutboxEvents,
  fetchConsumerInbox,
  triggerPoll,
} from './services/api.js';
import { Header } from './components/Header.js';
import { StatsBar } from './components/StatsBar.js';
import { CheckoutSimulator } from './components/CheckoutSimulator.js';
import { OutboxEventFeed } from './components/OutboxEventFeed.js';
import { ChaosControls } from './components/ChaosControls.js';
import './App.css';

export const App: React.FC = () => {
  const [stats, setStats] = useState<OutboxStats | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [events, setEvents] = useState<OutboxEvent[]>([]);
  const [consumerInbox, setConsumerInbox] = useState<ConsumerInboxItem[]>([]);
  const [activeFilter, setActiveFilter] = useState<string>('ALL');
  const [isPolling, setIsPolling] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [statsData, ordersData, eventsData, inboxData] = await Promise.all([
        fetchStats(),
        fetchOrders(),
        fetchOutboxEvents(activeFilter),
        fetchConsumerInbox(),
      ]);
      setStats(statsData);
      setOrders(ordersData);
      setEvents(eventsData);
      setConsumerInbox(inboxData);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load telemetry data');
    }
  }, [activeFilter]);

  useEffect(() => {
    loadData();
    const timer = setInterval(() => {
      loadData();
    }, 2500);
    return () => clearInterval(timer);
  }, [loadData]);

  const handleManualPoll = async () => {
    setIsPolling(true);
    try {
      await triggerPoll();
      await loadData();
    } catch (err: any) {
      alert(`Poller execution failed: ${err.message}`);
    } finally {
      setIsPolling(false);
    }
  };

  return (
    <div className="app-container">
      <Header
        brokerMode={stats?.brokerMode || 'HEALTHY'}
        pendingCount={stats?.pendingEvents || 0}
        onPollNow={handleManualPoll}
        isPolling={isPolling}
      />

      <main className="app-main">
        {error && (
          <div className="alert alert-error global-alert">
            <span>⚠️ {error}</span>
            <button className="btn btn-secondary btn-xs" onClick={() => loadData()}>
              Retry
            </button>
          </div>
        )}

        <StatsBar stats={stats} />

        <div className="main-content-layout">
          <div className="layout-left">
            <CheckoutSimulator orders={orders} onOrderCreated={loadData} />
            <ChaosControls
              currentMode={stats?.brokerMode || 'HEALTHY'}
              consumerInbox={consumerInbox}
              onConfigChanged={loadData}
            />
          </div>

          <div className="layout-right">
            <OutboxEventFeed
              events={events}
              activeFilter={activeFilter}
              onFilterChange={(filter) => setActiveFilter(filter)}
              onEventRetried={loadData}
            />
          </div>
        </div>
      </main>

      <footer className="app-footer">
        <div>
          <strong>OutboxRelay</strong> &bull; Production Transactional Outbox Pattern &amp; Reliable Event Broker
        </div>
        <div className="footer-links">
          <span>Node.js 24 Native SQLite WAL</span>
          <span>&bull;</span>
          <span>Dual-Write Atomicity</span>
          <span>&bull;</span>
          <span>Row-Leasing Poller</span>
        </div>
      </footer>
    </div>
  );
};

export default App;