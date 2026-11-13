# 来源与接收约定

GET /data?from=&until= 领取范围。capturedAt 与 input.now 使用业务秒；operations.at 和 deadline 为执行开始后的毫秒。submit 的 id 是订阅句柄；cancel 仅取消对应句柄。输出 subscribers[id]，状态 complete/cancelled/expired。input.operations 由协调器按 at 投递，产品也提供等价的提交、查询和取消 API。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 相同需求共享但取消独立

业务输入：
```json
{
  "now": 100,
  "operations": [
    {
      "at": 0,
      "action": "submit",
      "id": "daily",
      "range": [
        0,
        100
      ],
      "maxAge": 10,
      "deadline": 300
    },
    {
      "at": 10,
      "action": "submit",
      "id": "desk",
      "range": [
        0,
        100
      ],
      "maxAge": 10,
      "deadline": 300
    },
    {
      "at": 20,
      "action": "cancel",
      "id": "desk"
    }
  ]
}
```
结果必须包含：
```json
{
  "subscribers": {
    "daily": "complete",
    "desk": "cancelled"
  }
}
```

### 短需求过期不终止长期订阅

业务输入：
```json
{
  "now": 100,
  "operations": [
    {
      "at": 0,
      "action": "submit",
      "id": "short",
      "range": [
        0,
        100
      ],
      "maxAge": 10,
      "deadline": 20
    },
    {
      "at": 5,
      "action": "submit",
      "id": "long",
      "range": [
        0,
        100
      ],
      "maxAge": 10,
      "deadline": 300
    }
  ]
}
```
结果必须包含：
```json
{
  "subscribers": {
    "short": "expired",
    "long": "complete"
  }
}
```

### 过期资料不能完成新需求

业务输入：
```json
{
  "now": 100,
  "operations": [
    {
      "at": 0,
      "action": "submit",
      "id": "fresh",
      "range": [
        0,
        100
      ],
      "maxAge": 5,
      "deadline": 40
    }
  ]
}
```
结果必须包含：
```json
{
  "subscribers": {
    "fresh": "expired"
  }
}
```
