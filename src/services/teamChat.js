/**
 * Chad Team Chat Service
 * Handles two-way communication between Chad and the user
 * When Chad is unsure, he asks questions. User answers help him learn.
 */

const db = require('../lib/db');
const { Logger } = require('../lib/logger');
const { getChadWorkerId } = require('./contextDetector');

const logger = new Logger('Chad:TeamChat');

/**
 * Ask a question to the user (creates a pending message)
 */
async function askQuestion(question, context = {}) {
  try {
    const workerId = await getChadWorkerId();
    if (!workerId) {
      logger.error('Cannot ask question - Chad worker ID not found');
      return null;
    }
    
    const { data, error } = await db.from('dev_team_chat').insert({
      worker_id: workerId,
      direction: 'from_worker',
      message_type: 'question',
      content: question,
      context_json: JSON.stringify(context),
      status: 'pending',
      priority: context.priority || 'normal'
    });
    
    if (error) {
      logger.error('Failed to create question', { error: error.message });
      return null;
    }
    
    logger.info('Question posted', { question: question.substring(0, 50) });
    return data?.[0] || data;
  } catch (error) {
    logger.error('askQuestion failed', { error: error.message });
    return null;
  }
}

/**
 * Create a notification for the user
 */
async function notify(message, context = {}) {
  try {
    const workerId = await getChadWorkerId();
    if (!workerId) return null;
    
    const { data } = await db.from('dev_team_chat').insert({
      worker_id: workerId,
      direction: 'from_worker',
      message_type: 'notification',
      content: message,
      context_json: JSON.stringify(context),
      status: 'pending',
      priority: context.priority || 'low'
    });
    
    return data?.[0] || data;
  } catch (error) {
    logger.error('notify failed', { error: error.message });
    return null;
  }
}

/**
 * Request confirmation from user
 */
async function askConfirmation(actionDetails, suggestedRouting, context = {}) {
  const question = `I'm about to log this under **${formatRouting(suggestedRouting)}**:

${actionDetails}

Is this the right place? Reply **yes** to confirm, or tell me where it should go.`;

  return askQuestion(question, {
    ...context,
    type: 'confirmation',
    suggestedRouting,
    action: actionDetails
  });
}

/**
 * Ask about unknown term/context
 */
async function askAboutTerm(term, possibleOptions = [], context = {}) {
  let question = `I saw you mention "${term}" but I'm not sure which project this belongs to.`;
  
  if (possibleOptions.length > 0) {
    question += `\n\nCould it be one of these?\n`;
    possibleOptions.forEach((opt, i) => {
      question += `${i + 1}. ${opt.label}\n`;
    });
    question += `\nOr tell me something else.`;
  } else {
    question += `\n\nCan you tell me which project/platform this is about?`;
  }
  
  return askQuestion(question, {
    ...context,
    type: 'term_clarification',
    term,
    possibleOptions
  });
}

/**
 * Get pending questions for user to answer
 */
async function getPendingQuestions() {
  try {
    const workerId = await getChadWorkerId();
    if (!workerId) return [];
    
    const { data } = await db.from('dev_team_chat')
      .select('*')
      .eq('worker_id', workerId)
      .eq('direction', 'from_worker')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    
    return data || [];
  } catch (error) {
    logger.error('getPendingQuestions failed', { error: error.message });
    return [];
  }
}

/**
 * Get all messages (for chat UI)
 */
async function getMessages(limit = 50) {
  try {
    const workerId = await getChadWorkerId();
    if (!workerId) return [];
    
    const { data } = await db.from('dev_team_chat')
      .select('*')
      .eq('worker_id', workerId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    return (data || []).reverse();
  } catch (error) {
    logger.error('getMessages failed', { error: error.message });
    return [];
  }
}

/**
 * Record user's answer to a question
 */
async function recordAnswer(questionId, answer) {
  try {
    // Mark question as answered
    await db.from('dev_team_chat')
      .update({ 
        status: 'answered',
        read_at: new Date().toISOString()
      })
      .eq('id', questionId);
    
    const workerId = await getChadWorkerId();
    
    // Record the answer
    const { data } = await db.from('dev_team_chat').insert({
      worker_id: workerId,
      direction: 'to_worker',
      message_type: 'answer',
      content: answer,
      response_to: questionId,
      status: 'acknowledged'
    });
    
    logger.info('Answer recorded', { questionId, answer: answer.substring(0, 50) });
    return data?.[0] || data;
  } catch (error) {
    logger.error('recordAnswer failed', { error: error.message });
    return null;
  }
}

/**
 * Process an answer and learn from it
 */
async function processAnswer(questionId, answer, learningService) {
  try {
    // Get the original question context
    const { data: question } = await db.from('dev_team_chat')
      .select('*')
      .eq('id', questionId)
      .single();
    
    if (!question) {
      logger.warn('Question not found for processing', { questionId });
      return null;
    }
    
    const context = typeof question.context_json === 'string' ? JSON.parse(question.context_json || '{}') : (question.context_json || {});
    
    // Record the answer
    await recordAnswer(questionId, answer);
    
    // If this was a term clarification, learn from it
    if (context.type === 'term_clarification' && context.term && learningService) {
      await learningService.learnTerm(context.term, answer, {
        source: 'user_confirmed',
        originalContext: context
      });
    }
    
    // If this was a confirmation and user said no, record feedback
    if (context.type === 'confirmation' && answer.toLowerCase() !== 'yes' && learningService) {
      await learningService.recordCorrection(
        context.suggestedRouting,
        answer,
        context.action
      );
    }
    
    return { processed: true, context };
  } catch (error) {
    logger.error('processAnswer failed', { error: error.message });
    return null;
  }
}

/**
 * Format routing for display
 */
function formatRouting(routing) {
  const parts = [];
  if (routing.client?.name) parts.push(routing.client.name);
  if (routing.platform?.name) parts.push(routing.platform.name);
  if (routing.project?.name) parts.push(routing.project.name);
  if (routing.type) parts.push(routing.type);
  
  return parts.length > 0 ? parts.join(' → ') : 'Unknown location';
}

/**
 * Mark all pending messages as read
 */
async function markAllRead() {
  try {
    const workerId = await getChadWorkerId();
    if (!workerId) return;
    
    await db.from('dev_team_chat')
      .update({ read_at: new Date().toISOString() })
      .eq('worker_id', workerId)
      .eq('direction', 'from_worker')
      .is('read_at', null);
  } catch (error) {
    logger.error('markAllRead failed', { error: error.message });
  }
}

module.exports = {
  askQuestion,
  askConfirmation,
  askAboutTerm,
  notify,
  getPendingQuestions,
  getMessages,
  recordAnswer,
  processAnswer,
  markAllRead,
  formatRouting
};
