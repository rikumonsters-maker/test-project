import { execFileSync } from 'node:child_process';

export function runGh(args, execute = execFileSync) {
  try {
    return execute('gh', args, { encoding:'utf8', maxBuffer:4*1024*1024 }).trim();
  } catch (error) {
    // gh pr checks emits valid JSON with exit code 8 while checks are pending.
    if (args[0] === 'pr' && args[1] === 'checks' && error.status === 8 && error.stdout)
      return String(error.stdout).trim();
    throw error;
  }
}
