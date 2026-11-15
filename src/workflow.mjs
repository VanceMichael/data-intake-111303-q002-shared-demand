import path from 'node:path';
import { createCoordinator } from './coordinator.mjs';
import { writeFileAtomic } from './journal.mjs';

export { createCoordinator } from './coordinator.mjs';

// 业务入口：按 input.operations 的时刻投递提交与取消，等全部需求完结后返回结果，
// 并把同一份结果持久化到 stateDir/result.json。恢复只依赖 stateDir，不依赖调用方内存。
export async function run({ source, stateDir, input }) {
  const coordinator = await createCoordinator({ source, stateDir, now: input?.now ?? Math.floor(Date.now() / 1000) });
  try {
    for (const op of input?.operations ?? []) coordinator.schedule(op);
    await coordinator.idle();
    const result = coordinator.result();
    await writeFileAtomic(path.join(stateDir, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await coordinator.close();
  }
}
