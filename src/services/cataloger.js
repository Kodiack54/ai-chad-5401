/**
 * Chad Cataloger Service
 * Runs every 30 minutes to process raw session logs into structured knowledge
 *
 * Extracts:
 * - Todos (new and completed)
 * - Code changes
 * - Decisions made
 * - Knowledge/insights
 *
 * Sends to Susan for storage and doc updates
 */

const { from } = require('../lib/db');
const { chat } = require('../lib/claude');
const { Logger } = require('../lib/logger');
const config = require('../lib/config');

const logger = new Logger('Chad:Cataloger');

// Track last processed timestamp per project
const lastProcessed = new Map();

// Cataloger interval (30 minutes)
const CATALOG_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Start the cataloger background job
 */
function start() {
  logger.info('Cataloger started', { intervalMs: CATALOG_INTERVAL_MS });

  // Run immediately on start
  setTimeout(() => runCatalog(), 5000);

  // Then every 30 minutes
  setInterval(() => runCatalog(), CATALOG_INTERVAL_MS);
}

/**
 * Run a single catalog cycle
 */
async function runCatalog() {
  logger.info('Starting catalog cycle');

  try {
    // Get active and recently completed sessions
    const { data: sessions, error } = await from('dev_ai_sessions')
      .select('id, project_path, started_at, ended_at, status, last_cataloged_at')
      .in('status', ['active', 'completed'])
      .order('started_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    if (!sessions || sessions.length === 0) {
      logger.info('No sessions to catalog');
      return;
    }

    for (const session of sessions) {
      await catalogSession(session);
    }

    logger.info('Catalog cycle complete', { sessionsProcessed: sessions.length });
  } catch (err) {
    logger.error('Catalog cycle failed', { error: err.message });
  }
}

/**
 * Catalog a single session
 */
async function catalogSession(session) {
  try {
    // Get messages since last catalog
    const lastCataloged = session.last_cataloged_at || session.started_at;

    const { data: messages, error } = await from('dev_ai_messages')
      .select('role, content, created_at, sequence_num')
      .eq('session_id', session.id)
      .gt('created_at', lastCataloged)
      .order('sequence_num', { ascending: true });

    if (error) throw error;

    if (!messages || messages.length < 3) {
      // Not enough new messages to catalog
      return;
    }

    logger.info('Cataloging session', {
      sessionId: session.id,
      projectPath: session.project_path,
      newMessages: messages.length
    });

    // Build conversation text for extraction
    const conversationText = messages.map(m =>
      `${m.role.toUpperCase()}: ${m.content}`
    ).join('\n\n');

    // Extract structured data using Claude Haiku
    const extraction = await extractKnowledge(conversationText, session.project_path);

    if (extraction) {
      // Send to Susan for storage
      await sendToSusan(session.id, session.project_path, extraction);

      // Update last cataloged timestamp
      await from('dev_ai_sessions')
        .update({ last_cataloged_at: new Date().toISOString() })
        .eq('id', session.id);

      logger.info('Session cataloged', {
        sessionId: session.id,
        todos: extraction.todos?.length || 0,
        completedTodos: extraction.completedTodos?.length || 0,
        knowledge: extraction.knowledge?.length || 0
      });
    }
  } catch (err) {
    logger.error('Session catalog failed', {
      error: err.message,
      sessionId: session.id
    });
  }
}

/**
 * Use Claude Haiku to extract structured knowledge from conversation
 * IMPORTANT: Detects when user mentions a DIFFERENT project and routes accordingly
 */
async function extractKnowledge(conversationText, projectPath) {
  const prompt = `Analyze this development conversation and extract structured information.

CURRENT PROJECT: ${projectPath}

CONVERSATION:
${conversationText.slice(0, 8000)}

Extract the following as JSON. IMPORTANT: If the user mentions a DIFFERENT project (like "add this to NextTask" or "for NextBidder" or "for the tradeline project"), include "targetProject" with that project name. Otherwise omit targetProject.

{
  "todos": [
    { "title": "task title", "description": "details", "priority": "high|medium|low", "targetProject": "project name if mentioned, otherwise omit" }
  ],
  "completedTodos": [
    { "title": "task that was completed", "targetProject": "if mentioned" }
  ],
  "decisions": [
    { "title": "what was decided", "rationale": "why", "targetProject": "if mentioned" }
  ],
  "knowledge": [
    { "category": "code|architecture|bug|feature|api", "title": "title", "summary": "what was learned", "targetProject": "if mentioned" }
  ],
  "codeChanges": [
    { "file": "path/to/file", "action": "created|modified|deleted", "summary": "what changed" }
  ]
}

Only include items that are clearly stated or implied. Return valid JSON only.`;

  try {
    const response = await chat(prompt, { extractionMode: true });

    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return null;
  } catch (err) {
    logger.error('Knowledge extraction failed', { error: err.message });
    return null;
  }
}

/**
 * Send extracted data to Susan for storage and doc updates
 */
async function sendToSusan(sessionId, projectPath, extraction) {
  try {
    const response = await fetch(`${config.SUSAN_URL}/api/catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        projectPath,
        extraction,
        catalogedAt: new Date().toISOString()
      })
    });

    if (!response.ok) {
      throw new Error(`Susan responded with ${response.status}`);
    }

    const result = await response.json();
    logger.info('Sent to Susan', { sessionId, result });
    return result;
  } catch (err) {
    logger.error('Failed to send to Susan', { error: err.message, sessionId });
    // Don't throw - Susan might be unavailable
    return null;
  }
}

/**
 * Force catalog a specific session (for manual triggers)
 */
async function catalogNow(sessionId) {
  const { data: session, error } = await from('dev_ai_sessions')
    .select('id, project_path, started_at, ended_at, status, last_cataloged_at')
    .eq('id', sessionId)
    .single();

  if (error || !session) {
    throw new Error('Session not found');
  }

  await catalogSession(session);
  return { success: true, sessionId };
}

module.exports = {
  start,
  runCatalog,
  catalogNow
};
