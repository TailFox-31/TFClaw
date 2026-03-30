/**
 * Mixture of Agents (MoA) for arbiter verdicts.
 *
 * Queries multiple LLM models in parallel, then aggregates their
 * opinions into a single binding verdict. Uses OpenAI-compatible
 * chat completions API (works with OpenRouter, direct providers, etc.)
 */
import { logger } from './logger.js';

export interface MoaModelConfig {
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface MoaConfig {
  enabled: boolean;
  referenceModels: MoaModelConfig[];
  aggregator: MoaModelConfig;
}

async function queryModel(
  model: MoaModelConfig,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 60_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `${model.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify({
          model: model.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 2048,
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from model');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function runMoaArbiter(args: {
  config: MoaConfig;
  systemPrompt: string;
  contextPrompt: string;
}): Promise<{
  verdict: string;
  referenceResponses: { model: string; response: string; error?: string }[];
}> {
  const { config, systemPrompt, contextPrompt } = args;

  // Phase 1: Query reference models in parallel
  logger.info(
    { modelCount: config.referenceModels.length },
    'MoA: querying reference models',
  );

  const results = await Promise.allSettled(
    config.referenceModels.map((model) =>
      queryModel(model, systemPrompt, contextPrompt),
    ),
  );

  const referenceResponses = results.map((result, i) => {
    const model = config.referenceModels[i].name;
    if (result.status === 'fulfilled') {
      logger.info(
        { model, responseLen: result.value.length },
        'MoA: reference model responded',
      );
      return { model, response: result.value };
    }
    const error =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    logger.warn({ model, error }, 'MoA: reference model failed');
    return { model, response: '', error };
  });

  const successfulResponses = referenceResponses.filter((r) => !r.error);

  if (successfulResponses.length === 0) {
    logger.error('MoA: all reference models failed, using ESCALATE');
    return {
      verdict:
        'ESCALATE\n\nAll reference models failed to respond. Human judgment required.',
      referenceResponses,
    };
  }

  // Phase 2: Aggregate via aggregator model
  const opinions = successfulResponses
    .map((r, i) => `### Opinion ${i + 1} (${r.model}):\n${r.response}`)
    .join('\n\n---\n\n');

  const aggregatorPrompt = [
    contextPrompt,
    '',
    '---',
    '',
    `The following ${successfulResponses.length} independent AI models have each reviewed the deadlock and provided their analysis:`,
    '',
    opinions,
    '',
    '---',
    '',
    'Consider all perspectives above. Where they agree, that strengthens the case.',
    'Where they disagree, weigh the evidence each side presents.',
    'Render your final verdict. Start your first line with: PROCEED, REVISE, RESET, or ESCALATE.',
  ].join('\n');

  logger.info(
    { aggregator: config.aggregator.name },
    'MoA: running aggregator',
  );

  try {
    const verdict = await queryModel(
      config.aggregator,
      systemPrompt,
      aggregatorPrompt,
      90_000,
    );
    logger.info(
      {
        aggregator: config.aggregator.name,
        verdictPreview: verdict.slice(0, 100),
      },
      'MoA: aggregator verdict rendered',
    );
    return { verdict, referenceResponses };
  } catch (error) {
    // Aggregator failed — fall back to majority vote from reference models
    logger.warn(
      { error },
      'MoA: aggregator failed, falling back to first successful reference',
    );
    return {
      verdict: successfulResponses[0].response,
      referenceResponses,
    };
  }
}
