// The one place that decides whether the app talks to the Express API or to the
// in-browser demo. Components import from here, never from ./api.js or ./demoApi.js.
import * as realApi from './api.js';
import * as demoApi from './demoApi.js';

export const isDemoMode = import.meta.env.VITE_DEMO_MODE === 'true';

const impl = isDemoMode ? demoApi : realApi;

export const fetchStats = impl.fetchStats;
export const fetchOrders = impl.fetchOrders;
export const createOrder = impl.createOrder;
export const fetchOutboxEvents = impl.fetchOutboxEvents;
export const triggerPoll = impl.triggerPoll;
export const retryDeadLetter = impl.retryDeadLetter;
export const fetchConsumerInbox = impl.fetchConsumerInbox;
export const updateBrokerFault = impl.updateBrokerFault;

// Only meaningful in demo mode; the banner is the only caller.
export const resetDemoData = demoApi.resetDemoData;
