import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { createApiRouter } from './routes/api.routes.js';
import { OutboxService } from './services/outbox.service.js';
import { repoRoot } from './lib/repoPaths.js';

export function createApp(outboxService?: OutboxService) {
  const app = express();
  const service = outboxService || new OutboxService();

  app.use(cors());
  app.use(express.json());

  // Mount API router
  app.use('/api', createApiRouter(service));

  // Serve static client build if present
  // Located from the repository root, not process.cwd(), so it works from source, from
  // the compiled build and inside the Docker image.
  const clientDistPath = path.resolve(repoRoot(), 'client', 'dist');
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(clientDistPath, 'index.html'));
    });
  }

  return { app, outboxService: service };
}