require("dotenv").config({ path: __dirname + "/../.env" });
/**
 * Chad 5401 - Session Capture
 * Monitors: transcripts (9500), terminal-server (5400)
 * 30-min session windows, status=active for Jen to scrub
 */

const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { Logger } = require('./lib/logger');
const config = require('./lib/config');
const { from } = require('./lib/db');

const logger = new Logger('Chad');
const app = express();
app.use(cors());
app.use(express.json());

const TIME_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const TERMINAL_WS_URL = 'ws://localhost:5400?mode=monitor';

// Terminal now writes directly to DB

let terminalWs = null;
let terminalReconnectTimer = null;

// ============ TERMINAL MONITOR (5400) ============

function connectTerminalMonitor() {
  if (terminalWs && terminalWs.readyState === WebSocket.OPEN) return;

  logger.info('Connecting to terminal-server-5400...');

  try {
    terminalWs = new WebSocket(TERMINAL_WS_URL);

    terminalWs.on('open', () => {
      logger.info('Connected to terminal-server-5400 as monitor');
      if (terminalReconnectTimer) {
        clearTimeout(terminalReconnectTimer);
        terminalReconnectTimer = null;
      }
    });

    terminalWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'monitor_output' && msg.data) {
          // Strip ANSI codes
          const content = msg.data.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (content.length > 0) {
            writeTerminalToRaw(content, msg.session);
          }
        } else if (msg.type === 'session_started') {
          logger.info('Terminal session started', { session: msg.session, mode: msg.mode });
        } else if (msg.type === 'session_ended') {
          logger.info('Terminal session ended', { session: msg.session });
          // Flush buffer on session end
          flushTerminalBuffer('session-end');
        }
      } catch (e) {
        // Raw text
        if (data.toString().trim().length > 0) {
          writeTerminalToRaw(data.toString(), 'raw');
        }
      }
    });

    terminalWs.on('close', () => {
      logger.warn('Disconnected from terminal-server-5400');
      terminalWs = null;
      // Reconnect after 10 seconds
      terminalReconnectTimer = setTimeout(connectTerminalMonitor, 10000);
    });

    terminalWs.on('error', (err) => {
      logger.error('Terminal WebSocket error', { error: err.message });
    });

  } catch (err) {
    logger.error('Failed to connect to terminal-server-5400', { error: err.message });
    terminalReconnectTimer = setTimeout(connectTerminalMonitor, 10000);
  }
}

async function writeTerminalToRaw(content, session) {
  try {
    await from('dev_transcripts_raw').insert({
      source_type: 'terminal',
      session_file: 'terminal/5400',
      project_slug: 'terminal',
      team_port: 5400,
      content: content,
      original_timestamp: new Date().toISOString(),
      processed: false
    });
  } catch (err) {
    logger.error('Error writing terminal to raw', { error: err.message });
  }
}

async function flushTerminalBuffer(reason) {
  logger.info('Terminal event', { reason });
}

// ============ TRANSCRIPT PROCESSOR (9500) ============

function groupByTimeWindow(transcripts) {
  const windows = {};
  for (const t of transcripts) {
    const ts = t.original_timestamp ? new Date(t.original_timestamp).getTime() : new Date(t.received_at).getTime();
    const windowStart = Math.floor(ts / TIME_WINDOW_MS) * TIME_WINDOW_MS;
    const sourceType = t.source_type || 'transcript';
    const sourceName = t.session_file || 'unknown';
    const teamPort = t.team_port || 0;
    const key = sourceType + ':' + sourceName + ':' + teamPort + ':' + windowStart;
    if (!windows[key]) {
      windows[key] = {
        windowStart,
        source_type: sourceType,
        session_file: sourceName,
        project_folder: t.project_folder || null,
        project_slug: t.project_slug || null,
        team_port: t.team_port || null,
        transcripts: [],
        content: '',
        earliest_ts: ts,
        latest_ts: ts
      };
    }
    windows[key].transcripts.push(t);
    windows[key].content += t.content + '\n';
    windows[key].earliest_ts = Math.min(windows[key].earliest_ts, ts);
    windows[key].latest_ts = Math.max(windows[key].latest_ts, ts);
  }
  return Object.values(windows);
}

// ============ CWD-BASED ROUTING FALLBACK ============

function extractCwdFromContent(content) {
  if (!content) return null;
  const cwdMatches = content.match(/"cwd"\s*:\s*"([^"]+)"/g);
  if (cwdMatches && cwdMatches.length > 0) {
    const lastMatch = cwdMatches[cwdMatches.length - 1];
    const valueMatch = lastMatch.match(/"cwd"\s*:\s*"([^"]+)"/);
    if (valueMatch) {
      return valueMatch[1].replace(/\\\\/g, "/").replace(/\\/g, "/");
    }
  }
  return null;
}

/**
 * Parse routing from CWD path
 */
function parseRoutingFromCwd(cwd) {
  if (!cwd) return { project_slug: null, team_port: null };
  const normalized = cwd.replace(/\\/g, "/").toLowerCase();
  const portMatch = normalized.match(/([a-z0-9-]+)-(\d{4,5})/);
  if (portMatch) {
    const slug = portMatch[1];
    const port = parseInt(portMatch[2], 10);
    if (port >= 4000 && port <= 9999) {
      return { project_slug: slug, team_port: port };
    }
  }
  const studioMatch = normalized.match(/studio\/([^\/]+)/);
  if (studioMatch) return { project_slug: studioMatch[1], team_port: null };
  const projectsMatch = normalized.match(/projects\/([^\/]+)/);
  if (projectsMatch) return { project_slug: projectsMatch[1], team_port: null };
  return { project_slug: null, team_port: null };
}

function isHomePath(p) {
  if (!p) return false;
  const c = p.toLowerCase();
  return c.includes('/home/') || c.includes('/root/') || c.endsWith('/root') || c.includes('\\users\\') || /^[a-z]:\\users\\/i.test(c);
}

function resolveProjectSlug(win, cwd) {
  if (win.project_slug && win.project_slug !== 'unassigned') {
    return { slug: win.project_slug, reason: 'transcript', port: win.team_port };
  }
  if (cwd && !isHomePath(cwd)) {
    const routing = parseRoutingFromCwd(cwd);
    if (routing.project_slug) {
      return { slug: routing.project_slug, reason: 'cwd', port: routing.team_port };
    }
  }
  const haystack = [win.session_file || '', win.project_folder || '', (win.content || '').substring(0, 5000)].join(' ').toLowerCase();
  const patterns = [
    { match: 'kodiack-dashboard', slug: 'kodiack-dashboard-5500' },
    { match: 'dashboard-5500', slug: 'kodiack-dashboard-5500' },
    { match: 'ai-jen', slug: 'ai-jen-5402' },
    { match: 'ai-susan', slug: 'ai-susan-5403' },
    { match: 'ai-chad', slug: 'ai-chad-5401' },
    { match: 'ai-jason', slug: 'ai-jason-5408' },
    { match: 'terminal-server', slug: 'terminal-server-5400' },
    { match: 'nextbid', slug: 'nextbid' },
    { match: 'kodiack-studio', slug: 'kodiack-studio' },
  ];
  for (const pat of patterns) {
    if (haystack.includes(pat.match)) {
      return { slug: pat.slug, reason: 'content:' + pat.match, port: null };
    }
  }
  logger.warn('Slug unresolved', { session_file: (win.session_file || '').substring(0, 80), cwd: (cwd || '').substring(0, 80), content_len: (win.content || '').length });
  return { slug: 'unassigned', reason: 'no_match', port: null };
}

async function processTranscripts() {
  logger.info('Processing transcripts...');

  try {
    const { data: transcripts, error } = await from('dev_transcripts_raw')
      .select('*')
      .eq('processed', false)
      .order('original_timestamp', { ascending: true })
      .limit(500);

    if (error) {
      logger.error('Failed to fetch transcripts', { error: error.message });
      return { processed: 0, errors: 1 };
    }

    if (!transcripts || transcripts.length === 0) {
      logger.info('No new transcripts to process');
      return { processed: 0, errors: 0, sessions: 0 };
    }

    logger.info('Found transcripts to process', { count: transcripts.length });

    const windows = groupByTimeWindow(transcripts);
    logger.info('Grouped into windows', { windows: windows.length });

    let sessionsCreated = 0;
    let transcriptsProcessed = 0;
    let errors = 0;

    for (const window of windows) {
      try {
        const projectPath = extractProject(window.session_file);
        const content = window.content;
        const messageCount = (content.match(/\n/g) || []).length + 1;

        // Resolve slug using priority fallback system
        const cwd = extractCwdFromContent(content);
        const resolved = resolveProjectSlug(window, cwd);
        const finalSlug = resolved.slug;
        const finalPort = resolved.port || window.team_port;
        if (resolved.reason !== 'transcript') logger.info('Slug resolved', { slug: finalSlug, reason: resolved.reason });


        if (content.length < 100) {
          await markTranscriptsProcessed(window.transcripts.map(t => t.id));
          transcriptsProcessed += window.transcripts.length;
          continue;
        }
        // Resolve project_uuid from project_slug (fallback: unassigned)
        let resolvedProjectUuid = null;

        const { data: proj, error: projErr } = await from('dev_projects')
          .select('id')
          .eq('slug', finalSlug)
          .single();
        if (!projErr && proj?.id) resolvedProjectUuid = proj.id;

        if (!resolvedProjectUuid) {
          const { data: unassigned, error: unassignedErr } = await from('dev_projects')
            .select('id')
            .eq('slug', 'unassigned')
            .single();
          if (!unassignedErr && unassigned?.id) resolvedProjectUuid = unassigned.id;
        }

        const { error: insertError } = await from('dev_ai_sessions')
          .insert({
            project_id: resolvedProjectUuid,
            project_uuid: resolvedProjectUuid,
            project_slug: finalSlug,
            team_port: finalPort,
            source_type: window.source_type || 'transcript',
            source_name: window.session_file,
            status: 'active',
            raw_content: content,
            message_count: messageCount,
            started_at: new Date(window.windowStart).toISOString()
          });

        if (insertError) {
          if (insertError.message && insertError.message.includes('duplicate key')) {
            logger.info('Session exists, skipping duplicate');
          } else {
            logger.error('Failed to create session', { error: insertError.message });
            errors++;
            continue;
          }
        }

        await markTranscriptsProcessed(window.transcripts.map(t => t.id));
        sessionsCreated++;
        transcriptsProcessed += window.transcripts.length;

        logger.info('Created session from window', {
          project: projectPath,
          slug: finalSlug,
          transcripts: window.transcripts.length,
          messages: messageCount
        });

      } catch (err) {
        logger.error('Failed to process window', { error: err.message });
        errors++;
      }
    }

    logger.info('Processing complete', { sessions: sessionsCreated, transcripts: transcriptsProcessed, errors });
    return { processed: transcriptsProcessed, sessions: sessionsCreated, errors };

  } catch (err) {
    logger.error('Processing failed', { error: err.message });
    return { processed: 0, errors: 1 };
  }
}

function extractProject(sessionFile) {
  if (!sessionFile) return 'unknown';
  const normalized = sessionFile.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const dirPart = parts.length > 1 ? parts[0] : sessionFile;
  let converted = dirPart.replace(/^([A-Z])--/, '$1:/');
  converted = converted.replace(/-/g, '/');
  return converted || 'unknown';
}

async function markTranscriptsProcessed(ids) {
  for (const id of ids) {
    await from('dev_transcripts_raw')
      .update({ processed: true })
      .eq('id', id);
  }
}

// ============ ENDPOINTS ============

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'chad-5401',
    uptime: process.uptime(),
    terminalConnected: terminalWs?.readyState === WebSocket.OPEN,
    terminalBufferSize: 0
  });
});

app.post('/process', async (req, res) => {
  const result = await processTranscripts();
  res.json(result);
});

app.post('/flush-terminal', async (req, res) => {
  await flushTerminalBuffer('manual');
  res.json({ success: true });
});

// ============ STARTUP ============

async function start() {
  const port = config.PORT;

  // Connect to terminal monitor
  // connectTerminalMonitor(); // Disabled - terminal-server-5400 uploads directly to 9500

  // Process transcripts every 5 minutes
  logger.info('Starting transcript processor', { interval: '5 minutes' });
  setInterval(processTranscripts, 5 * 60 * 1000);

  // Flush terminal buffer every 30 minutes (in case no session end)
  setInterval(() => flushTerminalBuffer('interval'), TIME_WINDOW_MS);

  // Run initial process after 30 seconds
  setTimeout(processTranscripts, 30000);

  app.listen(port, () => {
    logger.info('Chad ready', {
      port,
      pid: process.pid,
      monitoring: ['transcripts-9500', 'terminal-5400']
    });
  });
}

start().catch(err => {
  logger.error('Startup failed', { error: err.message });
  process.exit(1);
});
