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
          content: `You are Chad, an AI transcriber. Extract conversation messages from Claude Code terminal output.

CRITICAL: Correctly identify WHO is speaking:
- "assistant" = Claude's responses (explanations, questions to user, summaries, bullet points, anything Claude types)
- "user" = Human's input (text typed after > prompt, short confirmations like "y", "yes", user requests)

Claude Code TUI patterns:
- Claude asks questions like "What would you like to work on?" - this is ASSISTANT
- Claude gives summaries with bullet points (●, •) - this is ASSISTANT
- Claude explains what it did - this is ASSISTANT
- Short inputs after > prompt are USER
- "y", "yes", "no", single words are usually USER confirmations

Return JSON: {"messages": [{"role": "assistant" | "user", "content": "text"}]}

SKIP completely:
- TUI decorations (Try "...", spinners, ───, boxes)
- Tool call outputs (file listings, git output)
- Repeated/duplicate content
- Status messages (Thinking..., Using tool...)

KEEP:
- Claude's questions and explanations (as "assistant")
- User's requests and confirmations (as "user")
- Summary bullet points (as "assistant")`
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
