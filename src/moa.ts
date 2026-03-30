/**
 * Mixture of Agents (MoA) — lightweight reference opinions.
 *
 * Queries external API models (Kimi, GLM, etc.) in parallel for their
 * opinions on the deadlock. These opinions are then injected into the
 * SDK-based arbiter's prompt so it can aggregate all perspectives.
 *
 * No extra SDK processes. The existing arbiter (Claude/Codex subscription)
 * naturally becomes the aggregator.
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
}

export interface MoaReferenceResult {
  model: string;
  response: string;
  error?: string;
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
      throw new Error(
        `${response.status} ${response.statusText}: ${body.slice(0, 200)}`,
      );
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

/**
 * Query all reference models in parallel and return their opinions.
 * These are injected into the SDK arbiter's prompt — the arbiter
 * aggregates them into a final verdict.
 */
export async function collectMoaReferences(args: {
  config: MoaConfig;
  systemPrompt: string;
  contextPrompt: string;
}): Promise<MoaReferenceResult[]> {
  const { config, systemPrompt, contextPrompt } = args;

  logger.info(
    {
      models: config.referenceModels.map((m) => m.name),
    },
    'MoA: querying reference models for opinions',
  );

  const results = await Promise.allSettled(
    config.referenceModels.map((model) =>
      queryModel(model, systemPrompt, contextPrompt),
    ),
  );

  return results.map((result, i) => {
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
}

/**
 * Format reference opinions into a section that gets appended
 * to the arbiter's prompt.
 */
export function formatMoaReferencesForPrompt(
  references: MoaReferenceResult[],
): string | null {
  const successful = references.filter((r) => !r.error && r.response);
  if (successful.length === 0) return null;

  const opinions = successful
    .map((r) => `### ${r.model}:\n${r.response}`)
    .join('\n\n---\n\n');

  return [
    '',
    `<moa-references count="${successful.length}">`,
    `The following ${successful.length} independent AI models have also reviewed this deadlock:`,
    '',
    opinions,
    '',
    'Consider these perspectives alongside the conversation. Where they agree, that strengthens the case.',
    'Where they disagree, weigh the evidence. Your verdict is final.',
    '</moa-references>',
  ].join('\n');
}
