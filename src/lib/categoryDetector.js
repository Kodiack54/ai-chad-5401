/**
 * Chad Category Detector
 * Suggests knowledge categories for Susan to confirm/override
 * Categories: decision, lesson, system, procedure, issue, reference, idea, log
 */

const { Logger } = require('./logger');
const logger = new Logger('Chad:CategoryDetector');

// Pattern-based detection rules with confidence weights
const CATEGORY_PATTERNS = {
  decision: {
    keywords: ['decided', 'chose', 'selected', 'going with', 'will use', 'opted for', 'picked', 'determined'],
    phrases: ['the decision', 'we decided', 'decision made', 'chose to', 'going to use'],
    contextClues: ['instead of', 'rather than', 'over', 'alternatives', 'tradeoff', 'vs'],
    weight: 0.85
  },
  lesson: {
    keywords: ['learned', 'realized', 'discovered', 'found out', 'turns out', 'gotcha', 'pitfall', 'mistake'],
    phrases: ['lesson learned', 'important to know', 'dont forget', 'remember to', 'next time', 'in the future'],
    contextClues: ['because', 'caused by', 'the reason', 'thats why', 'avoid'],
    weight: 0.80
  },
  system: {
    keywords: ['architecture', 'component', 'module', 'service', 'database', 'api', 'endpoint', 'schema'],
    phrases: ['how it works', 'system design', 'the flow', 'data flow', 'connects to', 'integrates with'],
    contextClues: ['structure', 'hierarchy', 'relationship', 'depends on'],
    weight: 0.75
  },
  procedure: {
    keywords: ['steps', 'process', 'workflow', 'deploy', 'setup', 'configure', 'install', 'run'],
    phrases: ['how to', 'in order to', 'first then', 'step by step', 'to do this'],
    contextClues: ['1.', '2.', '3.', 'first', 'second', 'then', 'finally', 'next'],
    weight: 0.80
  },
  issue: {
    keywords: ['bug', 'error', 'broken', 'failed', 'crash', 'issue', 'problem', 'wrong', 'fix'],
    phrases: ['not working', 'doesnt work', 'throwing error', 'keeps failing', 'needs fix'],
    contextClues: ['stack trace', 'exception', 'null', 'undefined', 'timeout'],
    weight: 0.90
  },
  reference: {
    keywords: ['port', 'path', 'url', 'credential', 'config', 'constant', 'endpoint', 'version'],
    phrases: ['located at', 'found in', 'stored in', 'the path is', 'runs on port'],
    contextClues: [':', '/', '@', '.env', 'localhost', 'http'],
    weight: 0.70
  },
  idea: {
    keywords: ['could', 'might', 'should', 'maybe', 'possibly', 'consider', 'future', 'someday'],
    phrases: ['what if', 'we could', 'it would be nice', 'for later', 'eventually', 'down the road'],
    contextClues: ['v2', 'phase 2', 'enhancement', 'improvement', 'optimization'],
    weight: 0.65
  },
  log: {
    keywords: ['did', 'completed', 'finished', 'worked on', 'updated', 'created', 'added', 'removed'],
    phrases: ['today i', 'this session', 'we worked', 'got done', 'made progress'],
    contextClues: ['session', 'today', 'yesterday', 'this morning'],
    weight: 0.50  // Low weight - its the fallback
  }
};

/**
 * Detect category from text content
 * Returns { category, confidence, signals }
 */
function detectCategory(text, context = {}) {
  const lowerText = text.toLowerCase();
  const scores = {};
  const signals = {};

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    let score = 0;
    let matchedSignals = [];

    // Check keywords
    for (const keyword of patterns.keywords) {
      if (lowerText.includes(keyword)) {
        score += 2;
        matchedSignals.push(`keyword:${keyword}`);
      }
    }

    // Check phrases (worth more)
    for (const phrase of patterns.phrases) {
      if (lowerText.includes(phrase)) {
        score += 4;
        matchedSignals.push(`phrase:${phrase}`);
      }
    }

    // Check context clues
    for (const clue of patterns.contextClues) {
      if (lowerText.includes(clue)) {
        score += 1;
        matchedSignals.push(`clue:${clue}`);
      }
    }

    // Apply category weight
    scores[category] = score * patterns.weight;
    signals[category] = matchedSignals;
  }

  // Apply context boosters from session metadata
  if (context.workType === 'bugfix') {
    scores.issue = (scores.issue || 0) + 5;
    scores.lesson = (scores.lesson || 0) + 3;
  }
  if (context.workType === 'planning') {
    scores.decision = (scores.decision || 0) + 4;
    scores.idea = (scores.idea || 0) + 3;
  }
  if (context.workType === 'research') {
    scores.system = (scores.system || 0) + 3;
    scores.reference = (scores.reference || 0) + 3;
  }

  // Find best category
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestCategory, bestScore] = sorted[0];
  const [secondCategory, secondScore] = sorted[1] || ['log', 0];

  // Calculate confidence (difference between top 2 scores normalized)
  const maxPossibleScore = 30; // Rough max
  const confidence = Math.min(0.95, Math.max(0.30, 
    ((bestScore - secondScore) / maxPossibleScore) + (bestScore / maxPossibleScore * 0.5)
  ));

  return {
    category: bestCategory,
    confidence: Math.round(confidence * 100) / 100,
    signals: signals[bestCategory],
    alternateCategory: secondScore > 0 ? secondCategory : null,
    allScores: scores
  };
}

/**
 * Categorize a discovery/knowledge item
 */
function categorizeDiscovery(discovery, sessionContext = {}) {
  const textToAnalyze = `${discovery.title || ''} ${discovery.insight || ''} ${discovery.applicability || ''}`;
  
  const detection = detectCategory(textToAnalyze, sessionContext);
  
  // Map old discovery.category to new system if it provides hints
  if (discovery.category) {
    const oldToNew = {
      'architecture': 'system',
      'pattern': 'system',
      'gotcha': 'lesson',
      'optimization': 'idea',
      'security': 'issue',
      'integration': 'system',
      'general': null
    };
    const mapped = oldToNew[discovery.category.toLowerCase()];
    if (mapped && detection.confidence < 0.7) {
      detection.category = mapped;
      detection.confidence = Math.max(detection.confidence, 0.60);
      detection.signals.push(`legacy_category:${discovery.category}`);
    }
  }
  
  return detection;
}

/**
 * Categorize a decision
 */
function categorizeDecision(decision, sessionContext = {}) {
  // Decisions are almost always... decisions. But check for lessons
  const textToAnalyze = `${decision.what || ''} ${decision.why || ''} ${decision.impact || ''}`;
  
  if (textToAnalyze.toLowerCase().includes('learned') || 
      textToAnalyze.toLowerCase().includes('realized') ||
      textToAnalyze.toLowerCase().includes('mistake')) {
    return {
      category: 'lesson',
      confidence: 0.75,
      signals: ['decision_with_learning']
    };
  }
  
  return {
    category: 'decision',
    confidence: 0.90,
    signals: ['explicit_decision_object']
  };
}

/**
 * Categorize a problem/bug
 */
function categorizeProblem(problem, sessionContext = {}) {
  const textToAnalyze = `${problem.description || ''} ${problem.rootCause || ''} ${problem.solution || ''}`;
  
  // Fixed problems with root cause become lessons
  if (problem.status === 'fixed' && problem.rootCause) {
    return {
      category: 'lesson',
      confidence: 0.80,
      signals: ['fixed_bug_with_root_cause']
    };
  }
  
  // Unresolved bugs are issues
  return {
    category: 'issue',
    confidence: 0.85,
    signals: ['problem_object']
  };
}

/**
 * Batch categorize all extracted items
 * Returns items with suggested categories for Susan
 */
function categorizeExtraction(extraction) {
  const sessionContext = {
    workType: extraction.sessionSummary?.workType || 'unknown'
  };
  
  const categorized = {
    knowledge: [],
    decisionsAsKnowledge: [],
    issuesAsKnowledge: []
  };
  
  // Categorize discoveries
  for (const discovery of (extraction.discoveries || [])) {
    const cat = categorizeDiscovery(discovery, sessionContext);
    categorized.knowledge.push({
      ...discovery,
      suggestedCategory: cat.category,
      categoryConfidence: cat.confidence,
      categorySignals: cat.signals,
      alternateCategory: cat.alternateCategory
    });
  }
  
  // Decisions become decision/lesson knowledge
  for (const decision of (extraction.decisions || [])) {
    const cat = categorizeDecision(decision, sessionContext);
    categorized.decisionsAsKnowledge.push({
      title: decision.what,
      summary: decision.why,
      impact: decision.impact,
      alternatives: decision.alternatives,
      suggestedCategory: cat.category,
      categoryConfidence: cat.confidence,
      categorySignals: cat.signals
    });
  }
  
  // Problems become issue/lesson knowledge
  for (const problem of (extraction.problems || [])) {
    const cat = categorizeProblem(problem, sessionContext);
    categorized.issuesAsKnowledge.push({
      title: problem.description,
      summary: problem.rootCause || problem.solution || '',
      status: problem.status,
      files: problem.relatedFiles,
      suggestedCategory: cat.category,
      categoryConfidence: cat.confidence,
      categorySignals: cat.signals
    });
  }
  
  logger.info('Categorization complete', {
    discoveries: categorized.knowledge.length,
    decisions: categorized.decisionsAsKnowledge.length,
    issues: categorized.issuesAsKnowledge.length
  });
  
  return categorized;
}

module.exports = {
  detectCategory,
  categorizeDiscovery,
  categorizeDecision,
  categorizeProblem,
  categorizeExtraction,
  CATEGORY_PATTERNS
};
