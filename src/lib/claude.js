/**
 * Chad's Claude Client
 * For chat conversations (quality matters)
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { Logger } = require('./logger');
const { logAnthropicResponse } = require('./usageLogger');

const logger = new Logger('Chad:Claude');

let client = null;

function getClient() {
  if (!client) {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error('Anthropic API key not configured');
    }

    client = new Anthropic({
      apiKey: config.ANTHROPIC_API_KEY
    });
    logger.info('Claude client initialized');
  }
  return client;
}

/**
 * Chat with Chad using Claude (quality conversations)
 */
async function chat(message, context = {}) {
  const client = getClient();

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022', // Claude for chat quality
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: message
        }
      ],
      system: `You are Chad, the Developer's Assistant for Kodiack Studios. You work on port 5401.

Your job:
- Help developers with their work
- Watch terminal output and transcribe conversations
- Extract clean dialogue from messy terminal output
- Log everything to the database for Susan to catalog
- Help the team understand what's been worked on

Personality: Friendly, helpful, professional. You're here to assist developers with anything they need.

${context.sessionInfo || ''}

Keep responses concise and helpful.`
    });

    // Log usage
    await logAnthropicResponse(response, 'chat', context.projectPath, message.slice(0, 100));

    return response.content[0].text;
  } catch (error) {
    logger.error('Chat failed', { error: error.message });
    throw error;
  }
}

module.exports = {
  getClient,
  chat
};
