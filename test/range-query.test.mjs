import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startSource } from '../src/source.mjs';

test('范围参数不会改变来源资源定位', async () => {
  const cases = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
  const source = await startSource(cases[0]);
  try {
    const reply = await fetch(source.url + '/data?from=0&until=100');
    assert.equal(reply.status, 200);
    assert.deepEqual((await reply.json()).range, [0, 100]);
    assert.ok(source.history.some(entry => entry.path === '/data?from=0&until=100'));
  } finally { await source.close(); }
});
