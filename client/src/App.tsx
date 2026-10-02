import React, { useState, useEffect, useCallback } from 'react';
import type { OutboxStats, Order, OutboxEvent, PollCycleResult } from '../../shared/types.js';
import { fetchStats, fetchOrders, fetchOutboxEvents, triggerPoll } from './services/index.js';
import { DemoBanner } from './components/DemoBanner.js';
import { Header } from './components/Header.js';
import { Pipeline } from './components/Pipeline.js';
import { OrdersPanel } from './components/OrdersPanel.js';
import { ConsumerFleet } from './components/ConsumerFleet.js';
import { FaultSimulator } from './components/FaultSimulator.js';
import './App.css';

export const REFRESH_INTERVAL_MS = 2500;

export const App: React.FC = () => {
  const [stats, setStats] = useState<OutboxStats | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [events, setEvents] = useState<OutboxEvent[]>([]);
  const [lastCycle, setLastCycle] = useState<PollCycleResult | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [statsData, ordersData, eventsData] = await Promise.all([
        fetchStats(),
        fetchOrders(),
        fetchOutboxEvents('ALL'),
      ]);
      setStats(statsData);
      setOrders(ordersData);
      setEvents(eventsData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    }
  }, []);

  useEffect(() => {
    void loadData();
    const timer = setInterval(() => void loadData(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadData]);

  const handleManualPoll = async () => {
    setIsPolling(true);
    setPollError(null);
    try {
      setLastCycle(await triggerPoll());
      await loadData();
    } catch (err) {
      setPollError(`Relay cycle failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setIsPolling(false);
    }
  };

  const retrying = events.filter((e) => e.status === 'PENDING' && e.retryCount > 0);

  return (
    <div className="app-container">
      <DemoBanner onReset={() => void loadData()} />
      <Header stats={stats} brokerMode={stats?.brokerMode ?? 'HEALTHY'} onRefresh={() => void loadData()} />

      <main className="app-main">
        {(error || pollError) && (
          <div className="alert" role="alert">
            <span>{error ?? pollError}</span>
            {error && (
              <button type="button" className="btn btn-secondary" onClick={() => void loadData()}>
                Retry
              </button>
            )}
          </div>
        )}

        <Pipeline events={events} isPolling={isPolling} onPollNow={handleManualPoll} onReplayed={() => void loadData()} />

        <div className="below">
          <div className="below-col">
            <OrdersPanel orders={orders} onOrderCreated={() => void loadData()} />
            <ConsumerFleet consumers={stats?.consumers ?? []} />
          </div>
          <FaultSimulator
            currentMode={stats?.brokerMode ?? 'HEALTHY'}
            lastCycle={lastCycle}
            retrying={retrying}
            onConfigChanged={() => void loadData()}
          />
        </div>
      </main>

      <footer className="app-footer">
        <span>Delivery is at-least-once: a lease that expires mid-delivery can send an event twice, and consumers ignore repeats.</span>
        <span>MIT licensed</span>
      </footer>
    </div>
  );
};

export default App;
