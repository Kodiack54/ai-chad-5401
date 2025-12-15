/**
 * Chad Chat Routes
 * Direct conversation with Chad
 */

const express = require('express');
const router = express.Router();
const { from } = require('../lib/db');
const { chat } = require('../lib/claude');
const { Logger } = require('../lib/logger');

const logger = new Logger('Chad:Chat');

/**
 * Get human-readable time ago string
 */
function getTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
  return date.toLocaleDateString();
}

router.post('/chat', async (req, res) => {
  const { message, context } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    // Get recent sessions with more detail
    const { data: recentSessions } = await from('dev_ai_sessions')
      .select('id, project_path, summary, started_at, ended_at, status, last_cataloged_at')
      .order('started_at', { ascending: false })
      .limit(10);

    // Get message counts for context
    const { data: messages } = await from('dev_ai_messages')
      .select('session_id, role')
      .order('created_at', { ascending: false })
      .limit(100);

    // Count messages per session
    const messageCounts = {};
    messages?.forEach(m => {
      messageCounts[m.session_id] = (messageCounts[m.session_id] || 0) + 1;
    });

    // Get total stats
    const totalMessages = messages?.length || 0;
    const activeSessions = recentSessions?.filter(s => s.status === 'active').length || 0;

    // Build session info with timestamps
    const sessionInfo = recentSessions?.length > 0
      ? `Sessions I've transcribed (${recentSessions.length} total, ${activeSessions} active):\n${recentSessions.slice(0, 5).map(s => {
          const msgCount = messageCounts[s.id] || 0;
          const timeAgo = getTimeAgo(s.started_at);
          const lastCataloged = s.last_cataloged_at ? getTimeAgo(s.last_cataloged_at) : 'never';
          return `- ${s.project_path.split('/').pop()}: ${msgCount} messages, started ${timeAgo}, last cataloged ${lastCataloged} (${s.status})`;
        }).join('\n')}`
      : 'No sessions transcribed yet.';

    // Team context
    const teamContext = `
AI Team at Kodiack Studios:
- Claude: Lead Programmer - he writes the code in the terminal
- Chad: Developer's Assistant - that's me! I watch Claude's sessions and transcribe everything
- Susan: Developer's Librarian - she catalogs the knowledge I extract and helps find things
- Dev Studio: The dashboard where you interact with us

My stats: I've captured ${totalMessages} messages across ${recentSessions?.length || 0} sessions.`;

    const reply = await chat(message, {
      sessionInfo: teamContext + '\n\n' + sessionInfo,
      additionalContext: context
    });

    logger.info('Chat response', {
      messagePreview: message.slice(0, 50),
      replyPreview: reply.slice(0, 50)
    });

    res.json({
      success: true,
      reply,
      from: 'chad'
    });
  } catch (err) {
    logger.error('Chat failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
