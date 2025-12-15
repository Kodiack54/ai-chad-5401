/**
 * Chad's OpenAI Client
 * Wrapper for OpenAI API with retry and error handling
 */

const OpenAI = require('openai');
const config = require('./config');
const { Logger } = require('./logger');

const logger = new Logger('Chad:OpenAI');

let openai = null;

function getClient() {
  if (!openai) {
    if (!config.OPENAI_API_KEY) {
      throw new Error('OpenAI API key not configured');
    }

    openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY
    });
    logger.info('OpenAI client initialized');
  }
  return openai;
}

/**
 * Extract conversation from terminal output using GPT
 */
async function extractConversation(terminalOutput, options = {}) {
  const client = getClient();

  try {
    const response = await client.chat.completions.create({
      model: options.model || config.OPENAI_MODEL,
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
          content: `Extract conversation from this terminal output:\n\n${terminalOutput.slice(0, 8000)}`
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: options.maxTokens || 1000,
      temperature: options.temperature || 0.1
    });

    const result = JSON.parse(response.choices[0].message.content);
    return result.messages || [];
  } catch (error) {
    logger.error('Extraction failed', { error: error.message });
    throw error;
  }
}

/**
 * Chat with Chad directly
 */
async function chat(message, context = {}) {
  const client = getClient();

  try {
    const response = await client.chat.completions.create({
      model: config.OPENAI_MODEL,
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

${context.sessionInfo || ''}

Keep responses concise and helpful.`
        },
        {
          role: 'user',
          content: message
        }
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    return response.choices[0].message.content;
  } catch (error) {
    logger.error('Chat failed', { error: error.message });
    throw error;
  }
}

module.exports = {
  getClient,
  extractConversation,
  chat
};
