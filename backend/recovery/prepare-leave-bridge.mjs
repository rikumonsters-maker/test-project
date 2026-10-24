import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Run against a separate worktree at the documented pre-migration main commit.
// This script changes only its backend/src/shared.ts and refuses unknown source.
const worktree = process.argv[2];
if (!worktree) throw new Error('A separate worktree path is required');
const file = join(resolve(worktree), 'backend', 'src', 'shared.ts');
const source = readFileSync(file, 'utf8');
const original = "if (pathname === '/api/groups/leave') return leaveGroup(env.DB, body, user);";
const replacement = "if (pathname === '/api/groups/leave') return jsonResponse({ error:'グループ退出は安全確認のため一時停止中です。' }, 503);";
if (source.split(original).length !== 2) throw new Error('The bridge source is not the reviewed main version');
writeFileSync(file, source.replace(original, replacement));
console.log('Prepared the leave-only bridge. Review the one-line diff before use.');
