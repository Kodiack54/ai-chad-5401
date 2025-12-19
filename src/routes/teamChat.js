/**
 * Team Chat API Routes
 * Handles two-way communication between workers and user
 */

const express = require('express');
const router = express.Router();
const teamChat = require('../services/teamChat');
const learningService = require('../services/learningService');
const { detectContext } = require('../services/contextDetector');
const { Logger } = require('../lib/logger');

const logger = new Logger('Chad:TeamChatAPI');

/**
 * GET /team-chat/messages
 * Get all chat messages
 */
router.get('/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = await teamChat.getMessages(limit);
    res.json({ success: true, messages });
  } catch (error) {
    logger.error('Failed to get messages', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /team-chat/pending
 * Get pending questions that need answers
 */
router.get('/pending', async (req, res) => {
  try {
    const questions = await teamChat.getPendingQuestions();
    res.json({ success: true, questions, count: questions.length });
  } catch (error) {
    logger.error('Failed to get pending questions', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /team-chat/answer
 * Answer a pending question
 */
router.post('/answer', async (req, res) => {
  try {
    const { questionId, answer } = req.body;
    
    if (!questionId || !answer) {
      return res.status(400).json({ 
        success: false, 
        error: 'questionId and answer are required' 
      });
    }
    
    const result = await teamChat.processAnswer(questionId, answer, learningService);
    
    res.json({ 
      success: true, 
      message: 'Answer recorded and processed',
      result 
    });
  } catch (error) {
    logger.error('Failed to process answer', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /team-chat/message
 * Send a message to Chad (instruction, feedback, etc.)
 */
router.post('/message', async (req, res) => {
  try {
    const { content, type = 'instruction' } = req.body;
    
    if (!content) {
      return res.status(400).json({ 
        success: false, 
        error: 'content is required' 
      });
    }
    
    // Record the user message
    const db = require('../lib/db');
    const { getChadWorkerId } = require('../services/contextDetector');
    const workerId = await getChadWorkerId();
    
    await db.from('dev_team_chat').insert({
      worker_id: workerId,
      direction: 'to_worker',
      message_type: type,
      content: content,
      status: 'acknowledged'
    });
    
    // If this looks like it's teaching Chad something, try to learn
    if (type === 'instruction' && content.toLowerCase().includes('means')) {
      // Pattern: "X means Y" or "X is about Y"
      const learnMatch = content.match(/["']?(\w+)["']?\s+(means|is about|belongs to|goes in)\s+(.+)/i);
      if (learnMatch) {
        const term = learnMatch[1];
        const routing = learnMatch[3];
        await learningService.learnTerm(term, routing, { source: 'user_instruction' });
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Message received' 
    });
  } catch (error) {
    logger.error('Failed to process message', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /team-chat/mark-read
 * Mark all messages as read
 */
router.post('/mark-read', async (req, res) => {
  try {
    await teamChat.markAllRead();
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to mark read', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /team-chat/stats
 * Get Chad's learning stats
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await learningService.getStats();
    res.json({ success: true, stats });
  } catch (error) {
    logger.error('Failed to get stats', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /team-chat/test-context
 * Test context detection on some text
 */
router.post('/test-context', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ 
        success: false, 
        error: 'text is required' 
      });
    }
    
    const result = await detectContext(text, { includeMetadata: true });
    res.json({ success: true, result });
  } catch (error) {
    logger.error('Failed to test context', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /team-chat/teach
 * Explicitly teach Chad a term → routing mapping
 */
router.post('/teach', async (req, res) => {
  try {
    const { term, routing } = req.body;
    
    if (!term || !routing) {
      return res.status(400).json({ 
        success: false, 
        error: 'term and routing are required' 
      });
    }
    
    const result = await learningService.learnTerm(term, routing, { 
      source: 'user_taught' 
    });
    
    res.json({ 
      success: true, 
      message: `Learned: "${term}" maps to ${routing}`,
      result 
    });
  } catch (error) {
    logger.error('Failed to teach', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
