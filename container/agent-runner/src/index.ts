/**
 * EJClaw Reviewer Container Agent Runner
 *
 * Runs inside a Docker container. Reads input from stdin,
 * invokes Claude Code or Codex, writes output to stdout
 * via marker-delimited JSON.
 *
 * The project directory is mounted read-only — the reviewer
 * can read/test code but cannot modify it.
 */
import { claude } from '@anthropic-ai/claude-code';
import fs from 'fs';
import path from 'path';

// ── Protocol markers (must match host's agent-protocol.ts) ────────
const OUTPUT_START_MARKER = '---EJCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---EJCLAW_OUTPUT_END---';

// ── Types ─────────────────────────────────────────────────────────
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  runId: string;
  isMain: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  phase: 'final';
}

// ── Helpers ───────────────────────────────────────────────────────

function emitOutput(output: ContainerOutput): void {
  const json = JSON.stringify(output);
  process.stdout.write(`${OUTPUT_START_MARKER}${json}${OUTPUT_END_MARKER}\n`);
}

function readStdinJson(): Promise<ContainerInput> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (err) {
        reject(new Error(`Failed to parse stdin JSON: ${err}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readStdinJson();

  // Load group CLAUDE.md if present
  const groupClaudeMd = path.join('/workspace/group', 'CLAUDE.md');
  const systemPromptParts: string[] = [];
  if (fs.existsSync(groupClaudeMd)) {
    systemPromptParts.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  // Reviewer-specific instructions
  systemPromptParts.push(
    'You are a code reviewer. The project directory is mounted read-only.',
    'You can read files, run tests, and analyze code, but you cannot modify any source files.',
    'Focus on: correctness, security, performance, and test coverage.',
  );

  const systemPrompt = systemPromptParts.join('\n\n');

  try {
    const result = await claude({
      prompt: input.prompt,
      systemPrompt,
      options: {
        allowedTools: [
          'Read',
          'Bash',
          'Glob',
          'Grep',
          'LS',
          'Agent',
          'WebSearch',
          'WebFetch',
        ],
        maxTurns: 30,
        cwd: '/workspace/project',
      },
    });

    // Extract text from result
    const text =
      typeof result === 'string'
        ? result
        : Array.isArray(result)
          ? result
              .filter(
                (b: { type: string; text?: string }) => b.type === 'text',
              )
              .map((b: { text?: string }) => b.text || '')
              .join('\n')
          : String(result);

    emitOutput({
      status: 'success',
      result: text,
      phase: 'final',
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    emitOutput({
      status: 'error',
      result: null,
      error: errorMsg,
      phase: 'final',
    });
  }
}

main().catch((err) => {
  console.error('Fatal container error:', err);
  emitOutput({
    status: 'error',
    result: null,
    error: `Fatal: ${err instanceof Error ? err.message : String(err)}`,
    phase: 'final',
  });
  process.exit(1);
});
