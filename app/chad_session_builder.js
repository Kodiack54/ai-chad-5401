/**
 * Chad Session Builder v2 - 30-minute windowed session builder
 *
 * DOES:
 *  - Tick every 15 minutes (aligned to quarter hour: :00, :15, :30, :45)
 *  - Alternate mode each tick (internal ↔ external)
 *  - Build 30-minute windows aligned on quarter-hour
 *  - Route to project using canonical dev_user_context (NO GUESSING)
 *  - Split session if context flips mid-window
 *  - Write ONLY to dev_session_logs with idempotency key
 *
 * DOES NOT:
 *  - Touch dev_transcripts_raw (NEVER)
 *  - Write to dev_ai_sessions (NEVER)
 *  - Set status='cleaned' (NEVER)
 *  - Guess project routing
 *
 * Env:
 *  - DATABASE_URL (REQUIRED - no fallback)
 */

const { Pool } = require('pg');

// HARD FAIL if DATABASE_URL not set
if (!process.env.DATABASE_URL) {
  console.error('[Chad] FATAL: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Get current quarter-hour aligned time
 */
function floorToQuarterHour(date = new Date()) {
  const d = new Date(date);
  const minutes = Math.floor(d.getMinutes() / 15) * 15;
  d.setMinutes(minutes, 0, 0);
  return d;
}

/**
 * Get quarter index (0-3) for mode alternation
 */
function quarterIndex(date) {
  return Math.floor(date.getMinutes() / 15);
}

/**
 * Resolve context from dev_user_context at a given timestamp
 * Returns the active context row or null
 */
async function resolveContext(client, timestamp, pcTag) {
  const result = await client.query(`
    SELECT
      project_id,
      project_slug,
      project_name,
      user_id,
      mode,
      dev_team
    FROM dev_user_context
    WHERE pc_tag_norm = $1
      AND started_at <= $2
      AND (ended_at IS NULL OR ended_at > $2)
    ORDER BY started_at DESC
    LIMIT 1
  `, [pcTag, timestamp]);

  return result.rows[0] || null;
}

/**
 * Process one tick
 */
async function processTick() {
  const tickTime = floorToQuarterHour();
  const qIdx = quarterIndex(tickTime);
  const mode = (qIdx % 2 === 0) ? 'internal' : 'external';

  const windowEnd = tickTime;
  const windowStart = new Date(tickTime.getTime() - 30 * 60 * 1000);

  console.log(`[Chad] Tick at ${tickTime.toISOString()} | mode=${mode} | window=${windowStart.toISOString()} to ${windowEnd.toISOString()}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch raw events for this window + mode
    // Filter by source_type column which matches internal/external
    const rawResult = await client.query(`
      SELECT
        id,
        pc_tag,
        source_type,
        content,
        original_timestamp,
        project_slug,
        project_id,
        user_id,
        mode as raw_mode,
        context_version,
        planning_slug,
        forge_slug
      FROM dev_transcripts_raw
      WHERE original_timestamp >= $1
        AND original_timestamp < $2
        AND source_type = $3
      ORDER BY original_timestamp ASC
    `, [windowStart, windowEnd, mode]);

    const rawEvents = rawResult.rows;
    console.log(`[Chad] Found ${rawEvents.length} raw events for ${mode}`);

    if (rawEvents.length === 0) {
      await client.query('COMMIT');
      return;
    }

    // Group events into segments by context (split on project change)
    const segments = [];
    let currentSegment = null;

    for (const event of rawEvents) {
      // Resolve canonical context at event time
      const ctx = await resolveContext(client, event.original_timestamp, normalizePcTag(event.pc_tag));
      const projectId = ctx?.project_id || 'UNASSIGNED';
      const projectSlug = ctx?.project_slug || 'unassigned';

      if (!currentSegment || currentSegment.projectId !== projectId) {
        // Flush previous segment
        if (currentSegment) {
          currentSegment.segmentEnd = event.original_timestamp;
          segments.push(currentSegment);
        }
        // Start new segment
        currentSegment = {
          projectId,
          projectSlug,
          userId: ctx?.user_id || event.user_id,
          pcTag: event.pc_tag,
          mode,
          lane: ctx?.mode || event.raw_mode || mode,
          segmentStart: event.original_timestamp,
          segmentEnd: null,
          events: [],
          contextVersions: []
        };
      }

      currentSegment.events.push(event);
      if (event.context_version != null) {
        currentSegment.contextVersions.push(event.context_version);
      }
    }

    // Flush last segment
    if (currentSegment && currentSegment.events.length > 0) {
      currentSegment.segmentEnd = currentSegment.events[currentSegment.events.length - 1].original_timestamp;
      segments.push(currentSegment);
    }

    console.log(`[Chad] Built ${segments.length} segments`);

    // Write each segment to dev_session_logs with idempotency
    for (const seg of segments) {
      const idempotencyKey = `chad:${mode}:${seg.projectId}:${seg.segmentStart.toISOString()}:${seg.segmentEnd.toISOString()}`;
      const rawRefs = JSON.stringify(seg.events.map(e => e.id));

      await client.query(`
        INSERT INTO dev_session_logs (
          idempotency_key,
          pc_tag,
          pc_tag_norm,
          project_id,
          project_slug,
          user_id,
          mode,
          lane,
          window_start,
          window_end,
          segment_start,
          segment_end,
          first_ts,
          last_ts,
          raw_refs,
          raw_count,
          message_count,
          context_version_min,
          context_version_max,
          status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, 'active'
        )
        ON CONFLICT (idempotency_key)
        DO UPDATE SET
          last_ts = GREATEST(dev_session_logs.last_ts, EXCLUDED.last_ts),
          segment_end = GREATEST(dev_session_logs.segment_end, EXCLUDED.segment_end),
          raw_refs = dev_session_logs.raw_refs || EXCLUDED.raw_refs,
          raw_count = dev_session_logs.raw_count + EXCLUDED.raw_count,
          message_count = dev_session_logs.message_count + EXCLUDED.message_count,
          context_version_max = GREATEST(dev_session_logs.context_version_max, EXCLUDED.context_version_max),
          updated_at = NOW()
      `, [
        idempotencyKey,
        seg.pcTag,
        normalizePcTag(seg.pcTag),
        seg.projectId,
        seg.projectSlug,
        seg.userId,
        mode,
        seg.lane,
        windowStart,
        windowEnd,
        seg.segmentStart,
        seg.segmentEnd,
        seg.segmentStart, // first_ts
        seg.segmentEnd,   // last_ts
        rawRefs,
        seg.events.length,
        seg.events.length,
        seg.contextVersions.length > 0 ? Math.min(...seg.contextVersions) : null,
        seg.contextVersions.length > 0 ? Math.max(...seg.contextVersions) : null
      ]);
    }

    await client.query('COMMIT');
    console.log(`[Chad] Wrote ${segments.length} session logs`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Chad] ERROR:', err.message);
  } finally {
    client.release();
  }
}

/**
 * Normalize pc_tag to standard form
 */
function normalizePcTag(pcTag) {
  if (!pcTag) return 'studio-terminals';
  return pcTag.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Calculate ms until next quarter hour
 */
function msUntilNextQuarter() {
  const now = new Date();
  const next = floorToQuarterHour(now);
  next.setMinutes(next.getMinutes() + 15);
  return next.getTime() - now.getTime();
}

/**
 * Main loop - tick on quarter hours
 */
async function loop() {
  console.log('[Chad Session Builder] Starting - ticks every 15 minutes on quarter hour');

  // Run immediately on start
  await processTick();

  // Then schedule on quarter hours
  while (true) {
    const waitMs = msUntilNextQuarter();
    console.log(`[Chad] Next tick in ${Math.round(waitMs / 1000)}s`);
    await new Promise(r => setTimeout(r, waitMs));
    await processTick();
  }
}

process.on('SIGINT', async () => {
  console.log('[Chad] SIGINT - shutting down');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[Chad] SIGTERM - shutting down');
  await pool.end();
  process.exit(0);
});

loop().catch(e => {
  console.error('[Chad] Fatal:', e.message);
  process.exit(1);
});
