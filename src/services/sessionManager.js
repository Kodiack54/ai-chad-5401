/**
 * Chad Session Manager
 * Manages active transcription sessions across multiple projects
 */

const { from } = require('../lib/db');
const { extractConversation } = require('../lib/openai');
const { Logger } = require('../lib/logger');
const config = require('../lib/config');

const logger = new Logger('Chad:SessionManager');

// Active sessions: Map<sessionId, SessionState>
const activeSessions = new Map();

/**
 * Session State - Tracks a single transcription session
 */
class SessionState {
  constructor(sessionId, projectPath, userId) {
    this.sessionId = sessionId;
    this.projectPath = projectPath;
    this.userId = userId;
    this.buffer = '';
    this.messages = [];
    this.sequenceNum = 0;
    this.startedAt = new Date().toISOString();
    this.lastActivity = Date.now();
    this.pendingExtraction = false;
  }

  /**
   * Get all messages in this session (for recovery)
   */
  async getMessages() {
    // Return in-memory messages plus any from database
    try {
      const { data } = await from('dev_ai_messages')
        .select('role, content, created_at, sequence_num')
        .eq('session_id', this.sessionId)
        .order('sequence_num', { ascending: true });
      return data || this.messages;
    } catch (err) {
      return this.messages;
    }
  }

  appendOutput(data) {
    this.buffer += data;
    this.lastActivity = Date.now();

    // Try to extract messages when buffer is large enough
    if (this.buffer.length > 500 && !this.pendingExtraction) {
      this.scheduleExtraction();
    }
  }

  scheduleExtraction() {
    if (this.pendingExtraction) return;
    this.pendingExtraction = true;

    setTimeout(async () => {
      await this.extractMessages();
      this.pendingExtraction = false;
    }, config.SESSION_BUFFER_INTERVAL_MS);
  }

  async extractMessages() {
    if (this.buffer.length < config.SESSION_EXTRACTION_MIN_LENGTH) return;

    const rawOutput = this.buffer;
    this.buffer = '';

    try {
      const messages = await extractConversation(rawOutput);

      if (Array.isArray(messages)) {
        for (const msg of messages) {
          if (msg.role && msg.content && msg.content.trim()) {
            await this.storeMessage(msg.role, msg.content.trim());
          }
        }
      }
    } catch (err) {
      logger.error('Extraction failed', { error: err.message, sessionId: this.sessionId });
      // Fallback to simple extraction
      if (rawOutput.trim()) {
        this.extractSimple(rawOutput);
      }
    }
  }

  extractSimple(output) {
    const clean = output.replace(/\x1b\[[0-9;]*m/g, '')
                       .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '');

    const summaryMatch = clean.match(/[●○]\s+(.+?)(?:\n|$)/g);
    if (summaryMatch) {
      summaryMatch.forEach(m => {
        const content = m.replace(/^[●○]\s*/, '').trim();
        if (content.length > 10) {
          this.storeMessage('assistant', content);
        }
      });
    }
  }

  async storeMessage(role, content) {
    this.sequenceNum++;

    try {
      const { error } = await from('dev_ai_messages').insert({
        session_id: this.sessionId,
        role,
        content,
        sequence_num: this.sequenceNum
      });

      if (error) throw error;

      this.messages.push({ role, content, sequence: this.sequenceNum });
      logger.info('Stored message', {
        role,
        preview: content.slice(0, 50),
        sessionId: this.sessionId
      });

      // Notify Susan
      this.notifySusan({ role, content });
    } catch (err) {
      logger.error('Store failed', { error: err.message, sessionId: this.sessionId });
    }
  }

  async notifySusan(message) {
    try {
      await fetch(`${config.SUSAN_URL}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId,
          projectPath: this.projectPath,
          message
        })
      });
    } catch (err) {
      // Susan might not be running
    }
  }

  async endSession() {
    if (this.buffer.length > 0) {
      await this.extractMessages();
    }

    const { error } = await from('dev_ai_sessions')
      .update({ ended_at: new Date().toISOString(), status: 'completed' })
      .eq('id', this.sessionId);

    if (error) {
      logger.error('End session failed', { error: error.message, sessionId: this.sessionId });
    }

    // Ask Susan to summarize
    try {
      await fetch(`${config.SUSAN_URL}/api/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId })
      });
    } catch (err) {
      // Susan might not be running
    }

    logger.info('Session ended', { sessionId: this.sessionId, projectPath: this.projectPath });
  }
}

/**
 * Session Manager API
 */
async function initialize() {
  logger.info('Session manager initialized');
  return true;
}

async function createSession(projectPath, userId) {
  try {
    const { data, error } = await from('dev_ai_sessions')
      .insert({
        project_path: projectPath,
        user_id: userId,
        terminal_port: 5400,
        status: 'active'
      })
      .select('id')
      .single();

    if (error) throw error;

    const session = new SessionState(data.id, projectPath, userId);
    activeSessions.set(data.id, session);

    logger.info('Session created', { sessionId: data.id, projectPath });
    return session;
  } catch (err) {
    logger.error('Session creation failed', { error: err.message, projectPath });
    throw err;
  }
}

function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

function getActiveCount() {
  return activeSessions.size;
}

async function endSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    await session.endSession();
    activeSessions.delete(sessionId);
  }
}

function getAllSessions() {
  return Array.from(activeSessions.values());
}

/**
 * Get active session for a specific project (for recovery)
 */
function getActiveSessionForProject(projectPath) {
  for (const session of activeSessions.values()) {
    if (session.projectPath === projectPath) {
      return session;
    }
  }
  return null;
}

module.exports = {
  initialize,
  createSession,
  getSession,
  getActiveCount,
  endSession,
  getAllSessions,
  getActiveSessionForProject,
  SessionState
};
