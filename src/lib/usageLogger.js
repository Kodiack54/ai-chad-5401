/**
 * Chad's AI Usage Logger
 * Logs AI API usage to dev_ai_usage table
 */

const { from } = require('./db');
const { Logger } = require('./logger');

const logger = new Logger('Chad:UsageLogger');

// Claude pricing (per 1M tokens)
const MODEL_PRICING = {
  'claude-3-opus': { input: 15.0, output: 75.0 },
  'claude-3-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-3.5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022': { input: 0.25, output: 1.25 },
  'claude-opus-4': { input: 15.0, output: 75.0 },
};

function calculateCost(model, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-3-sonnet'];
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Log AI usage to database
 */
async function logUsage({
  model,
  inputTokens,
  outputTokens,
  requestType = 'chat',
  projectPath = null,
  promptPreview = null,
  responseTimeMs = null
}) {
  try {
    const costUsd = calculateCost(model, inputTokens, outputTokens);

    const { error } = await from('dev_ai_usage').insert({
      user_id: 'system',
      project_id: projectPath,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      request_type: requestType,
      assistant_name: 'chad',
      prompt_preview: promptPreview?.slice(0, 255),
      response_time_ms: responseTimeMs
    });

    if (error) {
      logger.error('Failed to log usage', { error: error.message });
      return null;
    }

    logger.debug('Usage logged', {
      model,
      tokens: inputTokens + outputTokens,
      cost: `$${costUsd.toFixed(6)}`
    });

    return { costUsd, inputTokens, outputTokens };
  } catch (err) {
    logger.error('Usage logging error', { error: err.message });
    return null;
  }
}

/**
 * Wrap an Anthropic response and log usage
 */
async function logAnthropicResponse(response, requestType = 'chat', projectPath = null, promptPreview = null, startTime = null) {
  if (!response?.usage) return response;

  const responseTimeMs = startTime ? Date.now() - startTime : null;

  await logUsage({
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    requestType,
    projectPath,
    promptPreview,
    responseTimeMs
  });

  return response;
}

module.exports = {
  logUsage,
  logAnthropicResponse,
  calculateCost
};

// OpenAI pricing (per 1M tokens)
const OPENAI_PRICING = {
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gpt-4': { input: 30.0, output: 60.0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
};

function calculateOpenAICost(model, inputTokens, outputTokens) {
  const pricing = OPENAI_PRICING[model] || OPENAI_PRICING['gpt-4o-mini'];
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Log OpenAI API usage to database
 */
async function logOpenAIUsage(response, requestType = 'chat', startTime = null) {
  if (!response?.usage) return response;

  const responseTimeMs = startTime ? Date.now() - startTime : null;
  const inputTokens = response.usage.prompt_tokens || 0;
  const outputTokens = response.usage.completion_tokens || 0;
  const model = response.model || 'gpt-4o-mini';

  try {
    const costUsd = calculateOpenAICost(model, inputTokens, outputTokens);

    const { error } = await from('dev_ai_usage').insert({
      service: 'openai',
      model,
      task_type: requestType,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cost_usd: costUsd,
      duration_ms: responseTimeMs,
      success: true
    });

    if (error) {
      logger.error('Failed to log OpenAI usage', { error: error.message });
      return response;
    }

    logger.debug('OpenAI usage logged', {
      model,
      tokens: inputTokens + outputTokens,
      cost: `$${costUsd.toFixed(6)}`
    });

    return response;
  } catch (err) {
    logger.error('OpenAI usage logging error', { error: err.message });
    return response;
  }
}

module.exports.logOpenAIUsage = logOpenAIUsage;
module.exports.calculateOpenAICost = calculateOpenAICost;
