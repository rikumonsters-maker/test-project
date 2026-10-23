#!/usr/bin/env node
// Validate migration ordering against disposable in-memory SQLite databases.
// This script never opens a local or production D1 database.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(toolsDir, '..', 'migrations');
const archived0011 = path.resolve(toolsDir, '..', '..', '.local-legacy-archive',
  'worktrees', 'money-app', 'backend', 'migrations', '0011_password_recovery.sql');
const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
const expectedNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14];
assert.deepEqual(files.map((name) => Number(name.slice(0, 4))), expectedNumbers);
assert(!files.some((name) => name.startsWith('0011_')));

const legacySql = existsSync(archived0011) ? readFileSync(archived0011, 'utf8') : null;
if (legacySql) assert(!/(?:^|;)\s*(?:DROP|DELETE|TRUNCATE)\b/im.test(legacySql));
for (const insertion of ['before-0012', 'after-0014']) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const name of files) {
      if (legacySql && insertion === 'before-0012' && name.startsWith('0012_')) db.exec(legacySql);
      db.exec(readFileSync(path.join(migrationsDir, name), 'utf8'));
    }
    if (legacySql && insertion === 'after-0014') db.exec(legacySql);
    if (legacySql) {
      const tables = db.prepare(`SELECT name FROM sqlite_master
        WHERE type='table' AND name IN ('password_reset_tokens', 'auth_rate_limits')
        ORDER BY name`).all().map((row) => row.name);
      assert.deepEqual(tables, ['auth_rate_limits', 'password_reset_tokens']);
    }
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
}
console.log(`Migration layout verified: ${files.length} active SQL files; 0011 excluded; archived 0011 order check ${legacySql ? 'passed' : 'skipped (private archive unavailable)'}.`);
