import test from 'node:test';
import assert from 'node:assert/strict';
import { runGh } from './github-cli.mjs';

test('pending PR checks remain readable for the polling gate', () => {
  const pending = new Error('checks pending');
  pending.status = 8;
  pending.stdout = '[{"name":"Vercel","bucket":"pending"}]';
  assert.deepEqual(JSON.parse(runGh(['pr','checks','12','--json','name,bucket'], () => { throw pending; })),
    [{ name:'Vercel', bucket:'pending' }]);
});

test('failed or unrelated CLI commands stop rather than being treated as pending', () => {
  for (const args of [['pr','checks'],['pr','view']]) {
    const failure = new Error('failure');
    failure.status = args[1] === 'checks' ? 1 : 8;
    failure.stdout = '[]';
    assert.throws(() => runGh(args, () => { throw failure; }), /failure/);
  }
});
