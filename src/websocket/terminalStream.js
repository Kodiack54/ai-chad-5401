/**
 * Chad Terminal Stream Processor
 * Processes raw terminal output and routes to extractors
 */

const { Logger } = require('../lib/logger');
const config = require('../lib/config');

const logger = new Logger('Chad:TerminalStream');

// Extraction state per session
const extractionState = new Map();

// Deduplication: track recently sent messages per session
const recentMessages = new Map(); // sessionId -> Set of message hashes

/**
 * Process terminal output for a session
 */
async function process(session, rawData) {
  // Get or create extraction state for this session
  let state = extractionState.get(session.sessionId);
  if (!state) {
    state = {
      buffer: '',
      lastChunk: Date.now(),
      chunkCount: 0
    };
    extractionState.set(session.sessionId, state);
  }

  // Clean ANSI codes and control sequences
  const cleanData = cleanTerminalOutput(rawData);
  if (!cleanData) return;

  // Append to session buffer
  session.appendOutput(cleanData);

  // Update state
  state.buffer += cleanData;
  state.lastChunk = Date.now();
  state.chunkCount++;

  // Check if we should trigger extraction
  if (shouldTriggerExtraction(state)) {
    await triggerExtraction(session, state);
  }
}

/**
 * Clean terminal output - remove ANSI codes and control sequences
 */
function cleanTerminalOutput(data) {
  if (!data) return '';

  let clean = data
    // Remove ANSI escape sequences (ESC [ ... letter)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    // Remove visible escape codes without ESC prefix (corrupted terminals)
    .replace(/\[([0-9;]*[A-Za-z])/g, '')
    // Remove ANSI color codes
    .replace(/\x1b\[[0-9;]*m/g, '')
    // Remove cursor control sequences
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
    // Remove OSC sequences (title bar, etc)
    .replace(/\x1b\][^\x07]*\x07/g, '')
    // Remove remaining escape characters
    .replace(/\x1b/g, '')
    // Remove carriage returns (keep newlines)
    .replace(/\r(?!\n)/g, '')
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    // Remove null bytes
    .replace(/\x00/g, '')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    // Remove lines that are just dashes/underscores (separators)
    .replace(/^[─━─\-_═]+$/gm, '');

  return clean.trim();
}

/**
 * Determine if we should trigger extraction based on state
 */
function shouldTriggerExtraction(state) {
  // Trigger on buffer size
  if (state.buffer.length > config.SESSION_EXTRACTION_MIN_LENGTH) {
    return true;
  }

  // Trigger on conversation markers
  if (hasConversationMarkers(state.buffer)) {
    return true;
  }

  return false;
}

/**
 * Check for conversation markers in buffer
 */
function hasConversationMarkers(buffer) {
  const markers = [
    // Claude TUI markers
    /Human:/i,
    /Assistant:/i,
    />\s*$/m,  // Prompt indicator
    // Summary bullet points
    /[●○]\s+/,
    // Code block boundaries
    /```[\w]*\n/,
    // Tool usage patterns
    /Thinking\.\.\./i,
    /Using tool:/i,
    /Tool result:/i
  ];

  return markers.some(marker => marker.test(buffer));
}

/**
 * Trigger extraction pipeline
 */
async function triggerExtraction(session, state) {
  const extractorRegistry = getExtractorRegistry();

  if (!extractorRegistry) {
    // Extractors not loaded yet, let session manager handle it
    return;
  }

  try {
    // Find matching extractor
    const extractor = extractorRegistry.findMatching(state.buffer, {
      projectPath: session.projectPath,
      sessionId: session.sessionId
    });

    if (extractor) {
      logger.info('Using extractor', {
        extractor: extractor.name,
        sessionId: session.sessionId,
        bufferSize: state.buffer.length
      });

      // Run extractor
      const extracted = await extractor.extract(state.buffer, {
        sessionId: session.sessionId,
        projectPath: session.projectPath
      });

      // Store extracted messages and broadcast to connected clients
      if (extracted && Array.isArray(extracted.messages)) {
        const wsHandler = require('./handler');

        // Get or create dedup set for this session
        if (!recentMessages.has(session.sessionId)) {
          recentMessages.set(session.sessionId, new Set());
        }
        const sentMessages = recentMessages.get(session.sessionId);

        for (const msg of extracted.messages) {
          if (msg.role && msg.content) {
            const content = msg.content.trim();

            // Skip TUI noise that GPT might have extracted
            if (content.startsWith('Try "') || content.startsWith("Try '")) continue;
            if (content.includes('Thinking...')) continue;
            if (content.includes('Using tool:')) continue;
            if (/^[─━═\-]+$/.test(content)) continue; // Horizontal lines
            if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏·✢✶✻✽*•∴]+$/.test(content)) continue; // Spinners
            if (content.length < 3) continue; // Too short
            if (content === 'y' || content === 'n' || content === 'yes' || content === 'no') continue; // Skip bare confirmations

            // Create hash for deduplication (content + role)
            const msgHash = `${msg.role}:${content.slice(0, 100).toLowerCase().replace(/\s+/g, ' ')}`;

            // Skip if we've sent this recently
            if (sentMessages.has(msgHash)) {
              logger.info('Skipping duplicate message', { hash: msgHash.slice(0, 50) });
              continue;
            }

            // Add to dedup set (auto-expire after 30 seconds)
            sentMessages.add(msgHash);
            setTimeout(() => sentMessages.delete(msgHash), 30000);

            await session.storeMessage(msg.role, content);

            // Determine if this is Claude (assistant) or user (human)
            // GPT returns 'assistant' or 'user'
            const isAssistant = msg.role === 'assistant';

            // Broadcast clean message to frontend for chat display
            wsHandler.broadcast(session.projectPath, {
              type: 'conversation_message',
              id: `${msg.role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              user_id: isAssistant ? 'claude' : 'user',
              user_name: isAssistant ? 'Claude' : 'You',
              content: content,
              created_at: new Date().toISOString()
            });

            logger.info('Broadcast message', {
              role: msg.role,
              isAssistant,
              contentPreview: content.slice(0, 50)
            });
          }
        }
      }

      // Clear the buffer we just processed
      state.buffer = '';
    }
  } catch (err) {
    logger.error('Extraction failed', {
      error: err.message,
      sessionId: session.sessionId
    });
  }
}

/**
 * Get extractor registry (lazy load to avoid circular deps)
 */
let _extractorRegistry = null;
function getExtractorRegistry() {
  if (!_extractorRegistry) {
    try {
      _extractorRegistry = require('../extractors/registry');
    } catch (err) {
      // Registry not available yet
    }
  }
  return _extractorRegistry;
}

/**
 * Clean up state for ended session
 */
function cleanupSession(sessionId) {
  extractionState.delete(sessionId);
  recentMessages.delete(sessionId);
}

/**
 * Get extraction stats
 */
function getStats() {
  const stats = {
    activeSessions: extractionState.size,
    sessions: []
  };

  for (const [sessionId, state] of extractionState) {
    stats.sessions.push({
      sessionId,
      bufferSize: state.buffer.length,
      chunkCount: state.chunkCount,
      lastActivity: state.lastChunk
    });
  }

  return stats;
}

module.exports = {
  process,
  cleanTerminalOutput,
  cleanupSession,
  getStats
};
