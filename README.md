# 订阅需求共享采集的独立完成与取消

这是 shared-demand 的 Node.js 项目。现有能力是本地资料源启动、来源检查、接口演练，以及 `src/workflow.mjs` 承载的按需采集协调器：需求与抓取分离、可共享在途抓取、状态全部落盘可恢复。

## 环境

使用 Node.js 22，最低 22.20.0；Docker 基础镜像按摘要固定，依赖已在 package-lock.json 固定。资料源仅使用本地接口或本地合成设备进程。不需要真实账户、新闻站点连接或生产数据。

开发环境首次安装执行 `npm ci --ignore-scripts --no-audit --no-fund`。构建镜像执行 `docker build -t shared-demand:local .`，依赖准备只在这一步进行；正式运行不下载包、浏览器或数据。

## 常用操作

```sh
npm test
npm run build
npm run inspect
npm run source
```

`npm test` 检查已有资料源与接口读取。`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

## 工作流接入

业务入口约定为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input 是业务输入，stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 stateDir/result.json，其他持久状态布局由业务模块决定。不能依赖调用方持有的内存来完成恢复。

同一模块还导出 `createCoordinator({ source, stateDir, now })`，提供与 input.operations 等价的产品接口：`submit` 提交需求（数据集、规范化范围、允许资料年龄、截止时刻）取得独立句柄，`query` 查询句柄状态，`cancel` 仅取消对应句柄。

## 协调器设计

需求（谁在等什么）与抓取任务（实际向供方发了什么请求）分开登记。兼容需求共享在途抓取与已落盘的原始响应，但新鲜度（各自 maxAge 对照 capturedAt）、覆盖范围、完成状态逐需求独立判定；不因查询字符串相同就合并，也不因一个订阅到期或取消而丢弃别人的结果。范围更大的新需求到来时，先用已落盘资料与在途任务抵扣，再对剩余差集发起新抓取；任务一旦发起范围不再扩大，避免无限扩张拖死短请求。供方允许中断，任务没有等待者时才取消；取消到达时正文可能已在返回，仍照常落盘供他人复用。

状态全部持久化在 stateDir：journal.jsonl 追加记录每次状态变化，data/*.json 保存原始响应（先落盘、再登记、最后通知订阅），result.json 随状态完结更新。重启时重放日志并收留“文件已写入、日志未登记”的孤儿响应，未完结的需求重新判定、重新规划。

GET /data?from=&until= 领取范围。capturedAt 与 input.now 使用业务秒；operations.at 和 deadline 为执行开始后的毫秒。submit 的 id 是订阅句柄；cancel 仅取消对应句柄。输出 subscribers[id]，状态 complete/cancelled/expired。input.operations 由协调器按 at 投递，产品也提供等价的提交、查询和取消 API。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance
npm run demo
```

acceptance 检查契约情形、范围拼接、新鲜度各自判定与崩溃恢复，核对结果、落盘内容和实际来源访问；demo 从干净临时状态启动本地服务，实际执行全部情形并完整输出结果及请求，不回放记录。每种情形应在 15 秒内完成，整次演示在 75 秒超时后报失败退出，预留在 90 秒内展示的余量。

容器内执行基线检查：`docker run --rm --network none shared-demand:local npm test`。工作流开发完成后执行 `docker run --rm --network none shared-demand:local npm run demo`。容器内回环端口可用；正式核对过程不连接外部网络。
