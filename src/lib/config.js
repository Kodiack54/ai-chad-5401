/**
 * Chad's Configuration Loader
 * Loads environment variables with defaults
 */

require('dotenv').config();

const config = {
  // Server
  PORT: process.env.PORT || 5401,
  NODE_ENV: process.env.NODE_ENV || 'development',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Database (Supabase)
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,

  // OpenAI (for background extraction work)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // Anthropic (for chat conversations)
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

  // Susan integration
  SUSAN_URL: process.env.SUSAN_URL || 'http://localhost:5403',

  // Session settings
  SESSION_BUFFER_INTERVAL_MS: parseInt(process.env.SESSION_BUFFER_INTERVAL_MS) || 2000,
  SESSION_EXTRACTION_MIN_LENGTH: parseInt(process.env.SESSION_EXTRACTION_MIN_LENGTH) || 100,

  // Validate required config
  validate() {
    const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'OPENAI_API_KEY'];
    const missing = required.filter(key => !this[key]);

    if (missing.length > 0) {
      throw new Error(`Missing required config: ${missing.join(', ')}`);
    }

    return true;
  }
};

module.exports = config;
