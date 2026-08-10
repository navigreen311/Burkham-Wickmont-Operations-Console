import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env['API_PORT'] ?? 4100);

createApp().listen(port, () => {
  // Startup line only. Request logging belongs to System Health & Observability (11.8),
  // which must scrub PII before anything reaches a log sink.
  console.log(`bwc-console-api listening on http://127.0.0.1:${port}`);
});
