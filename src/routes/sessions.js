/**
 * Chad Sessions Routes
 * Handles session CRUD and message management
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');
const sessionManager = require('../services/sessionManager');

const logger = new Logger('Chad:Sessions');

// Get active sessions
router.get('/sessions', async (req, res) => {
  try {
    const { data, error } = await from('dev_ai_sessions')
      .select('id, project_path, started_at, status')
      .eq('status', 'active')
      .order('started_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    logger.error('Failed to get sessions', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get session messages
router.get('/sessions/:id/messages', async (req, res) => {
  try {
    const { data, error } = await from('dev_ai_messages')
      .select('role, content, created_at')
      .eq('session_id', req.params.id)
      .order('sequence_num', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    logger.error('Failed to get session messages', { error: err.message, sessionId: req.params.id });
    res.status(500).json({ error: err.message });
  }
});

// Manual message store
router.post('/message', async (req, res) => {
  const { sessionId, role, content } = req.body;

  // Try to use active session first
  const session = sessionManager.getSession(sessionId);
  if (session) {
    await session.storeMessage(role, content);
    return res.json({ success: true });
  }

  // Store directly if session not in memory
  try {
    const { data: maxData } = await from('dev_ai_messages')
      .select('sequence_num')
      .eq('session_id', sessionId)
      .order('sequence_num', { ascending: false })
      .limit(1)
      .single();

    const seq = (maxData?.sequence_num || 0) + 1;

    const { error } = await from('dev_ai_messages').insert({
      session_id: sessionId,
      role,
      content,
      sequence_num: seq
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to store message', { error: err.message, sessionId });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/session/recover - Crash recovery endpoint
 * Returns the current/most recent session for a project so Claude can resume
 */
router.get('/session/recover', async (req, res) => {
  const projectPath = req.query.project;

  if (!projectPath) {
    return res.status(400).json({ error: 'project query param required' });
  }

  try {
    // First check for active session in memory
    const activeSession = sessionManager.getActiveSessionForProject(projectPath);
    if (activeSession) {
      const messages = await activeSession.getMessages();
      return res.json({
        status: 'active',
        sessionId: activeSession.sessionId,
        projectPath: activeSession.projectPath,
        startedAt: activeSession.startedAt,
        messageCount: messages.length,
        messages: messages.slice(-50), // Last 50 messages for context
        summary: buildSessionSummary(messages)
      });
    }

    // Otherwise get most recent session from database
    const { data: sessions, error: sessionsError } = await from('dev_ai_sessions')
      .select('id, project_path, started_at, ended_at, status, summary')
      .eq('project_path', projectPath)
      .order('started_at', { ascending: false })
      .limit(1);

    if (sessionsError) throw sessionsError;

    if (!sessions || sessions.length === 0) {
      return res.json({
        status: 'none',
        message: 'No previous sessions found for this project'
      });
    }

    const session = sessions[0];

    // Get messages from the session
    const { data: messages, error: messagesError } = await from('dev_ai_messages')
      .select('role, content, created_at, sequence_num')
      .eq('session_id', session.id)
      .order('sequence_num', { ascending: true });

    if (messagesError) throw messagesError;

    res.json({
      status: session.status,
      sessionId: session.id,
      projectPath: session.project_path,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      storedSummary: session.summary,
      messageCount: messages?.length || 0,
      messages: (messages || []).slice(-50), // Last 50 messages
      summary: buildSessionSummary(messages || [])
    });

    logger.info('Session recovery served', {
      projectPath,
      sessionId: session.id,
      messageCount: messages?.length || 0
    });
  } catch (err) {
    logger.error('Session recovery failed', { error: err.message, projectPath });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Build a quick summary of session messages for Claude's briefing
 */
function buildSessionSummary(messages) {
  if (!messages || messages.length === 0) {
    return 'No messages in this session yet.';
  }

  const parts = [];
  parts.push(`Session has ${messages.length} messages.`);

  // Get last few exchanges
  const recentMessages = messages.slice(-10);
  const userMessages = recentMessages.filter(m => m.role === 'user');
  const assistantMessages = recentMessages.filter(m => m.role === 'assistant');

  if (userMessages.length > 0) {
    const lastUserMsg = userMessages[userMessages.length - 1];
    const preview = lastUserMsg.content?.slice(0, 200) || '';
    parts.push(`Last user message: "${preview}${lastUserMsg.content?.length > 200 ? '...' : ''}"`);
  }

  if (assistantMessages.length > 0) {
    const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
    const preview = lastAssistantMsg.content?.slice(0, 200) || '';
    parts.push(`Last assistant response: "${preview}${lastAssistantMsg.content?.length > 200 ? '...' : ''}"`);
  }

  return parts.join('\n');
}

// Recent conversations
router.get('/recent', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const projectPath = req.query.project;

  try {
    let query = from('dev_ai_sessions')
      .select('id, project_path, started_at, ended_at')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (projectPath) {
      query = query.eq('project_path', projectPath);
    }

    const { data: sessions, error: sessionsError } = await query;
    if (sessionsError) throw sessionsError;

    // Get messages for each session
    const results = await Promise.all(sessions.map(async (session) => {
      const { data: messages } = await from('dev_ai_messages')
        .select('role, content, created_at')
        .eq('session_id', session.id)
        .order('sequence_num', { ascending: true });

      return {
        session_id: session.id,
        project_path: session.project_path,
        started_at: session.started_at,
        ended_at: session.ended_at,
        messages: messages || []
      };
    }));

    res.json(results);
  } catch (err) {
    logger.error('Failed to get recent sessions', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// MOVED TO END

// Sessions for UI (with proper format)
router.get('/sessions/recent', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  
  try {
    const { data, error } = await from('dev_ai_sessions')
      .select('id, project_path, started_at, ended_at, status, source_type, source_name, message_count, raw_content')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    
    // Format for UI
    const sessions = (data || []).map(s => ({
      id: s.id,
      title: s.source_name || s.source_type || 'Session',
      status: s.status,
      started_at: s.started_at,
      ended_at: s.ended_at,
      source_type: s.source_type,
      source_name: s.source_name,
      message_count: s.message_count || 0,
      project_path: s.project_path,
      needs_review: s.status === 'pending_review',
      processed_by_susan: s.status === 'processed'
    }));

    res.json({ success: true, sessions });
  } catch (err) {
    logger.error('Failed to get recent sessions', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});
module.exports = router;
