import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 原子写入：先写临时文件再改名，重启发生在写入中途也不会读到半个文件。
export async function writeFileAtomic(file, data) {
  const temporary = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  await writeFile(temporary, data);
  await rename(temporary, file);
}

// 追加式状态日志：每次状态变化按序落盘并同步，恢复时重放，不依赖调用方持有的内存。
export async function openJournal(stateDir) {
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, 'journal.jsonl');
  const events = [];
  try {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* 崩溃截断的尾行直接丢弃 */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const handle = await open(file, 'a');
  let sequence = events.length ? events[events.length - 1].seq ?? events.length : 0;
  let chain = Promise.resolve();
  let journalError = null;
  return {
    events,
    get error() { return journalError; },
    append(event) {
      sequence += 1;
      const record = { seq: sequence, ...event };
      events.push(record);
      chain = chain.then(async () => {
        await handle.appendFile(JSON.stringify(record) + '\n');
        await handle.sync();
      }).catch(error => { journalError = error; });
      return chain;
    },
    async close() {
      await chain.catch(() => {});
      await handle.close();
    }
  };
}

// 读取 data 目录下全部已落盘的原始响应，包括日志尚未登记的孤儿文件
// （重启发生在“原始文件已写入、订阅尚未通知”之间时，靠它把进度捡回来）。
export async function loadRawPieces(stateDir) {
  const directory = path.join(stateDir, 'data');
  let names = [];
  try { names = await readdir(directory); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const pieces = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    let piece = null;
    try { piece = JSON.parse(await readFile(path.join(directory, name), 'utf8')); } catch { continue; }
    if (!piece || !Array.isArray(piece.range) || piece.range.length !== 2) continue;
    if (typeof piece.capturedAt !== 'number') continue;
    pieces.push({ ...piece, fetch: piece.fetch ?? name.slice(0, -'.json'.length), file: 'data/' + name });
  }
  return pieces;
}
