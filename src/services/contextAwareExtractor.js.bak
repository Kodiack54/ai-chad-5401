/**
 * Context-Aware Extractor
 * Wraps the smart extractor with context detection and learning
 */

const { extractSmart, toSusanFormat } = require('../lib/smartExtractor');
const { detectContext, recordVocabularyUsage } = require('./contextDetector');
const { askAboutTerm, askConfirmation, notify } = require('./teamChat');
const { recordSuccess } = require('./learningService');
const { Logger } = require('../lib/logger');
const db = require('../lib/db');

const logger = new Logger('Chad:ContextAwareExtractor');

/**
 * Extract with context awareness
 * - Detects project/platform from file paths and keywords
 * - Asks questions when unsure
 * - Tags extractions with routing info
 */
async function extractWithContext(conversationText, options = {}) {
  const { projectPath, previousContext, skipQuestions = false } = options;
  
  try {
    // Step 1: Detect context from the conversation
    const contextResult = await detectContext(conversationText, { includeMetadata: true });
    
    logger.info('Context detection result', {
      detected: contextResult.detected,
      confidence: contextResult.confidence,
      source: contextResult.source,
      needsQuestion: contextResult.needsQuestion
    });
    
    // Step 2: Run the smart extraction
    const extraction = await extractSmart(conversationText, projectPath, previousContext);
    
    if (!extraction) {
      logger.warn('Smart extraction returned null');
      return null;
    }
    
    // Step 3: Attach routing context to the extraction
    const contextualExtraction = {
      ...extraction,
      routing: contextResult.routing,
      routingConfidence: contextResult.confidence,
      routingSource: contextResult.source,
      routingMatched: contextResult.matched
    };
    
    // Step 4: Handle low confidence situations
    if (contextResult.needsQuestion && !skipQuestions) {
      // Find key terms that we're unsure about
      const uncertainTerms = findUncertainTerms(conversationText, contextResult);
      
      if (uncertainTerms.length > 0 && contextResult.confidence < 0.5) {
        // Very uncertain - ask about the context
        await askAboutTerm(
          uncertainTerms[0],
          await getPossibleProjects(),
          { 
            extractionId: extraction.id,
            conversationSnippet: conversationText.substring(0, 200)
          }
        );
      } else if (contextResult.confidence >= 0.5 && contextResult.confidence < 0.75) {
        // Somewhat confident - ask for confirmation
        const actionSummary = summarizeExtraction(extraction);
        await askConfirmation(actionSummary, contextResult.routing, {
          extractionId: extraction.id
        });
      }
    }
    
    // Step 5: If high confidence, record success for learning
    if (contextResult.confidence >= 0.75) {
      await recordSuccess(contextResult.routing, 'extraction');
      
      // Update vocabulary usage if it was a learned term
      if (contextResult.source === 'learned_vocabulary' && contextResult.allMatches) {
        const vocabMatch = contextResult.allMatches.find(m => m.vocabulary_id);
        if (vocabMatch) {
          await recordVocabularyUsage(vocabMatch.vocabulary_id, true);
        }
      }
    }
    
    return contextualExtraction;
    
  } catch (error) {
    logger.error('Context-aware extraction failed', { error: error.message });
    return null;
  }
}

/**
 * Find terms in the conversation that we're uncertain about
 */
function findUncertainTerms(text, contextResult) {
  const terms = [];
  
  // Look for project-related words that aren't in our vocabulary
  const projectWords = text.match(/\b(project|app|feature|system|service|module|component)\s+\w+/gi) || [];
  
  for (const match of projectWords) {
    const term = match.split(/\s+/)[1];
    if (term && term.length > 2) {
      terms.push(term);
    }
  }
  
  // If we have low-confidence matches, include those terms
  if (contextResult.allMatches) {
    for (const match of contextResult.allMatches) {
      if (match.confidence < 0.6 && match.matched) {
        terms.push(match.matched);
      }
    }
  }
  
  return [...new Set(terms)].slice(0, 3); // Max 3 terms
}

/**
 * Get list of possible projects for question options
 */
async function getPossibleProjects() {
  try {
    const { data: platforms } = await db.from('dev_platforms')
      .select('id, name, slug')
      .eq('active', true);
    
    return (platforms || []).map(p => ({
      id: p.id,
      label: p.name,
      slug: p.slug
    }));
  } catch (error) {
    return [];
  }
}

/**
 * Create a summary of what was extracted
 */
function summarizeExtraction(extraction) {
  const parts = [];
  
  if (extraction.todos?.length > 0) {
    parts.push(`${extraction.todos.length} todo(s)`);
  }
  if (extraction.discoveries?.length > 0) {
    parts.push(`${extraction.discoveries.length} knowledge item(s)`);
  }
  if (extraction.problems?.length > 0) {
    parts.push(`${extraction.problems.length} bug(s)`);
  }
  if (extraction.decisions?.length > 0) {
    parts.push(`${extraction.decisions.length} decision(s)`);
  }
  
  return parts.length > 0 ? parts.join(', ') : 'session data';
}

/**
 * Convert to Susan format with routing attached
 */
function toSusanFormatWithRouting(extraction) {
  const susanFormat = toSusanFormat(extraction);
  
  return {
    ...susanFormat,
    routing: extraction.routing,
    routingConfidence: extraction.routingConfidence,
    routingSource: extraction.routingSource
  };
}

module.exports = {
  extractWithContext,
  toSusanFormatWithRouting,
  findUncertainTerms,
  summarizeExtraction
};
