# ai-chad-5401

Chad Session Builder - builds session logs from raw transcripts.

## Files

- `app/chad-heartbeat.js` - HTTP health endpoint (/health)
- `app/chad_session_builder.js` - 30-minute windowed session builder

## What Chad Does

- Ticks every 15 minutes (aligned to quarter hour)
- Alternates mode each tick (internal/external)
- Builds 30-minute windows
- Routes to project using dev_user_context (no guessing)
- Splits session if context flips mid-window
- Writes ONLY to `dev_session_logs`

## What Chad Does NOT Do

- Touch `dev_transcripts_raw.processed` (NEVER)
- Write to `dev_ai_sessions` (NEVER)
- Set `status='cleaned'` (NEVER)

## PM2 Commands

```bash
# Stop and delete old instance
pm2 stop ai-chad-5401
pm2 delete ai-chad-5401
pm2 save

# Start new instances
pm2 start app/chad_session_builder.js --name ai-chad-5401
pm2 start app/chad-heartbeat.js --name ai-chad-heartbeat-5401
pm2 save
```

## Environment

Required:
- `DATABASE_URL` - PostgreSQL connection string (no fallback - hard fail if missing)

Optional:
- `CHAD_HEARTBEAT_PORT` - HTTP port for heartbeat (default: 5401)

## Acceptance Tests

1. Generate new raw transcript events
2. Verify ONLY `dev_session_logs` gets new rows
3. Verify `dev_transcripts_raw` remains untouched
4. Verify no sessions ever become 'cleaned' from Chad

```sql
-- Check session logs
SELECT * FROM dev_session_logs ORDER BY created_at DESC LIMIT 10;

-- Verify transcripts untouched (processed should still be whatever it was)
SELECT id, received_at, processed FROM dev_transcripts_raw ORDER BY received_at DESC LIMIT 10;
```
