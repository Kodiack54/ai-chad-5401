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

router.post('/chat', async (req, res) => {
  const { message, context } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    // Get recent sessions for context
    const { data: recentSessions } = await from('dev_ai_sessions')
      .select('id, project_path, summary, started_at')
      .order('started_at', { ascending: false })
      .limit(5);

    const sessionInfo = recentSessions?.length > 0
      ? `Recent sessions I've transcribed:\n${recentSessions.map(s =>
          `- ${s.project_path}: ${s.summary || 'No summary'}`
        ).join('\n')}`
      : 'No recent sessions transcribed yet.';

    const reply = await chat(message, {
      sessionInfo,
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
