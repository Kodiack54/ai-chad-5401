/**
 * Chad - AI Team Transcriber (Port 5401)
 *
 * Watches Claude's terminal output, extracts conversation pairs,
 * stores in database, and sends summaries to Susan for cataloging.
 *
 * Uses GPT-4o-mini for extraction (~$0.001 per conversation)
 */

require('dotenv').config();
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
// Using local PostgreSQL
const supabase = require('../shared/db');
const OpenAI = require('openai');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

// Team Chat routes
const teamChatRoutes = require('./src/routes/teamChat');
app.use('/api/team-chat', teamChatRoutes);

const PORT = process.env.PORT || 5401;
const SUSAN_URL = process.env.SUSAN_URL || 'http://localhost:5403';

// Multi-source watcher
const sourceWatcher = require('./src/services/sourceWatcher');

// Cataloger - extracts knowledge every 30 min and sends to Susan
const cataloger = require('./src/services/cataloger');

// Supabase connection

// OpenAI for extraction
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Active sessions: Map<sessionId, SessionState>
const activeSessions = new Map();

// Session state
class SessionState {
  constructor(sessionId, projectPath, userId) {
    this.sessionId = sessionId;
    this.projectPath = projectPath;
    this.userId = userId;
    this.buffer = '';
    this.messages = [];
    this.sequenceNum = 0;
    this.lastActivity = Date.now();
    this.pendingExtraction = false;
  }

  appendOutput(data) {
    this.buffer += data;
    this.lastActivity = Date.now();

    // Try to extract messages when buffer is large enough
    if (this.buffer.length > 500 && !this.pendingExtraction) {
      this.scheduleExtraction();
    }
  }

  scheduleExtraction() {
    if (this.pendingExtraction) return;
    this.pendingExtraction = true;

    // Wait for more output, then extract
    setTimeout(async () => {
      await this.extractMessages();
      this.pendingExtraction = false;
    }, 2000);
  }

  async extractMessages() {
    if (this.buffer.length < 100) return;

    const rawOutput = this.buffer;
    this.buffer = ''; // Clear buffer

    try {
      // Use GPT-4o-mini to extract conversation
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are Chad, an AI transcriber. Extract clean conversation messages from terminal output.
The output contains Claude Code's TUI with escape codes, spinners, and tool output.
Extract only the actual conversation - user prompts and Claude's responses.

Return JSON object with messages array:
{"messages": [{"role": "user" | "assistant", "content": "clean message text"}]}

Skip:
- Tool calls and their raw output
- Escape sequences and TUI decorations
- Spinners and progress indicators
- File contents and diffs (just note "edited file X")

Keep:
- User's questions/requests
- Claude's explanations and summaries
- What was done (not how)`
          },
          {
            role: 'user',
            content: `Extract conversation from this terminal output:\n\n${rawOutput.slice(0, 8000)}`
          }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1000,
        temperature: 0.1
      });

      const extracted = JSON.parse(response.choices[0].message.content);
      const messages = extracted.messages || [];

      if (Array.isArray(messages)) {
        for (const msg of messages) {
          if (msg.role && msg.content && msg.content.trim()) {
            await this.storeMessage(msg.role, msg.content.trim());
          }
        }
      }
    } catch (err) {
      console.error('[Chad] Extraction error:', err.message);
      // Store raw output as fallback
      if (rawOutput.trim()) {
        // Just extract obvious patterns without AI
        this.extractSimple(rawOutput);
      }
    }
  }

  // Simple regex-based extraction as fallback
  extractSimple(output) {
    // Clean escape codes
    const clean = output.replace(/\x1b\[[0-9;]*m/g, '')
                       .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '');

    // Look for Claude's summary responses (starts with bullet)
    const summaryMatch = clean.match(/[●○]\s+(.+?)(?:\n|$)/g);
    if (summaryMatch) {
      summaryMatch.forEach(m => {
        const content = m.replace(/^[●○]\s*/, '').trim();
        if (content.length > 10) {
          this.storeMessage('assistant', content);
        }
      });
    }
  }

  async storeMessage(role, content) {
    this.sequenceNum++;

    try {
      const { error } = await supabase.from('dev_ai_messages').insert({
        session_id: this.sessionId,
        role,
        content,
        sequence_num: this.sequenceNum
      });

      if (error) throw error;

      this.messages.push({ role, content, sequence: this.sequenceNum });
      console.log(`[Chad] Stored ${role}: ${content.slice(0, 50)}...`);

      // Notify Susan of new message
      this.notifySusan({ role, content });
    } catch (err) {
      console.error('[Chad] Store error:', err.message);
    }
  }

  async notifySusan(message) {
    try {
      await fetch(`${SUSAN_URL}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId,
          projectPath: this.projectPath,
          message
        })
      });
    } catch (err) {
      // Susan might not be running yet
    }
  }

  async endSession() {
    // Extract any remaining buffer
    if (this.buffer.length > 0) {
      await this.extractMessages();
    }

    // Update session end time
    const { error } = await supabase.from('dev_ai_sessions')
      .update({ ended_at: new Date().toISOString(), status: 'completed' })
      .eq('id', this.sessionId);

    if (error) console.error('[Chad] End session error:', error.message);

    // Ask Susan to summarize the session
    try {
      await fetch(`${SUSAN_URL}/api/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId })
      });
    } catch (err) {
      // Susan might not be running
    }
  }
}

// ============================================
// WebSocket Server - Receives terminal output
// ============================================

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const projectPath = url.searchParams.get('path') || '/unknown';
  const userId = url.searchParams.get('userId') || null;

  console.log(`[Chad] New connection for project: ${projectPath}`);

  // Create or find session
  let sessionId;
  try {
    const { data, error } = await supabase.from('dev_ai_sessions')
      .insert({
        project_path: projectPath,
        user_id: userId,
        terminal_port: 5400,
        status: 'active'
      })
      .select('id')
      .single();

    if (error) throw error;
    sessionId = data.id;
  } catch (err) {
    console.error('[Chad] Session creation error:', err.message);
    ws.close();
    return;
  }

  const session = new SessionState(sessionId, projectPath, userId);
  activeSessions.set(sessionId, session);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'output') {
        // Terminal output from Claude
        session.appendOutput(msg.data);
        // Also feed into source watcher for external Claude buffer
        sourceWatcher.appendExternalClaude(msg.data);
      } else if (msg.type === 'user_input') {
        // User input (from chat or terminal)
        session.storeMessage('user', msg.content);
        sourceWatcher.appendExternalClaude(`[USER] ${msg.content}\n`);
      }
    } catch (err) {
      // Might be raw text
      session.appendOutput(data.toString());
      sourceWatcher.appendExternalClaude(data.toString());
    }
  });

  ws.on('close', async () => {
    console.log(`[Chad] Connection closed for session: ${sessionId}`);
    await session.endSession();
    activeSessions.delete(sessionId);
  });

  ws.on('error', (err) => {
    console.error(`[Chad] WebSocket error: ${err.message}`);
  });
});

// ============================================
// HTTP API
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'chad-transcriber',
    port: PORT,
    activeSessions: activeSessions.size
  });
});

// Get active sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const { data, error } = await supabase.from('dev_ai_sessions')
      .select('id, project_path, started_at, status')
      .eq('status', 'active')
      .order('started_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session messages
app.get('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { data, error } = await supabase.from('dev_ai_messages')
      .select('role, content, created_at')
      .eq('session_id', req.params.id)
      .order('sequence_num', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual message store (for direct chat input)
app.post('/api/message', async (req, res) => {
  const { sessionId, role, content } = req.body;

  const session = activeSessions.get(sessionId);
  if (session) {
    await session.storeMessage(role, content);
    res.json({ success: true });
  } else {
    // Store directly if session not in memory
    try {
      // Get max sequence number
      const { data: maxData } = await supabase.from('dev_ai_messages')
        .select('sequence_num')
        .eq('session_id', sessionId)
        .order('sequence_num', { ascending: false })
        .limit(1)
        .single();

      const seq = (maxData?.sequence_num || 0) + 1;

      const { error } = await supabase.from('dev_ai_messages').insert({
        session_id: sessionId,
        role,
        content,
        sequence_num: seq
      });

      if (error) throw error;
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

// Recent conversations (for UI display)
app.get('/api/recent', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const projectPath = req.query.project;

  try {
    let query = supabase.from('dev_ai_sessions')
      .select('id, project_path, started_at, ended_at')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (projectPath) {
      query = query.eq('project_path', projectPath);
    }

    const { data: sessions, error: sessionsError } = await query;
    if (sessionsError) throw sessionsError;

    // Get messages for each session
    const results = await Promise.all(sessions.map(async (session) => {
      const { data: messages } = await supabase.from('dev_ai_messages')
        .select('role, content, created_at')
        .eq('session_id', session.id)
        .order('sequence_num', { ascending: true });

      return {
        session_id: session.id,
        project_path: session.project_path,
        started_at: session.started_at,
        ended_at: session.ended_at,
        messages: messages || []
      };
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SOURCE WATCHER API - Multi-source monitoring
// ============================================

// Get source watcher status
app.get('/api/sources/status', (req, res) => {
  res.json({
    success: true,
    sources: sourceWatcher.getStatus()
  });
});

// Get pending dumps for Susan to process
app.get('/api/sources/pending', async (req, res) => {
  try {
    const pending = await sourceWatcher.getPendingDumps();
    res.json({
      success: true,
      pending,
      count: pending.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force dump a specific source (manual trigger)
app.post('/api/sources/dump/:sourceId', async (req, res) => {
  try {
    const sessionId = await sourceWatcher.forceDump(req.params.sourceId);
    res.json({
      success: true,
      sessionId,
      message: sessionId ? 'Dump created' : 'No content to dump'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List available sources
app.get('/api/sources', (req, res) => {
  res.json({
    success: true,
    sources: Object.values(sourceWatcher.SOURCES).map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      dumpSchedule: s.dumpMinutes.map(m => `:${m.toString().padStart(2, '0')}`).join(', ')
    }))
  });
});

// ============================================
// CATALOGER API - Manual trigger for Susan pipeline
// ============================================

// Trigger cataloger now (for manual runs or DocWorker)
app.post('/api/catalog/trigger', async (req, res) => {
  try {
    console.log('[Chad] Manual catalog trigger received');
    await cataloger.runCatalog();
    res.json({
      success: true,
      message: 'Catalog cycle completed',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[Chad] Manual catalog trigger failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Catalog a specific session
app.post('/api/catalog/session/:id', async (req, res) => {
  try {
    const result = await cataloger.catalogNow(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CHAT - Direct conversation with Chad
// ============================================

app.post('/api/chat', async (req, res) => {
  const { message, context } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    // Get recent sessions for context
    const { data: recentSessions } = await supabase.from('dev_ai_sessions')
      .select('id, project_path, summary, started_at')
      .order('started_at', { ascending: false })
      .limit(5);

    const sessionContext = recentSessions?.length > 0
      ? `Recent sessions I've transcribed:\n${recentSessions.map(s =>
          `- ${s.project_path}: ${s.summary || 'No summary'}`
        ).join('\n')}`
      : 'No recent sessions transcribed yet.';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are Chad, the AI Team Transcriber at NextBid Dev Studio. You work on port 5401.

Your job:
- Watch Claude's terminal output and transcribe conversations
- Extract clean dialogue from messy terminal output
- Log everything to the database for Susan to catalog
- Help the team understand what Claude has been working on

Personality: Friendly, helpful, a bit nerdy about logs and data. You love organizing information.

${sessionContext}

${context ? `Additional context: ${context}` : ''}

Keep responses concise and helpful. You can tell the user about recent sessions, what Claude has been working on, or help them understand the transcription process.`
        },
        {
          role: 'user',
          content: message
        }
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    const reply = response.choices[0].message.content;
    console.log(`[Chad] Chat: "${message.slice(0, 50)}..." -> "${reply.slice(0, 50)}..."`);

    res.json({
      success: true,
      reply,
      from: 'chad'
    });
  } catch (err) {
    console.error('[Chad] Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Start Server
// ============================================

server.listen(PORT, async () => {
  // Initialize source watcher
  try {
    await sourceWatcher.initialize();
    console.log('[Chad] Multi-source watcher initialized');
  } catch (err) {
    console.error('[Chad] Failed to initialize source watcher:', err.message);
  }

  // Start cataloger (runs every 30 min, extracts knowledge, sends to Susan)
  try {
    cataloger.start();
    console.log('[Chad] Cataloger started (runs every 30 min)');
  } catch (err) {
    console.error('[Chad] Failed to start cataloger:', err.message);
  }

  console.log(`
====================================
  Chad - AI Team Transcriber
  Port: ${PORT}
====================================

  WebSocket: ws://localhost:${PORT}
  HTTP API:  http://localhost:${PORT}

  Endpoints:
    GET  /health
    GET  /api/sessions
    GET  /api/sessions/:id/messages
    POST /api/message
    POST /api/chat
    GET  /api/recent

  Cataloger (extracts knowledge → sends to Susan):
    POST /api/catalog/trigger       - Run catalog cycle now
    POST /api/catalog/session/:id   - Catalog specific session

  Source Watcher:
    GET  /api/sources           - List sources
    GET  /api/sources/status    - Watcher status
    GET  /api/sources/pending   - Pending dumps for Susan
    POST /api/sources/dump/:id  - Force dump a source

  Dump Schedule:
    :00, :30 - External Claude (local terminals)
    :10, :40 - Chat systems (Susan + Chad)
    :20, :50 - Internal Claude (Server :5400)

  Ready to transcribe Claude sessions.
====================================
  `);
});
