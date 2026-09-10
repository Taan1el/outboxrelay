import { createApp } from './app.js';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4003;
const { app } = createApp();

app.listen(port, () => {
  console.log(`[OutboxRelay] Event Broker listening on http://localhost:${port}`);
  console.log(`[OutboxRelay] REST API mounted at http://localhost:${port}/api`);
});