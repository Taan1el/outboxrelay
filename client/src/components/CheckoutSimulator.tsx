import React, { useState } from 'react';
import type { Order, OutboxEvent } from '../../../shared/types.js';
import { createOrder } from '../services/api.js';

interface CheckoutSimulatorProps {
  orders: Order[];
  onOrderCreated: () => void;
}

export const CheckoutSimulator: React.FC<CheckoutSimulatorProps> = ({ orders, onOrderCreated }) => {
  const [customerId, setCustomerId] = useState('cust_tallinn_katrin');
  const [selectedProduct, setSelectedProduct] = useState('license');
  const [quantity, setQuantity] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ order: Order; event: OutboxEvent } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const productCatalog: Record<string, { name: string; priceEur: number }> = {
    license: { name: 'OutboxRelay Enterprise License', priceEur: 499 },
    support: { name: '24/7 SLA Priority Support', priceEur: 250 },
    cluster: { name: 'Multi-Region Kafka Cluster Node', priceEur: 850 },
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const product = productCatalog[selectedProduct];
    try {
      const result = await createOrder({
        customerId,
        items: [{ name: product.name, quantity, unitPriceEur: product.priceEur }],
        currency: 'EUR',
      });
      setLastCreated(result);
      onOrderCreated();
    } catch (err: any) {
      setError(err.message || 'Transaction failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="checkout-card">
      <div className="card-header">
        <div>
          <span className="section-badge">Dual-Write Atomicity Simulator</span>
          <h2 className="card-title">Atomic Checkout &amp; Outbox Enqueue</h2>
          <p className="card-subtitle">
            Executes a single ACID transaction creating the business entity in <code>orders</code> and the corresponding event in <code>outbox_events</code>.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="checkout-form">
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">Customer Account</label>
            <select
              className="form-select"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              disabled={isSubmitting}
            >
              <option value="cust_tallinn_katrin">Katrin Tamm (Tallinn, EE)</option>
              <option value="cust_tartu_jaanus">Jaanus Kross (Tartu, EE)</option>
              <option value="cust_helsinki_elena">Elena Vane (Helsinki, FI)</option>
              <option value="cust_stockholm_lars">Lars Lindqvist (Stockholm, SE)</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Select Entity / Product</label>
            <select
              className="form-select"
              value={selectedProduct}
              onChange={(e) => setSelectedProduct(e.target.value)}
              disabled={isSubmitting}
            >
              <option value="license">Enterprise License (€499)</option>
              <option value="support">Priority SLA Support (€250)</option>
              <option value="cluster">Kafka Broker Node (€850)</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Quantity</label>
            <input
              type="number"
              min="1"
              max="10"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              className="form-input"
              disabled={isSubmitting}
            />
          </div>
        </div>

        <div className="checkout-action-row">
          <button
            type="submit"
            className="btn btn-primary btn-md"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Committing Dual-Write Transaction...' : '🛒 Commit Order & Outbox Event'}
          </button>
          <span className="order-total-preview">
            Total: €{(productCatalog[selectedProduct].priceEur * quantity).toFixed(2)} EUR
          </span>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {lastCreated && (
          <div className="dual-write-success-box">
            <div className="dual-write-badge">✓ Atomic ACID Transaction Committed</div>
            <div className="dual-write-split">
              <div className="db-block">
                <span className="block-title">Table: <code>orders</code></span>
                <pre>{JSON.stringify(lastCreated.order, null, 2)}</pre>
              </div>
              <div className="db-block">
                <span className="block-title">Table: <code>outbox_events</code></span>
                <pre>{JSON.stringify(lastCreated.event, null, 2)}</pre>
              </div>
            </div>
          </div>
        )}
      </form>

      <div className="recent-orders-section">
        <h3 className="sub-title">Recent Committed Orders ({orders.length})</h3>
        <div className="orders-table-wrapper">
          <table className="orders-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Total EUR</th>
                <th>Status</th>
                <th>Committed At</th>
              </tr>
            </thead>
            <tbody>
              {orders.slice(0, 5).map((ord) => (
                <tr key={ord.id}>
                  <td><code>{ord.id}</code></td>
                  <td>{ord.customerId}</td>
                  <td>{ord.itemsCount}</td>
                  <td>€{ord.totalEur.toFixed(2)}</td>
                  <td><span className="badge badge-success">{ord.status}</span></td>
                  <td>{new Date(ord.createdAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};