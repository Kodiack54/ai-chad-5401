/**
 * Chad Cataloger Service
 * Two-tier processing:
 * - Quick Parse: Every 5 minutes - pattern matching, no AI
 * - Full Catalog: Every 30 minutes - SMART AI extraction
 */

const { from } = require('../lib/db');
const { Logger } = require('../lib/logger');
const config = require('../lib/config');
const { extractSmart, toSusanFormat } = require('../lib/smartExtractor');
const { extractWithContext, toSusanFormatWithRouting } = require('./contextAwareExtractor');

const logger = new Logger('Chad:Cataloger');

// Intervals
const QUICK_PARSE_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const FULL_CATALOG_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Start the cataloger background jobs
 */
function start() {
  logger.info('Cataloger started (SMART MODE)', {
    quickParseInterval: '5 minutes',
    fullCatalogInterval: '30 minutes'
  });

  // Quick parse: 5 min (no AI, just patterns)
  setTimeout(() => runQuickParse(), 3000);
  setInterval(() => runQuickParse(), QUICK_PARSE_INTERVAL_MS);

  // Full catalog: 30 min (smart AI extraction)
  setTimeout(() => runFullCatalog(), 10000);
  setInterval(() => runFullCatalog(), FULL_CATALOG_INTERVAL_MS);
}

/**
 * Quick Parse - every 5 minutes, no AI
 */
async function runQuickParse() {
  logger.info('Starting quick parse cycle');

  try {
    const { data: sessions, error } = await from('dev_ai_sessions')
      .select('id, project_path, started_at, status')
      .in('status', ['active', 'completed'])
      .order('started_at', { ascending: false })
      .limit(10);

    if (error) throw error;
    if (!sessions?.length) return;

    for (const session of sessions) {
      await quickParseSession(session);
    }

    logger.info('Quick parse complete', { sessions: sessions.length });
  } catch (err) {
    logger.error('Quick parse failed', { error: err.message });
  }
}

/**
 * Quick parse a single session (pattern matching only)
 */
async function quickParseSession(session) {
  try {
    const { data: messages, error } = await from('dev_ai_messages')
      .select('role, content, created_at')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error || !messages?.length) return;

    // Quick pattern extraction - no AI
    const quickData = {
      keywords: extractKeywords(messages),
      fileMentions: extractFileMentions(messages),
      todoMentions: extractTodoMentions(messages),
      errorMentions: extractErrorMentions(messages),
      messageCount: messages.length
    };

    // Send to Susan's quick-parse endpoint
    await sendQuickUpdateToSusan(session.id, session.project_path, quickData);

  } catch (err) {
    logger.error('Quick parse session failed', { error: err.message, sessionId: session.id });
  }
}

// Pattern extraction functions (no AI)
function extractKeywords(messages) {
  const keywords = new Set();
  const patterns = [
    /\b(TODO|FIXME|BUG|HACK|NOTE|XXX)\b/gi,
    /\b(error|warning|failed|success|completed)\b/gi,
    /\b(created?|modified?|deleted?|updated?|added?|removed?)\b/gi
  ];
  for (const msg of messages) {
    for (const pattern of patterns) {
      const matches = msg.content?.match(pattern) || [];
      matches.forEach(m => keywords.add(m.toLowerCase()));
    }
  }
  return Array.from(keywords);
}

function extractFileMentions(messages) {
  const files = new Set();
  const pattern = /[\w\-\/]+\.(js|ts|tsx|jsx|json|css|scss|md|py|sql|env)\b/gi;
  for (const msg of messages) {
    const matches = msg.content?.match(pattern) || [];
    matches.forEach(f => files.add(f));
  }
  return Array.from(files);
}

function extractTodoMentions(messages) {
  const todos = [];
  const pattern = /(?:TODO|TASK|NEED TO|SHOULD|MUST)[\s:]+([^\n.]{10,100})/gi;
  for (const msg of messages) {
    let match;
    while ((match = pattern.exec(msg.content || '')) !== null) {
      todos.push(match[1].trim());
    }
  }
  return todos.slice(0, 10);
}

function extractErrorMentions(messages) {
  const errors = [];
  const pattern = /(?:error|failed|exception)[\s:]+([^\n]{10,150})/gi;
  for (const msg of messages) {
    let match;
    while ((match = pattern.exec(msg.content || '')) !== null) {
      errors.push(match[1].trim());
    }
  }
  return errors.slice(0, 5);
}

async function sendQuickUpdateToSusan(sessionId, projectPath, quickData) {
  try {
    await fetch(`${config.SUSAN_URL}/api/quick-parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, projectPath, quickData, parsedAt: new Date().toISOString() })
    });
  } catch (err) {
    logger.warn('Failed to send quick update to Susan', { error: err.message });
  }
}

/**
 * Full Catalog - every 30 minutes with SMART AI extraction
 */
async function runFullCatalog() {
  logger.info('Starting SMART catalog cycle');

  try {
    const { data: sessions, error } = await from('dev_ai_sessions')
      .select('id, project_path, started_at, ended_at, status, last_cataloged_at')
      .in('status', ['active', 'completed'])
      .order('started_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    if (!sessions?.length) {
      logger.info('No sessions to catalog');
      return;
    }

    for (const session of sessions) {
      await catalogSession(session);
    }

    logger.info('SMART catalog complete', { sessions: sessions.length });
  } catch (err) {
    logger.error('SMART catalog failed', { error: err.message });
  }
}

const runCatalog = runFullCatalog;

/**
 * Catalog a single session with SMART extraction
 */
async function catalogSession(session) {
  try {
    const lastCataloged = session.last_cataloged_at || session.started_at;

    const { data: messages, error } = await from('dev_ai_messages')
      .select('role, content, created_at, sequence_num')
      .eq('session_id', session.id)
      .gt('created_at', lastCataloged)
      .order('sequence_num', { ascending: true });

    if (error) throw error;
    if (!messages || messages.length < 3) return;

    logger.info('SMART cataloging session', {
      sessionId: session.id,
      projectPath: session.project_path,
      newMessages: messages.length
    });

    // Build conversation text
    const conversationText = messages.map(m =>
      `${m.role.toUpperCase()}: ${m.content}`
    ).join('\n\n');

    // Get previous context for continuity
    const previousContext = await getPreviousContext(session.project_path);

    // SMART extraction
    const smartExtraction = await extractWithContext(conversationText, { projectPath: session.project_path, previousContext });

    if (smartExtraction) {
      // Convert to Susan's format (backward compatible)
      const susanData = toSusanFormatWithRouting(smartExtraction);

      // Send to Susan
      await sendToSusan(session.id, session.project_path, susanData);

      // Store raw smart extraction for future AI use
      await storeSmartExtraction(session.id, smartExtraction);

      // Update last cataloged
      await from('dev_ai_sessions')
        .update({ last_cataloged_at: new Date().toISOString() })
        .eq('id', session.id);

      logger.info('Session SMART cataloged', {
        sessionId: session.id,
        workType: smartExtraction.sessionSummary?.workType,
        outcome: smartExtraction.sessionSummary?.outcome,
        problems: smartExtraction.problems?.length || 0,
        decisions: smartExtraction.decisions?.length || 0,
        discoveries: smartExtraction.discoveries?.length || 0
      });
    }
  } catch (err) {
    logger.error('Session catalog failed', { error: err.message, sessionId: session.id });
  }
}

/**
 * Get previous session context for continuity
 */
async function getPreviousContext(projectPath) {
  try {
    const { data } = await from('dev_ai_smart_extractions')
      .select('continuity, session_summary')
      .eq('project_path', projectPath)
      .order('created_at', { ascending: false })
      .limit(1);

    if (data?.[0]) {
      return `Previous work: ${data[0].session_summary?.mainGoal || 'Unknown'}
In progress: ${data[0].continuity?.inProgress || 'None'}
Blockers: ${(data[0].continuity?.blockers || []).join(', ') || 'None'}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Store smart extraction for future AI reference
 */
async function storeSmartExtraction(sessionId, extraction) {
  try {
    await from('dev_ai_smart_extractions').insert({
      session_id: sessionId,
      project_path: extraction.sessionSummary?.projectPath,
      session_summary: extraction.sessionSummary,
      continuity: extraction.continuity,
      problems: extraction.problems,
      decisions: extraction.decisions,
      discoveries: extraction.discoveries,
      dependencies: extraction.dependencies,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    // Table might not exist yet - that's ok
    logger.debug('Could not store smart extraction', { error: err.message });
  }
}

/**
 * Send to Susan
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

    return await response.json();
  } catch (err) {
    logger.error('Failed to send to Susan', { error: err.message });
    return null;
  }
}

/**
 * Force catalog now
 */
async function catalogNow(sessionId) {
  const { data: session, error } = await from('dev_ai_sessions')
    .select('id, project_path, started_at, ended_at, status, last_cataloged_at')
    .eq('id', sessionId)
    .single();

  if (error || !session) throw new Error('Session not found');

  await catalogSession(session);
  return { success: true, sessionId };
}

module.exports = {
  start,
  runQuickParse,
  runFullCatalog,
  runCatalog,
  catalogNow
};
