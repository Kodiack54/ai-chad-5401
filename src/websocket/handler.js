/**
 * Chad WebSocket Handler
 * Manages WebSocket connections for terminal output streaming
 */

const WebSocket = require('ws');
const { Logger } = require('../lib/logger');
const sessionManager = require('../services/sessionManager');
const terminalStream = require('./terminalStream');
const { stripAnsi } = require('../../../shared/stripAnsi');

const logger = new Logger('Chad:WebSocket');

// Active connections: Map<projectPath, Set<WebSocket>>
const connections = new Map();

/**
 * Attach WebSocket server to HTTP server
 */
function attach(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const projectPath = url.searchParams.get('project');
    const userId = url.searchParams.get('userId') || 'unknown';

    if (!projectPath) {
      logger.warn('Connection rejected - no project path');
      ws.close(1008, 'Project path required');
      return;
    }

    // Track this connection
    if (!connections.has(projectPath)) {
      connections.set(projectPath, new Set());
    }
    connections.get(projectPath).add(ws);

    logger.info('Client connected', { projectPath, userId });

    // Handle incoming messages (terminal output from client)
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleMessage(ws, message, projectPath, userId);
      } catch (err) {
        logger.error('Message handling failed', { error: err.message, projectPath });
      }
    });

    ws.on('close', () => {
      const projectConnections = connections.get(projectPath);
      if (projectConnections) {
        projectConnections.delete(ws);
        if (projectConnections.size === 0) {
          connections.delete(projectPath);
        }
      }
      logger.info('Client disconnected', { projectPath });
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', { error: err.message, projectPath });
    });

    // Send connection acknowledgment
    ws.send(JSON.stringify({
      type: 'connected',
      projectPath,
      timestamp: Date.now()
    }));
  });

  logger.info('WebSocket server attached');
  return wss;
}

/**
 * Handle incoming WebSocket messages
 */
async function handleMessage(ws, message, projectPath, userId) {
  const { type, payload } = message;

  switch (type) {
    case 'terminal_output':
      await handleTerminalOutput(ws, payload, projectPath, userId);
      break;

    case 'session_start':
      await handleSessionStart(ws, payload, projectPath, userId);
      break;

    case 'session_end':
      await handleSessionEnd(ws, payload, projectPath);
      break;

    case 'message':
      // Handle messages from chad-scribe hook (external Claude Code)
      await handleExternalMessage(ws, message, projectPath, userId);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;

    default:
      logger.warn('Unknown message type', { type, projectPath });
  }
}

/**
 * Handle terminal output from client
 */
async function handleTerminalOutput(ws, payload, projectPath, userId) {
  const { sessionId, data } = payload;

  // Get or create session
  let session = sessionManager.getSession(sessionId);
  if (!session && data) {
    session = await sessionManager.createSession(projectPath, userId);

    // Notify client of new session
    ws.send(JSON.stringify({
      type: 'session_created',
      sessionId: session.sessionId
    }));
  }

  if (session && data) {
    // Process through terminal stream handler
    await terminalStream.process(session, data);
  }
}

/**
 * Handle explicit session start request
 */
async function handleSessionStart(ws, payload, projectPath, userId) {
  try {
    const session = await sessionManager.createSession(projectPath, userId);

    ws.send(JSON.stringify({
      type: 'session_started',
      sessionId: session.sessionId,
      projectPath
    }));

    logger.info('Session started via WebSocket', {
      sessionId: session.sessionId,
      projectPath
    });
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to start session',
      error: err.message
    }));
  }
}

/**
 * Handle session end request
 */
async function handleSessionEnd(ws, payload, projectPath) {
  const { sessionId } = payload;

  try {
    await sessionManager.endSession(sessionId);

    ws.send(JSON.stringify({
      type: 'session_ended',
      sessionId
    }));

    logger.info('Session ended via WebSocket', { sessionId, projectPath });
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to end session',
      error: err.message
    }));
  }
}

/**
 * Broadcast message to all connections for a project
 */
function broadcast(projectPath, message) {
  const projectConnections = connections.get(projectPath);
  if (!projectConnections) return;

  const data = JSON.stringify(message);
  for (const ws of projectConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * Get count of active connections
 */
function getConnectionCount(projectPath) {
  if (projectPath) {
    return connections.get(projectPath)?.size || 0;
  }
  let total = 0;
  for (const conns of connections.values()) {
    total += conns.size;
  }
  return total;
}

module.exports = {
  attach,
  broadcast,
  getConnectionCount
};

/**
 * Handle external messages from chad-scribe hook
 * These come from external Claude Code instances
 */
async function handleExternalMessage(ws, message, projectPath, userId) {
  const { role, source, hook, ts } = message;
  const content = stripAnsi(message.content);
  
  logger.info('External message received', { 
    projectPath, 
    role, 
    source: source || 'unknown',
    hook,
    contentLength: content?.length || 0
  });

  try {
    // Get or create session for this project
    let session = sessionManager.getActiveSessionForProject(projectPath);
    if (!session) {
      session = await sessionManager.createSession(projectPath, userId, {
        source_type: 'external',
        source_name: source || 'claude-code-external'
      });
      logger.info('Created session for external source', { 
        sessionId: session.sessionId, 
        projectPath 
      });
    }

    // Add message to session
    if (session && content) {
      await session.storeMessage(role || 'unknown', content);
    }

    ws.send(JSON.stringify({
      type: 'message_received',
      sessionId: session?.sessionId,
      timestamp: Date.now()
    }));
  } catch (err) {
    logger.error('Failed to handle external message', { 
      error: err.message, 
      projectPath 
    });
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to process message',
      error: err.message
    }));
  }
}
