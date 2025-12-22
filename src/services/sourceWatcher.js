/**
 * Chad Multi-Source Watcher
 * Actively monitors 4 sources and dumps on staggered 30-min schedule
 *
 * Schedule (every 10 mins, one source dumps):
 *   :00, :30 - External Claude (local terminals connecting to dev-studio)
 *   :10, :40 - Chat systems (Susan + Chad chats)
 *   :20, :50 - Internal Claude (Server Claude at :5400)
 */

const WebSocket = require('ws');
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');
const config = require('../lib/config');

const logger = new Logger('Chad:SourceWatcher');

// Source definitions - dumps every 5 min, staggered to avoid conflicts
const SOURCES = {
  EXTERNAL_CLAUDE: {
    id: 'external_claude',
    name: 'External Claude (Local)',
    type: 'websocket',
    dumpMinutes: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55], // Every 5 min at :00
    description: 'Local Claude Code terminals'
  },
  CHAT_SYSTEMS: {
    id: 'chat_systems',
    name: 'Chat Systems',
    type: 'api_poll',
    dumpMinutes: [2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57], // Every 5 min at :02
    endpoints: [
      { name: 'susan_chat', url: `${config.SUSAN_URL}/api/chat/recent` },
      { name: 'chad_chat', url: `http://localhost:${config.PORT}/api/recent` }
    ],
    description: 'Susan and Chad chat conversations'
  },
  INTERNAL_CLAUDE: {
    id: 'internal_claude',
    name: 'Internal Claude (Server)',
    type: 'websocket',
    url: process.env.CLAUDE_SERVER_WS || 'ws://localhost:5400?mode=monitor',
    dumpMinutes: [4, 9, 14, 19, 24, 29, 34, 39, 44, 49, 54, 59], // Every 5 min at :04
    description: 'Server-side Claude terminal at :5400'
  }
};

// Active watchers and their buffers
const watchers = new Map();

class SourceBuffer {
  constructor(sourceId, sourceName) {
    this.sourceId = sourceId;
    this.sourceName = sourceName;
    this.buffer = '';
    this.messageCount = 0;
    this.lastActivity = null;
    this.connected = false;
  }

  append(data) {
    this.buffer += data;
    this.messageCount++;
    this.lastActivity = new Date();
  }

  clear() {
    const content = this.buffer;
    this.buffer = '';
    const count = this.messageCount;
    this.messageCount = 0;
    return { content, count };
  }

  hasContent() {
    return this.buffer.length > 0;
  }
}

/**
 * Initialize all source watchers
 */
async function initialize() {
  logger.info('Initializing multi-source watcher');

  // Set up buffers for each source
  for (const [key, source] of Object.entries(SOURCES)) {
    watchers.set(source.id, new SourceBuffer(source.id, source.name));
  }

  // Connect to Internal Claude WebSocket
  connectToInternalClaude();

  // Start the dump scheduler
  startDumpScheduler();

  logger.info('Source watcher initialized', {
    sources: Object.keys(SOURCES).length
  });

  return true;
}

/**
 * Connect to Server Claude's terminal WebSocket
 */
function connectToInternalClaude() {
  const source = SOURCES.INTERNAL_CLAUDE;
  const buffer = watchers.get(source.id);

  const connect = () => {
    try {
      const ws = new WebSocket(source.url);

      ws.on('open', () => {
        logger.info('Connected to Internal Claude', { url: source.url });
        buffer.connected = true;
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'monitor_output' && msg.data) {
            buffer.append(msg.data);
            buffer.userId = msg.userId || buffer.userId;
            buffer.projectPath = msg.projectPath || buffer.projectPath;
            logger.debug('Monitor output received', { sessionId: msg.sessionId, userId: msg.userId, projectPath: msg.projectPath, dataLen: msg.data.length });
            return;
          } else if (msg.type === 'monitor_connected') {
            logger.info('Connected as monitor to Server Claude', { activeSessions: msg.activeSessions });
            return;
          }
        } catch {}
        // Original handler below
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'output' && msg.data) {
            buffer.append(msg.data);
          }
        } catch {
          buffer.append(data.toString());
        }
      });

      ws.on('close', () => {
        logger.warn('Internal Claude disconnected, reconnecting in 10s');
        buffer.connected = false;
        setTimeout(connect, 10000);
      });

      ws.on('error', (err) => {
        logger.error('Internal Claude WebSocket error', { error: err.message });
        buffer.connected = false;
      });
    } catch (err) {
      logger.error('Failed to connect to Internal Claude', { error: err.message });
      setTimeout(connect, 10000);
    }
  };

  connect();
}

/**
 * Poll chat systems for recent messages
 */
async function pollChatSystems() {
  const source = SOURCES.CHAT_SYSTEMS;
  const buffer = watchers.get(source.id);

  for (const endpoint of source.endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.ok) {
        const data = await response.json();
        if (data && (data.messages || data.length > 0)) {
          const content = JSON.stringify(data, null, 2);
          buffer.append(`\n--- ${endpoint.name} ---\n${content}\n`);
        }
      }
    } catch (err) {
      // Endpoint might not be running
    }
  }
}

/**
 * Start the staggered dump scheduler
 */
function startDumpScheduler() {
  // Check every minute
  setInterval(async () => {
    const now = new Date();
    const minute = now.getMinutes();

    // Check each source's dump schedule
    for (const [key, source] of Object.entries(SOURCES)) {
      if (source.dumpMinutes.includes(minute)) {
        // Only dump if we haven't already this minute
        const buffer = watchers.get(source.id);
        if (buffer && buffer.hasContent()) {
          await performDump(source.id, source.name);
        }
      }
    }

    // Poll chat systems every 5 minutes to keep buffer fresh
    if (minute % 5 === 0) {
      await pollChatSystems();
    }
  }, 60000); // Check every minute

  logger.info('Dump scheduler started');
}

/**
 * Perform a dump for a specific source
 */
async function performDump(sourceId, sourceName) {
  const buffer = watchers.get(sourceId);
  if (!buffer || !buffer.hasContent()) {
    logger.info('No content to dump', { source: sourceName });
    return null;
  }

  const { content, count } = buffer.clear();

  try {
    // Use buffer's projectPath if available, otherwise default to Studio
    const projectPath = buffer.projectPath || '/var/www/Studio/ai-team/ai-chad-5401';

    // Create session record
    const { data: session, error: sessionError } = await from('dev_ai_sessions')
      .insert({
        project_path: projectPath,
        source_type: sourceId,
        source_name: sourceName,
        status: 'pending_review',
        raw_content: content,
        message_count: count,
        started_at: buffer.lastActivity || new Date().toISOString()
      })
      .select('id')
      .single();

    if (sessionError) throw sessionError;

    // Run extraction on the raw content
    const extractionStore = require('./extractionStore');
    const extractions = await extractionStore.extractAndStoreFromDump(
      session.id,
      projectPath,
      content
    );

    logger.info('Dump created with extractions', {
      sessionId: session.id,
      source: sourceName,
      contentLength: content.length,
      messageCount: count,
      extractions
    });

    // Notify Susan that there's a new dump to process
    await notifySusan(session.id, sourceId, sourceName);

    return session.id;
  } catch (err) {
    logger.error('Dump failed', { error: err.message, source: sourceName });
    // Put content back in buffer
    buffer.buffer = content + buffer.buffer;
    return null;
  }
}

/**
 * Notify Susan of new dump to process
 */
async function notifySusan(sessionId, sourceId, sourceName) {
  try {
    await fetch(`${config.SUSAN_URL}/api/process-dump`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        sourceId,
        sourceName,
        timestamp: new Date().toISOString()
      })
    });
    logger.info('Susan notified of new dump', { sessionId });
  } catch (err) {
    // Susan might not be running - that's ok, she'll pick it up later
    logger.warn('Could not notify Susan', { error: err.message });
  }
}

/**
 * Add content to external Claude buffer (called when local terminals connect)
 */
function appendExternalClaude(data) {
  const buffer = watchers.get(SOURCES.EXTERNAL_CLAUDE.id);
  if (buffer) {
    buffer.append(data);
  }
}

/**
 * Get status of all watchers
 */
function getStatus() {
  const status = {};
  for (const [id, buffer] of watchers) {
    status[id] = {
      name: buffer.sourceName,
      connected: buffer.connected,
      bufferSize: buffer.buffer.length,
      messageCount: buffer.messageCount,
      lastActivity: buffer.lastActivity
    };
  }
  return status;
}

/**
 * Force a dump for a specific source (manual trigger)
 */
async function forceDump(sourceId) {
  const source = Object.values(SOURCES).find(s => s.id === sourceId);
  if (!source) {
    throw new Error(`Unknown source: ${sourceId}`);
  }

  // Poll chat systems first if that's what we're dumping
  if (sourceId === 'chat_systems') {
    await pollChatSystems();
  }

  return await performDump(sourceId, source.name);
}

/**
 * Get pending dumps that Susan hasn't processed yet
 */
async function getPendingDumps() {
  try {
    const { data, error } = await from('dev_ai_sessions')
      .select('id, source_type, source_name, status, started_at, message_count')
      .eq('status', 'pending_review')
      .order('started_at', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('Failed to get pending dumps', { error: err.message });
    return [];
  }
}

module.exports = {
  initialize,
  appendExternalClaude,
  getStatus,
  forceDump,
  getPendingDumps,
  SOURCES
};
