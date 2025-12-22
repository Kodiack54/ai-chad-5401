/**
 * Extractions API - For Susan to fetch pending items
 */
const express = require('express');
const router = express.Router();
const extractionStore = require('../services/extractionStore');

// Get pending extractions by type (todos, knowledge, errors)
router.get('/pending/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const data = await extractionStore.getPendingByType(type, limit);
    res.json({ success: true, type, count: data.length, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all pending extractions grouped by type
router.get('/pending', async (req, res) => {
  try {
    const todos = await extractionStore.getPendingByType('todo', 50);
    const knowledge = await extractionStore.getPendingByType('knowledge', 50);
    const errors = await extractionStore.getPendingByType('error', 20);
    
    res.json({
      success: true,
      summary: {
        todos: todos.length,
        knowledge: knowledge.length,
        errors: errors.length
      },
      data: { todos, knowledge, errors }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark extraction as processed
router.post('/processed/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const success = await extractionStore.markProcessed(id);
    res.json({ success, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force extraction on existing session
router.post('/extract/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { from } = require('../lib/db');
    
    // Get session with raw_content
    const { data: session, error } = await from('dev_ai_sessions')
      .select('id, raw_content, project_path')
      .eq('id', sessionId)
      .single();
    
    if (error || !session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const results = await extractionStore.extractAndStoreFromDump(
      session.id,
      session.project_path || '/var/www/Studio/ai-team/ai-chad-5401',
      session.raw_content
    );
    
    res.json({ success: true, sessionId, extractions: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
