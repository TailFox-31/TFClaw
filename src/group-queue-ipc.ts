import fs from 'fs';
import path from 'path';

function resolveInputDir(ipcDir: string): string {
  return path.join(ipcDir, 'input');
}

export function queueFollowUpMessage(ipcDir: string, text: string): string {
  const inputDir = resolveInputDir(ipcDir);
  fs.mkdirSync(inputDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  const filepath = path.join(inputDir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
  fs.renameSync(tempPath, filepath);
  return filename;
}

export function writeCloseSentinel(ipcDir: string): void {
  const inputDir = resolveInputDir(ipcDir);
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, '_close'), '');
}
