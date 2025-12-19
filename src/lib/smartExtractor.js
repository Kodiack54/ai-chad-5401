/**
 * Chad Smart Extractor
 * Enhanced AI-powered extraction that understands context and relationships
 */

const { chat } = require('./openai');
const { Logger } = require('./logger');

const logger = new Logger('Chad:SmartExtractor');

/**
 * Clean up common JSON issues from AI responses
 */
function cleanJsonResponse(text) {
  let jsonStr = text;
  
  // Try to extract JSON from markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  } else {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      jsonStr = text.slice(start, end + 1);
    }
  }
  
  // Fix common AI JSON mistakes
  jsonStr = jsonStr
    .replace(/,(\s*[\]\}])/g, '$1')           // Remove trailing commas
    .replace(/\/\/.*$/gm, '')                  // Remove comments
    .replace(/[\x00-\x1F\x7F]/g, ' ')          // Remove control chars
    .replace(/\n/g, ' ')                       // Flatten newlines
    .replace(/\t/g, ' ');                      // Flatten tabs
  
  return jsonStr.trim();
}

/**
 * Try multiple parsing strategies
 */
function parseJsonSafe(text) {
  // Strategy 1: Direct parse
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    logger.debug('Direct parse failed', { error: e.message });
  }
  
  // Strategy 2: Clean and parse
  try {
    const cleaned = cleanJsonResponse(text);
    return JSON.parse(cleaned);
  } catch (e) {
    logger.debug('Cleaned parse failed', { error: e.message });
  }
  
  // Strategy 3: Regex extraction fallback
  try {
    const result = {
      sessionSummary: { workType: 'unknown', mainGoal: '', outcome: 'ongoing', keyInsight: '' },
      problems: [],
      decisions: [],
      codeChanges: [],
      discoveries: [],
      todos: [],
      completedItems: [],
      dependencies: [],
      continuity: { inProgress: '', nextSteps: [], blockers: [], questionsOpen: [] }
    };
    
    // Extract todos
    const todoMatches = [...text.matchAll(/"task"\s*:\s*"([^"]+)"/g)];
    for (const match of todoMatches) {
      result.todos.push({ task: match[1], priority: 'medium', context: '' });
    }
    
    // Extract discoveries/knowledge
    const insightMatches = [...text.matchAll(/"insight"\s*:\s*"([^"]+)"/g)];
    const titleMatches = [...text.matchAll(/"title"\s*:\s*"([^"]+)"/g)];
    for (let i = 0; i < insightMatches.length; i++) {
      result.discoveries.push({ 
        title: titleMatches[i]?.[1] || 'Discovery', 
        insight: insightMatches[i][1],
        category: 'general'
      });
    }
    
    // Extract problems/bugs
    const problemMatches = [...text.matchAll(/"description"\s*:\s*"([^"]+)"/g)];
    for (const match of problemMatches) {
      if (match[1].length > 10) {
        result.problems.push({ description: match[1], status: 'open', relatedFiles: [] });
      }
    }
    
    // Extract main goal
    const goalMatch = text.match(/"mainGoal"\s*:\s*"([^"]+)"/);
    if (goalMatch) result.sessionSummary.mainGoal = goalMatch[1];
    
    // Extract key insight
    const keyMatch = text.match(/"keyInsight"\s*:\s*"([^"]+)"/);
    if (keyMatch) result.sessionSummary.keyInsight = keyMatch[1];
    
    // Extract work type
    const typeMatch = text.match(/"workType"\s*:\s*"([^"]+)"/);
    if (typeMatch) result.sessionSummary.workType = typeMatch[1];
    
    // Extract decisions
    const whatMatches = [...text.matchAll(/"what"\s*:\s*"([^"]+)"/g)];
    const whyMatches = [...text.matchAll(/"why"\s*:\s*"([^"]+)"/g)];
    for (let i = 0; i < whatMatches.length; i++) {
      result.decisions.push({
        what: whatMatches[i][1],
        why: whyMatches[i]?.[1] || '',
        alternatives: '',
        impact: ''
      });
    }
    
    const hasData = result.todos.length > 0 || 
                    result.discoveries.length > 0 || 
                    result.problems.length > 0 ||
                    result.decisions.length > 0 ||
                    result.sessionSummary.mainGoal;
    
    if (hasData) {
      logger.info('Regex fallback extracted data', {
        todos: result.todos.length,
        discoveries: result.discoveries.length,
        problems: result.problems.length,
        decisions: result.decisions.length
      });
      return result;
    }
  } catch (e) {
    logger.error('Regex extraction failed', { error: e.message });
  }
  
  return null;
}

/**
 * Build a smart extraction prompt that captures deeper meaning
 */
function buildExtractionPrompt(conversationText, projectPath, previousContext = null) {
  return `You are Chad, an AI assistant specialized in understanding development conversations.
Your job is to extract MEANINGFUL information that helps the team understand what happened and why.

PROJECT: ${projectPath}

${previousContext ? `PREVIOUS SESSION CONTEXT:\n${previousContext}\n` : ''}

CONVERSATION TO ANALYZE:
${conversationText.slice(0, 15000)}

EXTRACTION INSTRUCTIONS:
Think deeply about this conversation. Don't just list surface-level items.
Ask yourself:
- What was the developer trying to accomplish? (the goal)
- What problems did they encounter? (the obstacles)
- What solutions were found? (the breakthroughs)
- What decisions were made and WHY? (the reasoning)
- What's still unfinished? (the continuity)

Extract as JSON (MUST be valid JSON with no trailing commas):

{
  "sessionSummary": {
    "workType": "feature|bugfix|refactor|research|config|deployment|planning",
    "mainGoal": "What was the primary objective of this session?",
    "outcome": "success|partial|blocked|ongoing",
    "keyInsight": "The most important thing learned or accomplished"
  },
  "problems": [
    {
      "description": "What went wrong or was challenging",
      "rootCause": "Why it happened (if discovered)",
      "solution": "How it was fixed (if fixed)",
      "status": "fixed|workaround|unresolved",
      "relatedFiles": ["files involved"]
    }
  ],
  "decisions": [
    {
      "what": "The decision made",
      "why": "The reasoning behind it",
      "alternatives": "What other options were considered",
      "impact": "What this affects going forward"
    }
  ],
  "codeChanges": [
    {
      "file": "path/to/file",
      "action": "created|modified|deleted|renamed",
      "purpose": "WHY this change was made",
      "details": "Key changes"
    }
  ],
  "discoveries": [
    {
      "category": "architecture|pattern|gotcha|optimization|security|integration",
      "title": "Short title",
      "insight": "What was learned",
      "applicability": "When this knowledge is useful"
    }
  ],
  "todos": [
    {
      "task": "What needs to be done",
      "context": "Why it's needed",
      "priority": "high|medium|low",
      "blockedBy": "What blocking this if anything",
      "relatedTo": "Related feature or component"
    }
  ],
  "completedItems": [
    {
      "task": "What was finished",
      "verifiedBy": "How we know it is done"
    }
  ],
  "continuity": {
    "inProgress": "What is actively being worked on",
    "nextSteps": ["Logical next actions"],
    "blockers": ["What is preventing progress"],
    "questionsOpen": ["Unanswered questions"]
  }
}

CRITICAL: Return ONLY valid JSON. No markdown, no comments, no trailing commas.`;
}

/**
 * Extract smart insights from conversation
 */
async function extractSmart(conversationText, projectPath, previousContext = null) {
  const prompt = buildExtractionPrompt(conversationText, projectPath, previousContext);
  
  try {
    const response = await chat(prompt, { 
      extractionMode: true,
      maxTokens: 4000
    });
    
    const extracted = parseJsonSafe(response);
    
    if (extracted) {
      return validateExtraction(extracted);
    }
    
    logger.warn('All JSON parsing strategies failed');
    return null;
  } catch (err) {
    logger.error('Smart extraction failed', { error: err.message });
    return null;
  }
}

/**
 * Validate and normalize extraction output
 */
function validateExtraction(data) {
  const defaults = {
    sessionSummary: {
      workType: 'unknown',
      mainGoal: '',
      outcome: 'ongoing',
      keyInsight: ''
    },
    problems: [],
    decisions: [],
    codeChanges: [],
    discoveries: [],
    todos: [],
    completedItems: [],
    dependencies: [],
    continuity: {
      inProgress: '',
      nextSteps: [],
      blockers: [],
      questionsOpen: []
    }
  };
  
  return {
    ...defaults,
    ...data,
    sessionSummary: { ...defaults.sessionSummary, ...data.sessionSummary },
    continuity: { ...defaults.continuity, ...data.continuity }
  };
}

/**
 * Convert smart extraction to Susan's expected format
 */
function toSusanFormat(smartData) {
  return {
    todos: (smartData.todos || []).map(t => ({
      title: t.task,
      description: t.context,
      priority: t.priority || 'medium',
      blockedBy: t.blockedBy,
      relatedTo: t.relatedTo
    })),
    
    completedTodos: (smartData.completedItems || []).map(c => ({
      title: c.task,
      verifiedBy: c.verifiedBy
    })),
    
    decisions: (smartData.decisions || []).map(d => ({
      title: d.what,
      rationale: d.why,
      alternatives: d.alternatives,
      impact: d.impact
    })),
    
    knowledge: (smartData.discoveries || []).map(d => ({
      category: d.category,
      title: d.title,
      summary: d.insight,
      applicability: d.applicability
    })),
    
    codeChanges: smartData.codeChanges || [],
    
    bugs: (smartData.problems || []).filter(p => p.status !== 'fixed').map(p => ({
      title: p.description,
      severity: 'medium',
      status: p.status === 'unresolved' ? 'open' : 'in_progress',
      rootCause: p.rootCause,
      relatedFiles: p.relatedFiles
    })),
    
    sessionSummary: smartData.sessionSummary,
    continuity: smartData.continuity,
    dependencies: smartData.dependencies || []
  };
}

module.exports = {
  extractSmart,
  toSusanFormat,
  buildExtractionPrompt,
  parseJsonSafe,
  cleanJsonResponse
};

// Import category detector
const { categorizeExtraction } = require('./categoryDetector');

/**
 * Enhanced toSusanFormat with category suggestions
 * Chad suggests, Susan confirms/overrides
 */
function toSusanFormatWithCategories(smartData) {
  // Get categorized data
  const categorized = categorizeExtraction(smartData);
  
  return {
    // Standard format
    todos: (smartData.todos || []).map(t => ({
      title: t.task,
      description: t.context,
      priority: t.priority || 'medium',
      blockedBy: t.blockedBy,
      relatedTo: t.relatedTo
    })),
    
    completedTodos: (smartData.completedItems || []).map(c => ({
      title: c.task,
      verifiedBy: c.verifiedBy
    })),
    
    codeChanges: smartData.codeChanges || [],
    sessionSummary: smartData.sessionSummary,
    continuity: smartData.continuity,
    dependencies: smartData.dependencies || [],
    
    // NEW: Categorized knowledge items for Susan
    knowledgeItems: [
      ...categorized.knowledge.map(k => ({
        title: k.title,
        summary: k.insight,
        fullContent: k.applicability,
        suggestedCategory: k.suggestedCategory,
        categoryConfidence: k.categoryConfidence,
        categorySignals: k.categorySignals,
        alternateCategory: k.alternateCategory,
        sourceType: 'discovery'
      })),
      ...categorized.decisionsAsKnowledge.map(d => ({
        title: d.title,
        summary: d.summary,
        fullContent: `Alternatives: ${d.alternatives || 'None considered'}. Impact: ${d.impact || 'Unknown'}`,
        suggestedCategory: d.suggestedCategory,
        categoryConfidence: d.categoryConfidence,
        categorySignals: d.categorySignals,
        sourceType: 'decision'
      })),
      ...categorized.issuesAsKnowledge.map(i => ({
        title: i.title,
        summary: i.summary,
        fullContent: i.files?.join(', ') || '',
        suggestedCategory: i.suggestedCategory,
        categoryConfidence: i.categoryConfidence,
        categorySignals: i.categorySignals,
        sourceType: 'issue',
        issueStatus: i.status
      }))
    ],
    
    // Keep legacy format for backwards compatibility
    decisions: (smartData.decisions || []).map(d => ({
      title: d.what,
      rationale: d.why,
      alternatives: d.alternatives,
      impact: d.impact
    })),
    
    knowledge: (smartData.discoveries || []).map(d => ({
      category: d.category,
      title: d.title,
      summary: d.insight,
      applicability: d.applicability
    })),
    
    bugs: (smartData.problems || []).filter(p => p.status !== 'fixed').map(p => ({
      title: p.description,
      severity: 'medium',
      status: p.status === 'unresolved' ? 'open' : 'in_progress',
      rootCause: p.rootCause,
      relatedFiles: p.relatedFiles
    }))
  };
}

// Export new function
module.exports.toSusanFormatWithCategories = toSusanFormatWithCategories;
