/**
 * Chad Context Detector
 * Detects project/platform/client context from file paths, keywords, and learned vocabulary
 */

const db = require('../lib/db');
const { Logger } = require('../lib/logger');

const logger = new Logger('Chad:ContextDetector');

// Cache for patterns and vocabulary (refreshed periodically)
let patternCache = null;
let vocabularyCache = null;
let chadWorkerId = null;
let lastCacheRefresh = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Get Chad's worker ID
 */
async function getChadWorkerId() {
  if (chadWorkerId) return chadWorkerId;
  
  const { data, error } = await db.from('dev_ai_workers')
    .select('id')
    .eq('slug', 'chad')
    .single();
  
  if (data) {
    chadWorkerId = data.id;
  }
  return chadWorkerId;
}

/**
 * Refresh caches if stale
 */
async function refreshCaches() {
  const now = Date.now();
  if (patternCache && vocabularyCache && (now - lastCacheRefresh) < CACHE_TTL) {
    return;
  }
  
  // Load context patterns
  const { data: patterns } = await db.from('dev_context_patterns')
    .select('*')
    .eq('active', true)
    .order('priority', { ascending: false });
  
  patternCache = patterns || [];
  
  // Load Chad's vocabulary
  const workerId = await getChadWorkerId();
  if (workerId) {
    const { data: vocab } = await db.from('dev_worker_vocabulary')
      .select('*')
      .eq('worker_id', workerId)
      .order('confidence', { ascending: false });
    
    vocabularyCache = vocab || [];
  } else {
    vocabularyCache = [];
  }
  
  lastCacheRefresh = now;
  logger.debug('Caches refreshed', { patterns: patternCache.length, vocabulary: vocabularyCache.length });
}

/**
 * Detect context from file paths in the conversation
 */
async function detectFromFilePaths(text) {
  await refreshCaches();
  
  const results = [];
  
  // Extract file paths from text
  const pathMatches = text.match(/\/var\/www\/[^\s\n\r"'`]+/g) || [];
  const uniquePaths = [...new Set(pathMatches)];
  
  for (const filePath of uniquePaths) {
    // Check against patterns (highest priority first - already sorted)
    for (const pattern of patternCache.filter(p => p.pattern_type === 'file_path')) {
      if (filePath.startsWith(pattern.pattern)) {
        results.push({
          source: 'file_path',
          matched: filePath,
          pattern: pattern.pattern,
          client_id: pattern.maps_to_client,
          platform_id: pattern.maps_to_platform,
          project_id: pattern.maps_to_project,
          confidence: 0.95, // High confidence for file path matches
          priority: pattern.priority
        });
        break; // First match wins (highest priority)
      }
    }
  }
  
  return results;
}

/**
 * Detect context from keywords in the conversation
 */
async function detectFromKeywords(text) {
  await refreshCaches();
  
  const results = [];
  const textLower = text.toLowerCase();
  
  // Check keyword patterns from context_patterns table
  for (const pattern of patternCache.filter(p => p.pattern_type === 'keyword')) {
    const regex = new RegExp(pattern.pattern, 'i');
    if (regex.test(textLower)) {
      results.push({
        source: 'keyword_pattern',
        matched: pattern.pattern,
        client_id: pattern.maps_to_client,
        platform_id: pattern.maps_to_platform,
        project_id: pattern.maps_to_project,
        confidence: 0.70, // Medium confidence for keyword patterns
        priority: pattern.priority
      });
    }
  }
  
  // Check learned vocabulary
  for (const vocab of vocabularyCache) {
    let matched = false;
    
    // Check exact term
    if (textLower.includes(vocab.term.toLowerCase())) {
      matched = true;
    }
    
    // Check pattern if exists
    if (!matched && vocab.pattern) {
      const regex = new RegExp(vocab.pattern, 'i');
      if (regex.test(textLower)) {
        matched = true;
      }
    }
    
    if (matched) {
      results.push({
        source: 'learned_vocabulary',
        matched: vocab.term,
        vocabulary_id: vocab.id,
        client_id: vocab.maps_to_client,
        platform_id: vocab.maps_to_platform,
        project_id: vocab.maps_to_project,
        path_id: vocab.maps_to_path,
        type: vocab.maps_to_type,
        confidence: parseFloat(vocab.confidence) || 0.50,
        context_hint: vocab.context_hint
      });
    }
  }
  
  return results;
}

/**
 * Main detection function - combines all sources
 */
async function detectContext(text, options = {}) {
  const { includeMetadata = false } = options;
  
  try {
    // Run all detection methods
    const [filePathResults, keywordResults] = await Promise.all([
      detectFromFilePaths(text),
      detectFromKeywords(text)
    ]);
    
    const allResults = [...filePathResults, ...keywordResults];
    
    if (allResults.length === 0) {
      return {
        detected: false,
        confidence: 0,
        routing: null,
        needsQuestion: true,
        message: 'No context detected - recommend asking user'
      };
    }
    
    // Sort by confidence (highest first)
    allResults.sort((a, b) => b.confidence - a.confidence);
    
    // Get the best match
    const best = allResults[0];
    
    // Load names for the routing
    let routing = {
      client_id: best.client_id,
      platform_id: best.platform_id,
      project_id: best.project_id,
      path_id: best.path_id,
      type: best.type
    };
    
    if (includeMetadata) {
      // Fetch client/platform names
      if (best.client_id) {
        const { data: client } = await db.from('dev_clients')
          .select('name, slug')
          .eq('id', best.client_id)
          .single();
        if (client) routing.client = client;
      }
      
      if (best.platform_id) {
        const { data: platform } = await db.from('dev_platforms')
          .select('name, slug')
          .eq('id', best.platform_id)
          .single();
        if (platform) routing.platform = platform;
      }
      
      if (best.project_id) {
        const { data: project } = await db.from('dev_projects')
          .select('name, slug')
          .eq('id', best.project_id)
          .single();
        if (project) routing.project = project;
      }
    }
    
    // Determine if confidence is high enough or if we should ask
    const CONFIDENCE_THRESHOLD = 0.75;
    const needsQuestion = best.confidence < CONFIDENCE_THRESHOLD;
    
    return {
      detected: true,
      confidence: best.confidence,
      routing,
      source: best.source,
      matched: best.matched,
      needsQuestion,
      allMatches: allResults,
      message: needsQuestion 
        ? `Detected ${best.matched} but confidence is ${(best.confidence * 100).toFixed(0)}% - recommend confirming with user`
        : `High confidence match: ${best.matched}`
    };
    
  } catch (error) {
    logger.error('Context detection failed', { error: error.message });
    return {
      detected: false,
      confidence: 0,
      routing: null,
      needsQuestion: true,
      error: error.message
    };
  }
}

/**
 * Update vocabulary usage stats when a term is matched
 */
async function recordVocabularyUsage(vocabularyId, wasCorrect = true) {
  try {
    const { data: current } = await db.from('dev_worker_vocabulary')
      .select('usage_count, correct_count, confidence')
      .eq('id', vocabularyId)
      .single();
    
    if (current) {
      const newUsage = (current.usage_count || 0) + 1;
      const newCorrect = wasCorrect ? (current.correct_count || 0) + 1 : current.correct_count;
      
      // Recalculate confidence based on accuracy
      const newConfidence = newUsage > 0 ? (newCorrect / newUsage) : 0.5;
      
      await db.from('dev_worker_vocabulary')
        .update({
          usage_count: newUsage,
          correct_count: newCorrect,
          confidence: Math.min(0.99, newConfidence),
          last_used: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', vocabularyId);
    }
  } catch (error) {
    logger.error('Failed to record vocabulary usage', { error: error.message });
  }
}

/**
 * Force cache refresh
 */
function invalidateCache() {
  lastCacheRefresh = 0;
}

module.exports = {
  detectContext,
  detectFromFilePaths,
  detectFromKeywords,
  recordVocabularyUsage,
  invalidateCache,
  getChadWorkerId
};
