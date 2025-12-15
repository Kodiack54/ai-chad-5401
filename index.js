/**
 * Chad - AI Transcriber
 * Port 5401
 *
 * Logs and transcribes Claude Code terminal conversations.
 * Extracts human/assistant messages and stores them for Susan to catalog.
 */

require('dotenv').config();
const { Logger } = require('./src/lib/logger');

const logger = new Logger('Chad');

async function start() {
  logger.info('Starting Chad Transcriber...');

  // 1. Load and validate config
  const config = require('./src/lib/config');
  logger.info('Config loaded', {
    port: config.PORT,
    susanUrl: config.SUSAN_URL
  });

  // 2. Initialize session manager
  const sessionManager = require('./src/services/sessionManager');
  await sessionManager.initialize();
  logger.info('Session manager initialized');

  // 3. Discover extractors
  const extractorRegistry = require('./src/extractors/registry');
  await extractorRegistry.discover();
  logger.info(`Loaded ${extractorRegistry.count()} extractors`, {
    extractors: extractorRegistry.list().map(e => e.name)
  });

  // 4. Start HTTP server
  const app = require('./src/routes');
  const server = app.listen(config.PORT, () => {
    logger.info(`Chad HTTP server listening on port ${config.PORT}`);
  });

  // 5. Attach WebSocket handler
  const wsHandler = require('./src/websocket/handler');
  wsHandler.attach(server);
  logger.info('WebSocket handler attached');

  // 6. Start cataloger background job (every 30 min)
  const cataloger = require('./src/services/cataloger');
  cataloger.start();
  logger.info('Cataloger background job started');

  // 7. Ready
  logger.info('Chad Transcriber ready', {
    port: config.PORT,
    extractors: extractorRegistry.count(),
    pid: process.pid
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down...');

    // End all active sessions
    const sessions = sessionManager.getAllSessions();
    for (const session of sessions) {
      await session.endSession();
    }

    server.close(() => {
      logger.info('Chad shutdown complete');
      process.exit(0);
    });
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down...');

    const sessions = sessionManager.getAllSessions();
    for (const session of sessions) {
      await session.endSession();
    }

    server.close(() => {
      logger.info('Chad shutdown complete');
      process.exit(0);
    });
  });
}

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

// Start Chad
start().catch(err => {
  logger.error('Startup failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
