/**
 * NanoClaw Codex Runner
 *
 * Default runtime is Codex app-server, with SDK fallback available via
 * CODEX_RUNTIME=sdk or automatic fallback when app-server startup fails.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages as JSON files in $NANOCLAW_IPC_DIR/input/
 *          Sentinel: _close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import { Codex, type Thread, type ThreadOptions, type UserInput } from '@openai/codex-sdk';
import fs from 'fs';
import path from 'path';

import {
  CodexAppServerClient,
  type AppServerInputItem,
} from './app-server-client.js';

// ── Types ──────────────────────────────────────────────────────────

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentType?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const WORK_DIR = process.env.NANOCLAW_WORK_DIR || '';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const MAX_TURNS = 100;
const CODEX_RUNTIME = (process.env.CODEX_RUNTIME || 'app-server').toLowerCase();

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const EFFECTIVE_CWD = WORK_DIR || GROUP_DIR;
const CODEX_MODEL = process.env.CODEX_MODEL || '';
const CODEX_EFFORT = process.env.CODEX_EFFORT || '';

let closeRequested = false;

// ── Helpers ────────────────────────────────────────────────────────

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[codex-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function consumeCloseSentinel(): boolean {
  if (closeRequested) return true;
  if (!fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) return false;

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  closeRequested = true;
  return true;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (consumeCloseSentinel()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function extractImagePaths(text: string): { cleanText: string; imagePaths: string[] } {
  const imagePattern = /\[Image:\s*(\/[^\]]+)\]/g;
  const imagePaths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = imagePattern.exec(text)) !== null) {
    imagePaths.push(match[1].trim());
  }

  return {
    cleanText: text.replace(imagePattern, '').trim(),
    imagePaths,
  };
}

function parseSdkInput(text: string): string | UserInput[] {
  const { cleanText, imagePaths } = extractImagePaths(text);
  if (imagePaths.length === 0) return text;

  const input: UserInput[] = [];
  if (cleanText) {
    input.push({ type: 'text', text: cleanText });
  }
  for (const imgPath of imagePaths) {
    if (fs.existsSync(imgPath)) {
      input.push({ type: 'local_image', path: imgPath });
      log(`Adding image input: ${imgPath}`);
    } else {
      log(`Image not found, skipping: ${imgPath}`);
    }
  }
  return input.length > 0 ? input : text;
}

function parseAppServerInput(text: string): AppServerInputItem[] {
  const { cleanText, imagePaths } = extractImagePaths(text);
  const input: AppServerInputItem[] = [];

  if (cleanText) {
    input.push({ type: 'text', text: cleanText });
  }

  for (const imgPath of imagePaths) {
    if (fs.existsSync(imgPath)) {
      input.push({ type: 'localImage', path: imgPath });
      log(`Adding image input: ${imgPath}`);
    } else {
      log(`Image not found, skipping: ${imgPath}`);
    }
  }

  if (input.length === 0) {
    input.push({ type: 'text', text });
  }

  return input;
}

function getThreadOptions(): ThreadOptions {
  const threadOptions: ThreadOptions = {
    workingDirectory: EFFECTIVE_CWD,
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    networkAccessEnabled: true,
    webSearchMode: 'live',
  };
  if (CODEX_MODEL) threadOptions.model = CODEX_MODEL;
  if (CODEX_EFFORT) {
    threadOptions.modelReasoningEffort =
      CODEX_EFFORT as ThreadOptions['modelReasoningEffort'];
  }
  return threadOptions;
}

async function executeSdkTurn(
  thread: Thread,
  input: string | UserInput[],
): Promise<{ result: string; error?: string }> {
  const ac = new AbortController();

  let turnSeconds = 0;
  const sentinel = setInterval(() => {
    if (consumeCloseSentinel()) {
      log('Close sentinel detected during SDK turn, aborting');
      ac.abort();
      return;
    }
    turnSeconds += 5;
    if (turnSeconds % 60 === 0) {
      log(`Turn in progress... (${Math.round(turnSeconds / 60)}min)`);
    }
  }, 5000);

  try {
    const turn = await thread.run(input, { signal: ac.signal });
    return { result: turn.finalResponse };
  } catch (err) {
    if (ac.signal.aborted) {
      return { result: '' };
    }
    return {
      result: '',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearInterval(sentinel);
  }
}

async function executeAppServerTurn(
  client: CodexAppServerClient,
  threadId: string,
  prompt: string,
): Promise<{ result: string; error?: string }> {
  const activeTurn = await client.startTurn(threadId, parseAppServerInput(prompt), {
    cwd: EFFECTIVE_CWD,
    model: CODEX_MODEL || undefined,
    effort: CODEX_EFFORT || undefined,
  });

  let elapsedMs = 0;
  let polling = true;
  const pollDuringTurn = async () => {
    if (!polling) return;

    if (consumeCloseSentinel()) {
      log('Close sentinel detected during app-server turn, interrupting');
      polling = false;
      try {
        await activeTurn.interrupt();
      } catch (err) {
        log(
          `Failed to interrupt active turn: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    const messages = drainIpcInput();
    if (messages.length > 0) {
      const merged = messages.join('\n');
      log(`Steering active turn with ${messages.length} queued message(s)`);
      try {
        await activeTurn.steer(parseAppServerInput(merged));
      } catch (err) {
        log(
          `turn/steer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    elapsedMs += IPC_POLL_MS;
    if (elapsedMs > 0 && elapsedMs % 60000 === 0) {
      log(`Turn in progress... (${Math.round(elapsedMs / 60000)}min)`);
    }
    setTimeout(() => void pollDuringTurn(), IPC_POLL_MS);
  };

  setTimeout(() => void pollDuringTurn(), IPC_POLL_MS);

  try {
    const { state, result } = await activeTurn.wait();
    if (state.status === 'completed') {
      return { result: result || '' };
    }
    if (state.status === 'interrupted' && consumeCloseSentinel()) {
      return { result: result || '' };
    }
    return {
      result: result || '',
      error: state.errorMessage || `Codex turn finished with status ${state.status}`,
    };
  } finally {
    polling = false;
  }
}

async function runSdkSession(
  containerInput: ContainerInput,
  prompt: string,
): Promise<void> {
  const threadOptions = getThreadOptions();
  const codex = new Codex();

  let thread: Thread;
  if (containerInput.sessionId) {
    thread = codex.resumeThread(containerInput.sessionId, threadOptions);
    log(`Thread resuming (session: ${containerInput.sessionId})`);
  } else {
    thread = codex.startThread(threadOptions);
    log('Thread started (new session)');
  }

  let turnCount = 0;
  while (true) {
    turnCount++;
    if (turnCount > MAX_TURNS) {
      log(`Turn limit reached (${MAX_TURNS}), exiting`);
      writeOutput({
        status: 'success',
        result: '[세션 턴 제한 도달. 새 메시지로 다시 시작됩니다.]',
        newSessionId: thread.id || undefined,
      });
      break;
    }

    const input = parseSdkInput(prompt);
    log(`Starting SDK turn ${turnCount}/${MAX_TURNS}...`);

    let { result, error } = await executeSdkTurn(thread, input);

    if (error && turnCount === 1 && containerInput.sessionId) {
      log(`Resume may have failed, retrying with new thread: ${error}`);
      thread = codex.startThread(threadOptions);
      ({ result, error } = await executeSdkTurn(thread, input));
    }

    if (consumeCloseSentinel()) {
      if (result) {
        writeOutput({
          status: 'success',
          result,
          newSessionId: thread.id || undefined,
        });
      }
      log('Close sentinel detected, exiting SDK runtime');
      break;
    }

    if (error) {
      log(`SDK turn error: ${error}`);
      writeOutput({
        status: 'error',
        result: result || null,
        newSessionId: thread.id || undefined,
        error,
      });
    } else {
      writeOutput({
        status: 'success',
        result: result || null,
        newSessionId: thread.id || undefined,
      });
    }

    log('SDK turn done, waiting for next IPC message...');

    const nextMessage = await waitForIpcMessage();
    if (nextMessage === null) {
      log('Close sentinel received, exiting SDK runtime');
      break;
    }

    log(`Got new SDK message (${nextMessage.length} chars)`);
    prompt = nextMessage;
  }
}

async function runAppServerCompact(
  client: CodexAppServerClient,
  threadId: string | undefined,
): Promise<void> {
  if (!threadId) {
    writeOutput({
      status: 'success',
      result: '현재 활성 Codex 세션이 없어 compact를 건너뜁니다.',
    });
    return;
  }

  const { state } = await client.startCompaction(threadId);
  if (state.status === 'failed') {
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: threadId,
      error: state.errorMessage || 'Conversation compaction failed.',
    });
    return;
  }

  writeOutput({
    status: 'success',
    result: state.compactionCompleted
      ? 'Conversation compacted.'
      : 'Compaction requested but contextCompaction was not observed.',
    newSessionId: threadId,
  });
}

async function runAppServerSession(
  containerInput: ContainerInput,
  prompt: string,
): Promise<void> {
  const client = new CodexAppServerClient({
    cwd: EFFECTIVE_CWD,
    env: process.env,
    log,
  });

  await client.start();

  let threadId: string | undefined;
  try {
    try {
      threadId = await client.startOrResumeThread(containerInput.sessionId, {
        cwd: EFFECTIVE_CWD,
        model: CODEX_MODEL || undefined,
      });
      log(
        containerInput.sessionId
          ? `App-server thread resumed (${threadId})`
          : `App-server thread started (${threadId})`,
      );
    } catch (err) {
      if (!containerInput.sessionId) throw err;
      log(
        `App-server resume failed, retrying with new thread: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      threadId = await client.startOrResumeThread(undefined, {
        cwd: EFFECTIVE_CWD,
        model: CODEX_MODEL || undefined,
      });
      log(`App-server thread restarted (${threadId})`);
    }

    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt === '/compact') {
      await runAppServerCompact(client, threadId);
      return;
    }

    let turnCount = 0;
    while (true) {
      turnCount++;
      if (turnCount > MAX_TURNS) {
        log(`Turn limit reached (${MAX_TURNS}), exiting`);
        writeOutput({
          status: 'success',
          result: '[세션 턴 제한 도달. 새 메시지로 다시 시작됩니다.]',
          newSessionId: threadId,
        });
        break;
      }

      log(`Starting app-server turn ${turnCount}/${MAX_TURNS}...`);
      const { result, error } = await executeAppServerTurn(client, threadId, prompt);

      if (consumeCloseSentinel()) {
        if (result) {
          writeOutput({
            status: 'success',
            result,
            newSessionId: threadId,
          });
        }
        log('Close sentinel detected, exiting app-server runtime');
        break;
      }

      if (error) {
        log(`App-server turn error: ${error}`);
        writeOutput({
          status: 'error',
          result: result || null,
          newSessionId: threadId,
          error,
        });
      } else {
        writeOutput({
          status: 'success',
          result: result || null,
          newSessionId: threadId,
        });
      }

      log('App-server turn done, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting app-server runtime');
        break;
      }

      log(`Got new app-server message (${nextMessage.length} chars)`);
      prompt = nextMessage;
    }
  } finally {
    await client.close();
  }
}

function shouldUseAppServer(): boolean {
  return CODEX_RUNTIME !== 'sdk';
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    process.exit(1);
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  closeRequested = false;
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  const preferAppServer = shouldUseAppServer();
  try {
    if (preferAppServer) {
      try {
        log(`Runtime selected: app-server (${CODEX_RUNTIME})`);
        await runAppServerSession(containerInput, prompt);
        return;
      } catch (err) {
        if (CODEX_RUNTIME === 'app-server') {
          log(
            `App-server runtime failed, falling back to SDK: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        } else {
          throw err;
        }
      }
    }

    log('Runtime selected: sdk');
    await runSdkSession(containerInput, prompt);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Runner error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
  }
}

main();
