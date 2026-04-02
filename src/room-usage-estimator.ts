import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getAllRegisteredGroups } from './db.js';

export interface RoomUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  responseCount: number;
  updatedAt: string | null;
}

export interface RoomUsageEstimate {
  provider: 'claude' | 'codex';
  folder: string;
  name: string;
  metrics: RoomUsageMetrics;
}

export interface RoomUsageSummary {
  provider: 'claude' | 'codex';
  rooms: RoomUsageEstimate[];
  totals: RoomUsageMetrics;
  sinceMs: number;
}

export interface CollectRoomUsageOptions {
  baseSessionsDir?: string;
  sinceMs?: number;
  now?: number;
  roomNameByFolder?: Record<string, string>;
}

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ROOMS = 5;

function emptyMetrics(): RoomUsageMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    responseCount: 0,
    updatedAt: null,
  };
}

function mergeMetrics(
  target: RoomUsageMetrics,
  next: Partial<RoomUsageMetrics>,
): RoomUsageMetrics {
  target.inputTokens += next.inputTokens || 0;
  target.outputTokens += next.outputTokens || 0;
  target.cacheTokens += next.cacheTokens || 0;
  target.reasoningTokens += next.reasoningTokens || 0;
  target.totalTokens += next.totalTokens || 0;
  target.responseCount += next.responseCount || 0;

  if (next.updatedAt) {
    if (!target.updatedAt || next.updatedAt > target.updatedAt) {
      target.updatedAt = next.updatedAt;
    }
  }

  return target;
}

function buildRoomNameByFolder(
  override?: Record<string, string>,
): Record<string, string> {
  if (override) return override;

  try {
    const groups = getAllRegisteredGroups();
    const result: Record<string, string> = {};
    for (const group of Object.values(groups)) {
      result[group.folder] = group.name;
    }
    return result;
  } catch {
    return {};
  }
}

function walkFiles(
  rootDir: string,
  predicate: (filePath: string) => boolean,
  files: string[] = [],
): string[] {
  if (!fs.existsSync(rootDir)) return files;

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, files);
      continue;
    }
    if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function parseFolderFromSessionsPath(
  baseSessionsDir: string,
  filePath: string,
): string | null {
  const relativePath = path.relative(baseSessionsDir, filePath);
  const [folder] = relativePath.split(path.sep);
  return folder || null;
}

function normalizeClaudeUsage(raw: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
} {
  const inputTokens =
    typeof raw.input_tokens === 'number' ? raw.input_tokens : 0;
  const outputTokens =
    typeof raw.output_tokens === 'number' ? raw.output_tokens : 0;
  const cacheCreationTokens =
    typeof raw.cache_creation_input_tokens === 'number'
      ? raw.cache_creation_input_tokens
      : 0;
  const cacheReadTokens =
    typeof raw.cache_read_input_tokens === 'number'
      ? raw.cache_read_input_tokens
      : 0;
  const cacheTokens = cacheCreationTokens + cacheReadTokens;

  return {
    inputTokens,
    outputTokens,
    cacheTokens,
    totalTokens: inputTokens + outputTokens + cacheTokens,
  };
}

function collectClaudeUsageFromFile(
  filePath: string,
  cutoffMs: number,
): RoomUsageMetrics {
  const seenByMessageId = new Map<
    string,
    {
      timestamp: number;
      inputTokens: number;
      outputTokens: number;
      cacheTokens: number;
      totalTokens: number;
    }
  >();

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== 'assistant') continue;
    if (parsed.message?.role !== 'assistant') continue;
    if (!parsed.message?.usage || typeof parsed.message.usage !== 'object') {
      continue;
    }

    const timestampMs = Date.parse(parsed.timestamp || '');
    if (Number.isNaN(timestampMs) || timestampMs < cutoffMs) continue;

    const usage = normalizeClaudeUsage(parsed.message.usage);
    const messageKey =
      parsed.message?.id || parsed.requestId || parsed.uuid || line;
    const existing = seenByMessageId.get(messageKey);
    if (
      !existing ||
      usage.totalTokens > existing.totalTokens ||
      timestampMs > existing.timestamp
    ) {
      seenByMessageId.set(messageKey, {
        timestamp: timestampMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheTokens: usage.cacheTokens,
        totalTokens: usage.totalTokens,
      });
    }
  }

  const metrics = emptyMetrics();
  for (const row of seenByMessageId.values()) {
    mergeMetrics(metrics, {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheTokens: row.cacheTokens,
      totalTokens: row.totalTokens,
      responseCount: 1,
      updatedAt: new Date(row.timestamp).toISOString(),
    });
  }
  return metrics;
}

function collectCodexUsageFromLogFile(
  filePath: string,
  cutoffMs: number,
): RoomUsageMetrics {
  const db = new Database(filePath, { readonly: true });
  const seenByResponseId = new Map<
    string,
    {
      timestampMs: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
    }
  >();

  try {
    const cutoffSec = Math.floor(cutoffMs / 1000);
    const rows = db
      .prepare(
        `SELECT feedback_log_body
         FROM logs
         WHERE ts >= ?
           AND feedback_log_body LIKE '%response.completed%'
           AND feedback_log_body LIKE '%total_tokens%'`,
      )
      .all(cutoffSec) as Array<{ feedback_log_body: string | null }>;

    for (const row of rows) {
      const body = row.feedback_log_body || '';
      const marker = 'websocket event: ';
      const markerIndex = body.indexOf(marker);
      if (markerIndex === -1) continue;

      let event: Record<string, any>;
      try {
        event = JSON.parse(body.slice(markerIndex + marker.length));
      } catch {
        continue;
      }

      if (event.type !== 'response.completed') continue;
      const response = event.response;
      if (!response?.usage || typeof response.usage !== 'object') continue;

      const timestampMs =
        typeof response.completed_at === 'number'
          ? response.completed_at * 1000
          : Date.parse(response.completed_at || '');
      if (Number.isNaN(timestampMs) || timestampMs < cutoffMs) continue;

      const usage = response.usage;
      const inputTokens =
        typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
      const outputTokens =
        typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
      const reasoningTokens =
        typeof usage.output_tokens_details?.reasoning_tokens === 'number'
          ? usage.output_tokens_details.reasoning_tokens
          : 0;
      const totalTokens =
        typeof usage.total_tokens === 'number'
          ? usage.total_tokens
          : inputTokens + outputTokens;
      const responseId = response.id || String(timestampMs);
      const existing = seenByResponseId.get(responseId);
      if (
        !existing ||
        totalTokens > existing.totalTokens ||
        timestampMs > existing.timestampMs
      ) {
        seenByResponseId.set(responseId, {
          timestampMs,
          inputTokens,
          outputTokens,
          reasoningTokens,
          totalTokens,
        });
      }
    }
  } finally {
    db.close();
  }

  const metrics = emptyMetrics();
  for (const row of seenByResponseId.values()) {
    mergeMetrics(metrics, {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      totalTokens: row.totalTokens,
      responseCount: 1,
      updatedAt: new Date(row.timestampMs).toISOString(),
    });
  }
  return metrics;
}

function sortRooms(rooms: RoomUsageEstimate[]): RoomUsageEstimate[] {
  return [...rooms].sort((a, b) => {
    if (b.metrics.totalTokens !== a.metrics.totalTokens) {
      return b.metrics.totalTokens - a.metrics.totalTokens;
    }
    if (a.name !== b.name) return a.name.localeCompare(b.name, 'ko');
    return a.folder.localeCompare(b.folder, 'en');
  });
}

export function collectClaudeRoomUsageSummary(
  options: CollectRoomUsageOptions = {},
): RoomUsageSummary {
  const baseSessionsDir =
    options.baseSessionsDir || path.join(DATA_DIR, 'sessions');
  const now = options.now ?? Date.now();
  const sinceMs = options.sinceMs ?? DEFAULT_SINCE_MS;
  const cutoffMs = now - sinceMs;
  const roomNameByFolder = buildRoomNameByFolder(options.roomNameByFolder);

  const roomMetrics = new Map<string, RoomUsageMetrics>();
  const claudeProjectFiles = walkFiles(baseSessionsDir, (filePath) => {
    return (
      filePath.includes(`${path.sep}.claude${path.sep}projects${path.sep}`) &&
      filePath.endsWith('.jsonl')
    );
  });

  for (const filePath of claudeProjectFiles) {
    const folder = parseFolderFromSessionsPath(baseSessionsDir, filePath);
    if (!folder) continue;
    const metrics = collectClaudeUsageFromFile(filePath, cutoffMs);
    if (metrics.totalTokens === 0) continue;
    const current = roomMetrics.get(folder) || emptyMetrics();
    roomMetrics.set(folder, mergeMetrics(current, metrics));
  }

  const rooms = sortRooms(
    [...roomMetrics.entries()].map(([folder, metrics]) => ({
      provider: 'claude' as const,
      folder,
      name: roomNameByFolder[folder] || folder,
      metrics,
    })),
  );

  const totals = emptyMetrics();
  for (const room of rooms) {
    mergeMetrics(totals, room.metrics);
  }

  return {
    provider: 'claude',
    rooms,
    totals,
    sinceMs,
  };
}

export function collectCodexRoomUsageSummary(
  options: CollectRoomUsageOptions = {},
): RoomUsageSummary {
  const baseSessionsDir =
    options.baseSessionsDir || path.join(DATA_DIR, 'sessions');
  const now = options.now ?? Date.now();
  const sinceMs = options.sinceMs ?? DEFAULT_SINCE_MS;
  const cutoffMs = now - sinceMs;
  const roomNameByFolder = buildRoomNameByFolder(options.roomNameByFolder);

  const roomMetrics = new Map<string, RoomUsageMetrics>();
  const codexLogFiles = walkFiles(baseSessionsDir, (filePath) => {
    return (
      filePath.includes(`${path.sep}.codex${path.sep}`) &&
      /logs_\d+\.sqlite$/.test(filePath)
    );
  });

  for (const filePath of codexLogFiles) {
    const folder = parseFolderFromSessionsPath(baseSessionsDir, filePath);
    if (!folder) continue;
    const metrics = collectCodexUsageFromLogFile(filePath, cutoffMs);
    if (metrics.totalTokens === 0) continue;
    const current = roomMetrics.get(folder) || emptyMetrics();
    roomMetrics.set(folder, mergeMetrics(current, metrics));
  }

  const rooms = sortRooms(
    [...roomMetrics.entries()].map(([folder, metrics]) => ({
      provider: 'codex' as const,
      folder,
      name: roomNameByFolder[folder] || folder,
      metrics,
    })),
  );

  const totals = emptyMetrics();
  for (const room of rooms) {
    mergeMetrics(totals, room.metrics);
  }

  return {
    provider: 'codex',
    rooms,
    totals,
    sinceMs,
  };
}

function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(1)}m`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return String(value);
}

function truncateLabel(label: string, maxLength: number): string {
  if (label.length <= maxLength) return label;
  return `${label.slice(0, maxLength - 1)}…`;
}

function formatProviderSummaryLine(summary: RoomUsageSummary): string {
  if (summary.provider === 'claude') {
    return `${'Claude Σ'.padEnd(12)}I ${formatCompactTokens(summary.totals.inputTokens).padStart(6)} O ${formatCompactTokens(summary.totals.outputTokens).padStart(6)} C ${formatCompactTokens(summary.totals.cacheTokens).padStart(6)}`;
  }
  return `${'Codex Σ'.padEnd(12)}I ${formatCompactTokens(summary.totals.inputTokens).padStart(6)} O ${formatCompactTokens(summary.totals.outputTokens).padStart(6)} R ${formatCompactTokens(summary.totals.reasoningTokens).padStart(6)}`;
}

function formatRoomLine(room: RoomUsageEstimate): string {
  const label = truncateLabel(room.name, 10).padEnd(10);
  if (room.provider === 'claude') {
    return `${label} I ${formatCompactTokens(room.metrics.inputTokens).padStart(6)} O ${formatCompactTokens(room.metrics.outputTokens).padStart(6)} C ${formatCompactTokens(room.metrics.cacheTokens).padStart(6)}`;
  }
  return `${label} I ${formatCompactTokens(room.metrics.inputTokens).padStart(6)} O ${formatCompactTokens(room.metrics.outputTokens).padStart(6)} R ${formatCompactTokens(room.metrics.reasoningTokens).padStart(6)}`;
}

export function buildRoomUsageEstimateLines(args: {
  claude: RoomUsageSummary;
  codex: RoomUsageSummary;
  maxRoomsPerProvider?: number;
}): string[] {
  const providers = [args.claude, args.codex].filter(
    (summary) => summary.rooms.length > 0,
  );
  if (providers.length === 0) return [];

  const maxRoomsPerProvider = args.maxRoomsPerProvider ?? DEFAULT_MAX_ROOMS;
  const lines = ['🧾 *방별 추정 사용량 (24h)*', '```'];

  providers.forEach((summary, index) => {
    lines.push(formatProviderSummaryLine(summary));
    const visibleRooms = summary.rooms.slice(0, maxRoomsPerProvider);
    for (const room of visibleRooms) {
      lines.push(formatRoomLine(room));
    }
    const hiddenCount = summary.rooms.length - visibleRooms.length;
    if (hiddenCount > 0) {
      lines.push(`+${hiddenCount}개 방`);
    }
    if (index < providers.length - 1) {
      lines.push('─'.repeat(38));
    }
  });

  lines.push('```');
  return lines;
}
