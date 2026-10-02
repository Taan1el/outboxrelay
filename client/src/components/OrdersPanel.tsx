import React, { useState } from 'react';
import type { Order, OutboxEvent } from '../../../shared/types.js';
import { createOrder } from '../services/index.js';
import { formatClock, formatEur } from '../utils/format.js';

interface OrdersPanelProps {
  orders: Order[];
  onOrderCreated: () => void;
}

const CUSTOMERS = [
  { id: 'cust_tallinn_katrin', label: 'Katrin Tamm, Tallinn' },
  { id: 'cust_tartu_jaanus', label: 'Jaanus Kross, Tartu' },
  { id: 'cust_helsinki_elena', label: 'Elena Vane, Helsinki' },
  { id: 'cust_stockholm_lars', label: 'Lars Lindqvist, Stockholm' },
];

const PRODUCTS: Record<string, { name: string; priceEur: number }> = {
  license: { name: 'Starter license', priceEur: 499 },
  support: { name: 'Priority support', priceEur: 250 },
  node: { name: 'Broker node', priceEur: 850 },
};

export const OrdersPanel: React.FC<OrdersPanelProps> = ({ orders, onOrderCreated }) => {
  const [customerId, setCustomerId] = useState(CUSTOMERS[0].id);
  const [productKey, setProductKey] = useState('license');
  const [quantityText, setQuantityText] = useState('1');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ order: Order; event: OutboxEvent } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const product = PRODUCTS[productKey];
  const quantity = Math.max(1, Math.min(10, Math.trunc(Number(quantityText)) || 1));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await createOrder({
        customerId,
        items: [{ name: product.name, quantity, unitPriceEur: product.priceEur }],
        currency: 'EUR',
      });
      setLastCreated(result);
      onOrderCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The order could not be saved');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="orders-heading">
      <h2 id="orders-heading" className="section-heading">
        Place an order
      </h2>
      <p className="section-description">
        One transaction inserts the order and its outbox row, so neither exists without the other.
      </p>

      <form onSubmit={handleSubmit} className="order-form">
        <div className="field">
          <label className="field-label" htmlFor="order-customer">
            Customer
          </label>
          <select id="order-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={isSubmitting}>
            {CUSTOMERS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="order-product">
            Product
          </label>
          <select id="order-product" value={productKey} onChange={(e) => setProductKey(e.target.value)} disabled={isSubmitting}>
            {Object.entries(PRODUCTS).map(([key, p]) => (
              <option key={key} value={key}>
                {`${p.name} (EUR ${p.priceEur})`}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-narrow">
          <label className="field-label" htmlFor="order-quantity">
            Quantity
          </label>
          <input
            id="order-quantity"
            type="number"
            min={1}
            max={10}
            value={quantityText}
            onChange={(e) => setQuantityText(e.target.value)}
            onBlur={() => setQuantityText(String(quantity))}
            disabled={isSubmitting}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
          {isSubmitting ? 'Saving order' : 'Save order and event'}
        </button>
      </form>

      <output className="form-result">
        {error && <span className="text-bad">{error}</span>}
        {!error && lastCreated && (
          <span>
            {`Saved ${lastCreated.order.id} (${formatEur(lastCreated.order.totalEur)}) with outbox row ${lastCreated.event.id}, status ${lastCreated.event.status.toLowerCase()}.`}
          </span>
        )}
      </output>

      <h3 className="panel-heading">Recent orders</h3>
      {orders.length === 0 ? (
        <p className="empty-note">No orders yet.</p>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Customer</th>
                <th scope="col">Items</th>
                <th scope="col">Total</th>
                <th scope="col">Saved</th>
              </tr>
            </thead>
            <tbody>
              {orders.slice(0, 5).map((ord) => (
                <tr key={ord.id}>
                  <td className="mono">{ord.id}</td>
                  <td className="mono">{ord.customerId}</td>
                  <td className="mono">{ord.itemsCount}</td>
                  <td className="mono">{formatEur(ord.totalEur)}</td>
                  <td className="mono">{formatClock(ord.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
