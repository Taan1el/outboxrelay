import { createApp } from './app.js';

const parsedPort = Number.parseInt(process.env.PORT ?? '', 10);
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 4003;
const { app } = createApp();

app.listen(port, () => {
  console.log(`[OutboxRelay] Listening on http://localhost:${port}`);
  console.log(`[OutboxRelay] REST API mounted at http://localhost:${port}/api`);
});
