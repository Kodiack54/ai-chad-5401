/**
 * Chad Learning Service
 * Learns from user feedback to improve context detection over time
 */

const db = require('../lib/db');
const { Logger } = require('../lib/logger');
const { getChadWorkerId, invalidateCache } = require('./contextDetector');

const logger = new Logger('Chad:Learning');

/**
 * Learn a new term → routing mapping from user feedback
 */
async function learnTerm(term, routingAnswer, options = {}) {
  try {
    const workerId = await getChadWorkerId();
    if (!workerId) {
      logger.error('Cannot learn - Chad worker ID not found');
      return null;
    }
    
    // Parse the routing answer to find what it maps to
    const routing = await parseRoutingAnswer(routingAnswer);
    
    if (!routing) {
      logger.warn('Could not parse routing from answer', { term, answer: routingAnswer });
      return null;
    }
    
    // Check if we already have this term
    const { data: existing } = await db.from('dev_worker_vocabulary')
      .select('*')
      .eq('worker_id', workerId)
      .eq('term', term.toLowerCase())
      .single();
    
    if (existing) {
      // Update existing entry with higher confidence
      const newConfidence = Math.min(0.99, (parseFloat(existing.confidence) || 0.5) + 0.15);
      
      await db.from('dev_worker_vocabulary')
        .update({
          maps_to_client: routing.client_id || existing.maps_to_client,
          maps_to_platform: routing.platform_id || existing.maps_to_platform,
          maps_to_project: routing.project_id || existing.maps_to_project,
          maps_to_path: routing.path_id || existing.maps_to_path,
          maps_to_type: routing.type || existing.maps_to_type,
          confidence: newConfidence,
          source: 'user_confirmed',
          correct_count: (existing.correct_count || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id);
      
      logger.info('Updated vocabulary entry', { term, confidence: newConfidence });
    } else {
      // Create new entry
      const { data } = await db.from('dev_worker_vocabulary').insert({
        worker_id: workerId,
        term: term.toLowerCase(),
        maps_to_client: routing.client_id,
        maps_to_platform: routing.platform_id,
        maps_to_project: routing.project_id,
        maps_to_path: routing.path_id,
        maps_to_type: routing.type,
        confidence: 0.85, // Start with good confidence since user confirmed
        source: 'user_confirmed',
        usage_count: 1,
        correct_count: 1
      });
      
      logger.info('Created new vocabulary entry', { term, routing });
    }
    
    // Invalidate cache so new term is picked up
    invalidateCache();
    
    return { success: true, term, routing };
  } catch (error) {
    logger.error('learnTerm failed', { error: error.message });
    return null;
  }
}

/**
 * Parse user's routing answer to find client/platform/project IDs
 */
async function parseRoutingAnswer(answer) {
  const answerLower = answer.toLowerCase();
  
  // Try to match against known clients
  const { data: clients } = await db.from('dev_clients').select('id, name, slug');
  for (const client of (clients || [])) {
    if (answerLower.includes(client.slug) || answerLower.includes(client.name.toLowerCase())) {
      // Found client, now check for platform
      const { data: platforms } = await db.from('dev_platforms')
        .select('id, name, slug')
        .eq('client_id', client.id);
      
      for (const platform of (platforms || [])) {
        if (answerLower.includes(platform.slug) || answerLower.includes(platform.name.toLowerCase())) {
          return {
            client_id: client.id,
            platform_id: platform.id
          };
        }
      }
      
      // Client found but no specific platform
      return { client_id: client.id };
    }
  }
  
  // Try to match against platforms directly
  const { data: platforms } = await db.from('dev_platforms').select('id, name, slug, client_id');
  for (const platform of (platforms || [])) {
    if (answerLower.includes(platform.slug) || answerLower.includes(platform.name.toLowerCase())) {
      return {
        client_id: platform.client_id,
        platform_id: platform.id
      };
    }
  }
  
  // Try to match against projects
  const { data: projects } = await db.from('dev_projects').select('id, name, slug, platform_id');
  for (const project of (projects || [])) {
    if (answerLower.includes(project.slug) || answerLower.includes(project.name.toLowerCase())) {
      // Get platform info
      if (project.platform_id) {
        const { data: platform } = await db.from('dev_platforms')
          .select('id, client_id')
          .eq('id', project.platform_id)
          .single();
        
        return {
          client_id: platform?.client_id,
          platform_id: project.platform_id,
          project_id: project.id
        };
      }
      return { project_id: project.id };
    }
  }
  
  return null;
}

/**
 * Record a correction when Chad routed something wrong
 */
async function recordCorrection(originalRouting, correctAnswer, action) {
  try {
    const workerId = await getChadWorkerId();
    if (!workerId) return null;
    
    // Record the feedback
    const { data } = await db.from('dev_worker_feedback').insert({
      worker_id: workerId,
      feedback_type: 'correction',
      category: 'routing',
      original_output: JSON.stringify(originalRouting),
      corrected_to: correctAnswer,
      user_message: action,
      applied: false,
      learned: false
    });
    
    // Update confidence scores for the domain
    await updateConfidence(workerId, 'routing', false);
    
    logger.info('Correction recorded', { original: originalRouting, corrected: correctAnswer });
    return data;
  } catch (error) {
    logger.error('recordCorrection failed', { error: error.message });
    return null;
  }
}

/**
 * Record positive feedback (Chad got it right)
 */
async function recordSuccess(routing, action) {
  try {
    const workerId = await getChadWorkerId();
    if (!workerId) return;
    
    // Update confidence scores
    await updateConfidence(workerId, 'routing', true);
    
    logger.debug('Success recorded', { routing });
  } catch (error) {
    logger.error('recordSuccess failed', { error: error.message });
  }
}

/**
 * Update confidence score for a domain
 */
async function updateConfidence(workerId, domain, wasCorrect) {
  try {
    // Get or create confidence entry
    const { data: existing } = await db.from('dev_worker_confidence')
      .select('*')
      .eq('worker_id', workerId)
      .eq('domain', domain)
      .single();
    
    if (existing) {
      const newTotal = (existing.total_attempts || 0) + 1;
      const newCorrect = wasCorrect ? (existing.correct_count || 0) + 1 : existing.correct_count;
      const newConfidence = newTotal > 0 ? (newCorrect / newTotal) : 0.5;
      
      await db.from('dev_worker_confidence')
        .update({
          total_attempts: newTotal,
          correct_count: newCorrect,
          confidence: Math.min(0.99, newConfidence),
          last_feedback: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id);
    } else {
      await db.from('dev_worker_confidence').insert({
        worker_id: workerId,
        domain: domain,
        total_attempts: 1,
        correct_count: wasCorrect ? 1 : 0,
        confidence: wasCorrect ? 0.60 : 0.40,
        last_feedback: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('updateConfidence failed', { error: error.message });
  }
}

/**
 * Get Chad's confidence in a domain
 */
async function getConfidence(domain) {
  try {
    const workerId = await getChadWorkerId();
    if (!workerId) return 0.5;
    
    const { data } = await db.from('dev_worker_confidence')
      .select('confidence')
      .eq('worker_id', workerId)
      .eq('domain', domain)
      .single();
    
    return data?.confidence || 0.5;
  } catch (error) {
    return 0.5;
  }
}

/**
 * Get learning stats for Chad
 */
async function getStats() {
  try {
    const workerId = await getChadWorkerId();
    if (!workerId) return null;
    
    const [vocabResult, feedbackResult, confidenceResult] = await Promise.all([
      db.from('dev_worker_vocabulary').select('*').eq('worker_id', workerId),
      db.from('dev_worker_feedback').select('*').eq('worker_id', workerId),
      db.from('dev_worker_confidence').select('*').eq('worker_id', workerId)
    ]);
    
    const vocab = vocabResult.data || [];
    const feedback = feedbackResult.data || [];
    const confidence = confidenceResult.data || [];
    
    return {
      vocabularyCount: vocab.length,
      avgVocabConfidence: vocab.length > 0 
        ? vocab.reduce((sum, v) => sum + parseFloat(v.confidence || 0), 0) / vocab.length 
        : 0,
      correctionsCount: feedback.filter(f => f.feedback_type === 'correction').length,
      praiseCount: feedback.filter(f => f.feedback_type === 'praise').length,
      domainConfidences: confidence.reduce((acc, c) => {
        acc[c.domain] = parseFloat(c.confidence);
        return acc;
      }, {})
    };
  } catch (error) {
    logger.error('getStats failed', { error: error.message });
    return null;
  }
}

module.exports = {
  learnTerm,
  parseRoutingAnswer,
  recordCorrection,
  recordSuccess,
  updateConfidence,
  getConfidence,
  getStats
};
