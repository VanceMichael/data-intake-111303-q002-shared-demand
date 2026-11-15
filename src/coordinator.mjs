import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openJournal, loadRawPieces, writeFileAtomic } from './journal.mjs';

// 采集策略常量：重试间隔、单个需求在一次运行内的抓取尝试预算、剩余时间不足则不再发起新抓取。
export const RETRY_DELAY_MS = 10;
export const MAX_ATTEMPTS = 4;
export const MIN_USEFUL_MS = 8;

const intersects = (a, b) => a[0] <= b[1] && b[0] <= a[1];

// 从 range 中扣掉 covered 已覆盖的部分，返回剩余区间。闭区间，端点相接视为已覆盖。
function subtract(range, covered) {
  let remaining = [[range[0], range[1]]];
  for (const interval of covered) {
    const next = [];
    for (const [start, end] of remaining) {
      if (interval[1] < start || interval[0] > end) { next.push([start, end]); continue; }
      if (interval[0] > start) next.push([start, Math.min(interval[0], end)]);
      if (interval[1] < end) next.push([Math.max(interval[1], start), end]);
    }
    remaining = next;
  }
  return remaining.filter(([start, end]) => start < end);
}

// 判断 fresh 片段能否拼出 range；能则返回实际用到的片段（作为完成依据），否则返回 null。
function coverPieces(fresh, range) {
  const sorted = [...fresh].sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1]);
  const used = [];
  let cursor = range[0];
  while (cursor < range[1]) {
    let best = null;
    for (const piece of sorted) {
      if (piece.range[0] <= cursor && piece.range[1] > cursor && (!best || piece.range[1] > best.range[1])) best = piece;
    }
    if (!best) return null;
    used.push(best);
    cursor = best.range[1];
  }
  return used;
}

const fetchNumber = id => Number(String(id).replace(/^fetch-/, '')) || 0;

// 按需采集协调器：需求（谁在等什么）与抓取任务（实际向供方发了什么请求）分开登记。
// 兼容需求共享在途抓取与原始响应，但新鲜度、覆盖范围、完成状态逐需求独立判定；
// 取消与过期只摘下自己的挂载，不丢弃别人的结果。
export async function createCoordinator({ source, stateDir, now }) {
  if (!source) throw new Error('缺少来源地址 source');
  if (!stateDir) throw new Error('缺少状态目录 stateDir');
  const businessNow = now ?? Math.floor(Date.now() / 1000);
  await mkdir(path.join(stateDir, 'data'), { recursive: true });
  const journal = await openJournal(stateDir);
  const startedAt = Date.now();
  const clock = () => Date.now() - startedAt;

  const demands = new Map();   // id -> 需求：数据集、规范化范围、允许资料年龄、截止时刻、状态
  const tasks = new Map();     // fetchId -> 抓取任务：实际发往供方的范围请求
  const pieces = [];           // 已落盘的原始响应目录
  const timers = new Set();
  const idleWaiters = new Set();
  const errors = [];
  let fetchSeq = 0;
  let pendingOps = 0;
  let closed = false;
  let persistenceError = null;

  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  const cancelTimer = timer => { if (timer) { clearTimeout(timer); timers.delete(timer); } };

  function checkIdle() {
    if (pendingOps > 0) return;
    for (const demand of demands.values()) if (demand.status === 'pending') return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function buildResult() {
    const subscribers = {};
    const detail = {};
    for (const demand of demands.values()) {
      subscribers[demand.id] = demand.status;
      detail[demand.id] = {
        status: demand.status,
        dataset: demand.dataset,
        range: [...demand.range],
        maxAge: demand.maxAge,
        deadline: demand.deadline,
        attempts: demand.attempts,
        evidence: [...demand.evidence]
      };
    }
    const fetches = [...tasks.values()].map(task => ({
      id: task.id,
      dataset: task.dataset,
      range: [...task.range],
      status: task.status,
      capturedAt: task.capturedAt ?? undefined,
      served: [...demands.values()].filter(demand => demand.evidence.includes(task.id)).map(demand => demand.id)
    }));
    const result = { subscribers, detail, fetches };
    if (errors.length) result.errors = [...errors];
    return result;
  }

  async function persistResult() {
    try { await writeFileAtomic(path.join(stateDir, 'result.json'), JSON.stringify(buildResult(), null, 2)); }
    catch (error) { persistenceError = error; }
  }

  // 需求自己的新鲜度判定：同一份原始响应，maxAge 不同的需求结论不同。
  function freshPiecesFor(demand) {
    return pieces.filter(piece =>
      piece.dataset === demand.dataset
      && businessNow - piece.capturedAt <= demand.maxAge
      && intersects(piece.range, demand.range));
  }

  function evaluate(demand) {
    if (demand.status !== 'pending') return;
    const used = coverPieces(freshPiecesFor(demand), demand.range);
    if (!used) return;
    demand.status = 'complete';
    demand.evidence = used.map(piece => piece.fetch);
    finishDemand(demand, 'complete');
  }

  function finishDemand(demand, type) {
    cancelTimer(demand.timer);
    cancelTimer(demand.replanTimer);
    demand.timer = demand.replanTimer = null;
    detach(demand);
    journal.append({ t: clock(), type, id: demand.id, evidence: demand.evidence.length ? [...demand.evidence] : undefined });
    persistResult();
    checkIdle();
  }

  // 摘下需求与任务的挂载；任务没有任何等待者时才中断，避免一个订阅到期拖垮别人。
  function detach(demand) {
    for (const fetchId of demand.attachments) {
      const task = tasks.get(fetchId);
      if (!task) continue;
      task.waiters.delete(demand.id);
      if (task.status === 'running' && task.waiters.size === 0) abortTask(task);
    }
    demand.attachments.clear();
  }

  // 供方允许中断，但取消到达时正文可能已经在返回：abort 只是尽力而为，
  // 若响应仍然到达，execute 会照常落盘并登记，供后续需求复用。
  function abortTask(task) {
    if (task.status !== 'running') return;
    task.abortRequested = true;
    task.controller.abort();
  }

  function expireDemand(demand) {
    if (demand.status !== 'pending') return;
    demand.status = 'expired';
    finishDemand(demand, 'expire');
  }

  function cancelDemand(id) {
    const demand = demands.get(id);
    if (!demand || demand.status !== 'pending') return false;
    demand.status = 'cancelled';
    finishDemand(demand, 'cancel');
    return true;
  }

  // 范围规划：已落盘的新鲜资料与在途任务先抵扣，剩下的差集才发起新抓取。
  // 任务一旦发起范围不再扩大，新到的宽需求只挂载、补差或另起，避免无限扩张拖死短请求。
  function plan(demand) {
    if (closed || demand.status !== 'pending') return;
    const remaining = demand.deadlineAt - Date.now();
    if (remaining <= 0) { expireDemand(demand); return; }
    const running = [...tasks.values()].filter(task =>
      task.status === 'running' && task.dataset === demand.dataset && intersects(task.range, demand.range));
    for (const task of running) {
      demand.attachments.add(task.id);
      task.waiters.add(demand.id);
    }
    const covered = [...freshPiecesFor(demand).map(piece => piece.range), ...running.map(task => task.range)];
    const uncovered = subtract(demand.range, covered);
    if (uncovered.length === 0) return; // 在途抓取与已存资料足够，静候完成
    if (remaining < MIN_USEFUL_MS) return;
    for (const interval of uncovered) {
      if (demand.attempts >= MAX_ATTEMPTS) return; // 尝试预算用完，等待自己的截止时刻
      startFetch(demand, interval);
    }
  }

  function startFetch(demand, interval) {
    demand.attempts += 1;
    fetchSeq += 1;
    const task = {
      id: 'fetch-' + fetchSeq,
      dataset: demand.dataset,
      range: [interval[0], interval[1]],
      status: 'running',
      capturedAt: null,
      file: null,
      abortRequested: false,
      controller: new AbortController(),
      waiters: new Set([demand.id]),
      startedAt: clock()
    };
    tasks.set(task.id, task);
    demand.attachments.add(task.id);
    journal.append({ t: clock(), type: 'fetch-start', fetch: task.id, dataset: task.dataset, range: task.range, for: demand.id });
    execute(task);
  }

  async function execute(task) {
    const url = source + '/data?from=' + task.range[0] + '&until=' + task.range[1];
    try {
      const response = await fetch(url, { signal: task.controller.signal });
      if (!response.ok) throw new Error('来源返回状态 ' + response.status);
      const body = await response.json();
      if (!body || !Array.isArray(body.range) || body.range.length !== 2 || typeof body.capturedAt !== 'number') {
        throw new Error('来源响应缺少范围或采集时间');
      }
      const piece = {
        fetch: task.id,
        dataset: task.dataset,
        range: body.range,
        capturedAt: body.capturedAt,
        receivedAt: Date.now(),
        body
      };
      // 顺序承诺：原始文件先落盘，再登记日志，最后才通知订阅。
      await writeFileAtomic(path.join(stateDir, 'data', task.id + '.json'), JSON.stringify(piece));
      pieces.push(piece);
      task.status = 'succeeded';
      task.capturedAt = piece.capturedAt;
      task.file = 'data/' + task.id + '.json';
      if (!closed) await journal.append({ t: clock(), type: 'fetch-done', fetch: task.id, dataset: task.dataset, range: piece.range, capturedAt: piece.capturedAt, file: task.file, late: task.abortRequested || undefined });
    } catch (error) {
      if (closed) return;
      if (task.abortRequested || error.name === 'AbortError') {
        task.status = 'aborted';
        await journal.append({ t: clock(), type: 'fetch-abort', fetch: task.id });
      } else {
        task.status = 'failed';
        task.error = String((error && error.message) || error);
        await journal.append({ t: clock(), type: 'fetch-fail', fetch: task.id, error: task.error });
      }
    }
    settle(task);
  }

  function settle(task) {
    for (const id of [...task.waiters]) {
      const demand = demands.get(id);
      task.waiters.delete(id);
      if (!demand) continue;
      demand.attachments.delete(task.id);
      if (demand.status !== 'pending') continue;
      if (task.status === 'succeeded') evaluate(demand);
      if (demand.status === 'pending') scheduleReplan(demand);
    }
    checkIdle();
  }

  function scheduleReplan(demand) {
    if (closed || demand.status !== 'pending' || demand.replanTimer) return;
    if (demand.attempts >= MAX_ATTEMPTS) return;
    if (demand.deadlineAt - Date.now() < MIN_USEFUL_MS + RETRY_DELAY_MS) return;
    demand.replanTimer = later(() => {
      demand.replanTimer = null;
      plan(demand);
    }, RETRY_DELAY_MS);
  }

  // 提交需求：返回独立句柄。同 id 重复提交幂等，重启后重投不会产生第二个需求。
  function submit(op) {
    if (closed) throw new Error('协调器已关闭');
    if (!op || typeof op.id !== 'string' || !op.id) throw new Error('需求缺少 id');
    const existing = demands.get(op.id);
    if (existing) return existing;
    if (!Array.isArray(op.range) || op.range.length !== 2 || !(op.range[0] <= op.range[1])) {
      throw new Error('需求范围无效：' + op.id);
    }
    const demand = {
      id: op.id,
      dataset: op.dataset ?? 'default',
      range: [op.range[0], op.range[1]],
      maxAge: op.maxAge ?? 0,
      deadline: op.deadline ?? null,
      deadlineAt: op.deadline == null ? Infinity : Date.now() + op.deadline,
      status: 'pending',
      attempts: 0,
      attachments: new Set(),
      evidence: [],
      timer: null,
      replanTimer: null
    };
    demands.set(demand.id, demand);
    journal.append({
      t: clock(), type: 'submit', id: demand.id, dataset: demand.dataset, range: [...demand.range],
      maxAge: demand.maxAge, deadline: demand.deadline, deadlineAt: demand.deadlineAt
    });
    if (Number.isFinite(demand.deadlineAt)) {
      demand.timer = later(() => expireDemand(demand), Math.max(0, demand.deadlineAt - Date.now()));
    }
    evaluate(demand);
    if (demand.status === 'pending') plan(demand);
    checkIdle();
    return demand;
  }

  function query(id) {
    const demand = demands.get(id);
    if (!demand) return null;
    return {
      id: demand.id,
      dataset: demand.dataset,
      range: [...demand.range],
      maxAge: demand.maxAge,
      deadline: demand.deadline,
      remainingMs: Number.isFinite(demand.deadlineAt) ? Math.max(0, demand.deadlineAt - Date.now()) : null,
      status: demand.status,
      evidence: [...demand.evidence]
    };
  }

  function schedule(op) {
    if (closed) return;
    pendingOps += 1;
    later(() => {
      pendingOps -= 1;
      try {
        if (op.action === 'submit') submit(op);
        else if (op.action === 'cancel') cancelDemand(op.id);
        else errors.push({ op, error: '未知操作 ' + op.action });
      } catch (error) {
        errors.push({ op, error: String((error && error.message) || error) });
      } finally {
        checkIdle();
      }
    }, Math.max(0, (op.at ?? 0) - clock()));
  }

  function idle() {
    return new Promise(resolve => { idleWaiters.add(resolve); checkIdle(); });
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const task of tasks.values()) if (task.status === 'running') abortTask(task);
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
    await journal.close();
  }

  // —— 恢复：先重放日志，再收留已落盘但日志未登记的原始文件 ——
  for (const event of journal.events) {
    if (event.type === 'submit' && Array.isArray(event.range)) {
      demands.set(event.id, {
        id: event.id,
        dataset: event.dataset ?? 'default',
        range: [...event.range],
        maxAge: event.maxAge ?? 0,
        deadline: event.deadline ?? null,
        deadlineAt: event.deadlineAt ?? Infinity,
        status: 'pending',
        attempts: 0,
        attachments: new Set(),
        evidence: [],
        timer: null,
        replanTimer: null
      });
    } else if (event.type === 'cancel' || event.type === 'expire' || event.type === 'complete') {
      const demand = demands.get(event.id);
      if (demand && demand.status === 'pending') {
        demand.status = event.type === 'cancel' ? 'cancelled' : event.type === 'expire' ? 'expired' : 'complete';
        if (event.evidence) demand.evidence = [...event.evidence];
      }
    } else if (event.type === 'fetch-start') {
      fetchSeq = Math.max(fetchSeq, fetchNumber(event.fetch));
      tasks.set(event.fetch, {
        id: event.fetch, dataset: event.dataset ?? 'default', range: [...event.range],
        status: 'lost', capturedAt: null, file: null, abortRequested: false,
        controller: new AbortController(), waiters: new Set(), startedAt: null
      });
      const demand = demands.get(event.for);
      if (demand) demand.attempts += 1;
    } else if (event.type === 'fetch-done') {
      const task = tasks.get(event.fetch);
      if (task) { task.status = 'succeeded'; task.capturedAt = event.capturedAt ?? null; task.file = event.file ?? null; }
    } else if (event.type === 'fetch-fail' || event.type === 'fetch-abort') {
      const task = tasks.get(event.fetch);
      if (task) task.status = event.type === 'fetch-fail' ? 'failed' : 'aborted';
    }
  }
  // 原始文件是进度的最终依据：有文件但日志停在 fetch-start 的任务按成功处理；
  // 日志完全没有提到的孤儿文件同样收留（崩溃发生在文件写入与日志登记之间）。
  for (const piece of await loadRawPieces(stateDir)) {
    pieces.push(piece);
    fetchSeq = Math.max(fetchSeq, fetchNumber(piece.fetch));
    const task = tasks.get(piece.fetch);
    if (!task) {
      tasks.set(piece.fetch, {
        id: piece.fetch, dataset: piece.dataset ?? 'default', range: [...piece.range],
        status: 'recovered', capturedAt: piece.capturedAt, file: piece.file, abortRequested: false,
        controller: new AbortController(), waiters: new Set(), startedAt: null
      });
    } else {
      if (task.status === 'lost') task.status = 'succeeded';
      task.capturedAt = task.capturedAt ?? piece.capturedAt;
      task.file = task.file ?? piece.file;
    }
  }
  // 未完结的需求重新上弦：已过期的立刻过期，其余的用已落盘资料重新判定、重新规划。
  for (const demand of demands.values()) {
    if (demand.status !== 'pending') continue;
    const remaining = demand.deadlineAt - Date.now();
    if (remaining <= 0) { expireDemand(demand); continue; }
    if (Number.isFinite(demand.deadlineAt)) demand.timer = later(() => expireDemand(demand), remaining);
    evaluate(demand);
    if (demand.status === 'pending') plan(demand);
  }

  return {
    submit,
    cancel: cancelDemand,
    query,
    list: () => [...demands.keys()].map(query),
    schedule,
    idle,
    result: buildResult,
    close,
    get errors() { return [...errors]; },
    get persistenceError() { return persistenceError ?? journal.error; }
  };
}
