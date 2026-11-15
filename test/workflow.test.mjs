import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';
import { run, createCoordinator } from '../src/workflow.mjs';

const dataRequests = source => source.history.filter(entry => entry.path.split('?')[0] === '/data');

async function withStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'material-workflow-'));
  try { await fn(stateDir); }
  finally { await rm(stateDir, { recursive: true, force: true }); }
}

test('恢复：原始文件已写入但订阅尚未通知，重启后直接完成且不再请求来源', async () => {
  const source = await startSource({ name: '恢复演练', routes: [{ path: '/data', body: { capturedAt: 100, range: [0, 100], ids: ['a'] } }] });
  await withStateDir(async stateDir => {
    try {
      await mkdir(path.join(stateDir, 'data'), { recursive: true });
      // 崩溃前的现场：订阅已提交、原始响应已落盘，但完成事件尚未登记。
      await writeFile(path.join(stateDir, 'journal.jsonl'), JSON.stringify({
        seq: 1, t: 0, type: 'submit', id: 'daily', dataset: 'default',
        range: [0, 100], maxAge: 10, deadline: 5000, deadlineAt: Date.now() + 5000
      }) + '\n');
      await writeFile(path.join(stateDir, 'data', 'fetch-1.json'), JSON.stringify({
        fetch: 'fetch-1', dataset: 'default', range: [0, 100], capturedAt: 100,
        receivedAt: Date.now(), body: { capturedAt: 100, range: [0, 100], ids: ['a'] }
      }));
      const result = await run({ source: source.url, stateDir, input: { now: 100, operations: [] } });
      assert.equal(result.subscribers.daily, 'complete');
      assert.equal(dataRequests(source).length, 0, '恢复不应重新请求来源');
      const saved = JSON.parse(await readFile(path.join(stateDir, 'result.json'), 'utf8'));
      assert.equal(saved.subscribers.daily, 'complete');
    } finally { await source.close(); }
  });
});

test('取消只影响对应句柄：共享抓取继续，且只发一次范围请求', async () => {
  const source = await startSource({ name: '共享取消独立', routes: [{ path: '/data', body: { capturedAt: 100, range: [0, 100], ids: ['a'] }, delay: 60 }] });
  await withStateDir(async stateDir => {
    try {
      const result = await run({
        source: source.url, stateDir,
        input: {
          now: 100,
          operations: [
            { at: 0, action: 'submit', id: 'daily', range: [0, 100], maxAge: 10, deadline: 400 },
            { at: 10, action: 'submit', id: 'desk', range: [0, 100], maxAge: 10, deadline: 400 },
            { at: 20, action: 'cancel', id: 'desk' }
          ]
        }
      });
      assert.equal(result.subscribers.daily, 'complete');
      assert.equal(result.subscribers.desk, 'cancelled');
      assert.equal(result.fetches.length, 1, '两个需求应共享同一次抓取');
      assert.deepEqual(result.fetches[0].served, ['daily']);
      assert.equal(dataRequests(source).length, 1, '供方只应看到一次范围请求');
    } finally { await source.close(); }
  });
});

test('需求过期后任务无等待者则中断，后续需求重新采集且互不相干', async () => {
  const source = await startSource({ name: '过期释放抓取', routes: [{ path: '/data', body: { capturedAt: 100, range: [0, 100], ids: ['a'] }, delay: 60 }] });
  await withStateDir(async stateDir => {
    try {
      const result = await run({
        source: source.url, stateDir,
        input: {
          now: 100,
          operations: [
            { at: 0, action: 'submit', id: 'brief', range: [0, 100], maxAge: 10, deadline: 20 },
            { at: 30, action: 'submit', id: 'later', range: [0, 100], maxAge: 10, deadline: 500 }
          ]
        }
      });
      assert.equal(result.subscribers.brief, 'expired');
      assert.equal(result.subscribers.later, 'complete');
      assert.equal(dataRequests(source).length, 2, '过期中断一次、新需求重新采集一次');
      const statuses = result.fetches.map(fetch => fetch.status).sort();
      assert.deepEqual(statuses, ['aborted', 'succeeded']);
    } finally { await source.close(); }
  });
});

test('协调器提供提交、查询和取消接口，已落盘资料直接复用', async () => {
  const source = await startSource({ name: '接口演练', routes: [{ path: '/data', body: { capturedAt: 100, range: [0, 100], ids: ['a'] }, delay: 40 }] });
  await withStateDir(async stateDir => {
    const coordinator = await createCoordinator({ source: source.url, stateDir, now: 100 });
    try {
      const first = coordinator.submit({ id: 'x', range: [0, 100], maxAge: 10, deadline: 500 });
      assert.equal(first.status, 'pending');
      assert.equal(coordinator.query('x').status, 'pending');
      await coordinator.idle();
      assert.equal(coordinator.query('x').status, 'complete');
      assert.equal(coordinator.cancel('x'), false, '已完成的需求不可取消');

      const second = coordinator.submit({ id: 'y', range: [0, 100], maxAge: 10, deadline: 500 });
      assert.equal(second.status, 'complete', '已落盘的新鲜资料应直接复用');
      assert.equal(dataRequests(source).length, 1, '复用不应再请求来源');

      const third = coordinator.submit({ id: 'z', range: [200, 300], maxAge: 10, deadline: 500 });
      assert.equal(third.status, 'pending');
      assert.equal(coordinator.cancel('z'), true);
      assert.equal(coordinator.query('z').status, 'cancelled');
      assert.equal(coordinator.query('x').status, 'complete', '取消 z 不应波及其他句柄');
      assert.equal(coordinator.cancel('unknown'), false, '未知句柄取消应落空');
      assert.equal(coordinator.query('unknown'), null);
    } finally {
      await coordinator.close();
      await source.close();
    }
  });
});
