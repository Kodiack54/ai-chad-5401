/**
 * Chad Heartbeat - HTTP health endpoint only
 *
 * DOES:
 *  - Serve /health endpoint
 *
 * DOES NOT:
 *  - Write to any database
 *  - Process anything
 */

const http = require('http');

const PORT = parseInt(process.env.CHAD_HEARTBEAT_PORT || '5401', 10);
const VERSION = '2.0.0';

const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      name: 'chad',
      ts: new Date().toISOString(),
      version: VERSION
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`[Chad Heartbeat] Listening on :${PORT}/health - v${VERSION}`);
});

process.on('SIGINT', () => {
  console.log('[Chad Heartbeat] SIGINT - shutting down');
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Chad Heartbeat] SIGTERM - shutting down');
  server.close();
  process.exit(0);
});
