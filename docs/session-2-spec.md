# Cyberboss Lite Session 2 实施规格

本文件是阶段二唯一实现依据。不得自行扩展 Pulse、Tasker、systemd、宿主机 flock 或开发工具能力。

## 1. 本阶段目标

实现：

1. JSON Schema 结构化 Claude 输出；
2. current state 与 open loops；
3. episode 状态机与 handoff；
4. 保守型长期记忆；
5. Future Intentions 的存储、校验、取消与重启恢复；
6. 有界上下文组装与 token 使用记录。

不实现：

- Pulse；
- Tasker observation；
- systemd；
- Morrow 宿主机锁；
- MCP；
- Claude session resume；
- 文件、终端、网络或其他工具。

旧 `reminder-service.js` / `reminder-queue-store.js` 已依赖被删除的多 workspace 代码。不要恢复
`default-targets`；旧文件只作参考，最终删除或替换。

---

## 2. 存储

使用 `/srv/cyberboss-lite/state/` 下的 JSON 文件：

- `current-state.json`
- `memories.json`
- `intentions.json`
- `episodes/current.json`
- `episodes/archive/<episode-id>.json`

所有文件包含：

```json
{
  "schemaVersion": 1,
  "updatedAt": ""
}
```

写入必须使用临时文件加原子 rename。损坏时保留原文件并 fail closed，不静默重置。

Current state 允许字段：

```json
{
  "currentActivity": null,
  "expectedReturnAt": null,
  "recentMood": null,
  "lastUserMessageAt": null,
  "lastAgentMessageAt": null
}
```

Open loop

```json
{
  "id": "loop_...",
  "summary": "",
  "createdAt": "",
  "sourceQuote": "",
  "status": "open"
}
```

---

## 3. Claude 结构化输出

每轮仍使用单次 `claude -p`、无工具、`max-turns=1`、无 session persistence。

必须真正向 Claude CLI 传入 JSON Schema。先用当前安装版本的 `claude --help` 和最小实测确认参数及
返回字段，不假设结构化结果仍位于 `parsed.result`。

统一结果对象：

```json
{
  "reply": "string|null",
  "statePatch": {},
  "memory": { "remember": [], "forget": [] },
  "loops": { "add": [], "resolve": [] },
  "intentions": { "create": [], "resolve": [] },
  "handoff": null
}
```

Schema 要求：

- `additionalProperties: false`；
- 所有顶层字段必须存在；
- `reply` 最大 2000 字符；
- `statePatch` 只允许 current state 字段；
- 每轮最多新增一条 memory；
- 每轮最多创建一个 intention；
- 数组和文本均设置硬上限；
- 非法结构不应用任何状态变更；
- 不进行第二次模型调用修复 JSON。

成功接入 Schema 后，将 system prompt 最后一条恢复为：

> 严格按照提供的 JSON Schema 输出，不附加 Markdown 或解释。

不得出现"prompt 要求 JSON、runtime 却未传 schema"的旧问题。增加回归测试。

---

## 4. Episode

微信始终是同一窗口，后台使用有限 episode。

Episode 数据：

```json
{
  "id": "episode_...",
  "startedAt": "",
  "lastTurnAt": "",
  "estimatedTokens": 0,
  "messages": [],
  "handoff": null,
  "rolloverVersion": 0
}
```

消息只保存 10 秒合并后的 turn：

```json
{
  "role": "user|assistant",
  "text": "",
  "at": ""
}
```

只保留两个滚动条件。

### 条件 A：闲置

收到新消息时，距离上一个有效 turn 已满 6 小时：

- 先归档旧 episode；
- 建立新 episode；
- 旧 episode 有 handoff 时作为一次性 carry context；
- 没有 handoff 时，仅携带旧 episode 最后 4 个合并 turn；
- 不额外调用模型生成摘要。

### 条件 B：上下文预算

使用固定、可测试的保守估算：

```
estimatedTokens = ceil(UTF-8 byte length / 3)
soft limit = 3500
hard limit = 5000
```

达到 soft limit：

- 当前请求中加入 `rolloverRequested=true`；
- 要求本轮同时返回 handoff；
- handoff 成功保存后归档并新建 episode。

达到 hard limit 但 handoff 缺失或无效：

- 保留已有 handoff；
- 保留所有 open loops；
- 仅保留最后 4 个合并 turn；
- 删除更早原文；
- 下一轮继续请求 handoff。

所有滚动只经过幂等的 `rolloverEpisode()`；使用 `episodeId + rolloverVersion` 防止重复滚动。

Handoff

```json
{
  "summary": "不超过600字",
  "tone": "不超过120字",
  "openLoops": ["最多8项"],
  "carryForward": ["最多8项"]
}
```

不单独调用模型做摘要。

---

## 5. 长期记忆

分两层：

- core：最多12条，每轮全部注入
- contextual：最多30条，每轮最多选择8条

数据：

```json
{
  "id": "mem_...",
  "category": "preference",
  "fact": "",
  "tags": [],
  "tier": "core|contextual",
  "confidence": "explicit",
  "sourceQuote": "",
  "createdAt": "",
  "updatedAt": "",
  "lastUsedAt": "",
  "status": "active"
}
```

分类固定为：

- identity
- preference
- relationship
- boundary
- recurring_pattern
- important_context

写入要求：

- `sourceQuote` 必须逐字存在于本轮用户原文；
- 只接受用户明确表达的稳定事实；
- 不保存模型推断；
- 不保存短暂情绪、当前活动或一次性细节；
- 每轮最多一条；
- `fact` 不超过 80 个汉字；
- 重复或近似内容合并，不新增。

遗忘仅接受：

1. 用户明确纠正；
2. 用户明确要求忘记；
3. 具有明确有效期且已过期。

旧记忆先标记 `superseded`，30 天后清理，不立即物理删除。

情境记忆选择采用简单评分，不引入向量数据库：

- tag 与当前消息匹配；
- 与 open loop 匹配；
- 最近新增或使用；
- 当前话题相关。

记忆注入总预算不超过约 900 estimated tokens。

---

## 6. Future Intentions

支持三类：

- reminder
- check_in
- resume_topic

数据：

```json
{
  "id": "int_...",
  "type": "check_in",
  "dueAt": null,
  "expiresAt": "",
  "reason": "",
  "context": "",
  "sourceQuote": "",
  "sourceTurnId": "",
  "cancelOnInbound": true,
  "status": "pending"
}
```

规则：

**reminder**

- 必须来自用户明确要求；
- 必须有可解析时间；
- 不允许模型自行创建"替用户决定"的提醒。

**check_in**

- 必须有具体对话理由；
- 最远 48 小时；
- 不是为了保持活跃而创建。

**resume_topic**

- 不主动发消息；
- 用户下次入站时注入；
- 默认 7 天过期。

通用限制：

- 每轮最多创建一个；
- pending 总数最多 10；
- 相似项去重；
- 用户重新出现、事项完成、过期或被替代时自动取消；
- resolve 只能引用真实 intention ID；
- 定时执行不得递归创建新 intention、memory 或 handoff。

由于宿主机 flock 和 systemd 尚未完成：

- 本阶段实现存储、校验、恢复、到期选择和执行接口；
- `resume_topic` 可在真实入站链路启用；
- reminder/check_in 的真实主动发送默认关闭；
- 使用配置 `ENABLE_SCHEDULED_INTENTIONS=false`；
- 单元测试使用 fake clock 和 fake lock；
- 会话三接入宿主机 try-lock 后再开启真实调度。

旧 reminder 代码不得继续使用多 workspace target。

---

## 7. 每轮上下文

普通 reply 输入顺序：

1. MODE / NOW
2. 核心记忆
3. 相关情境记忆
4. current state
5. open loops
6. 上一 episode carry context
7. 当前 episode live dialogue
8. pending resume_topic
9. 本轮合并消息
10. rolloverRequested

不发送完整历史。

典型普通输入目标低于 4000 tokens，P95 低于 8000。

每轮记录：

- mode
- inputTokens
- outputTokens
- cacheReadTokens
- cacheCreationTokens
- durationMs
- episodeId
- rolloverReason
- isError

日志不得记录正文。

---

## 8. 状态应用顺序

一次成功 reply：

校验结构化结果 → 发送 reply → 应用 statePatch → 应用 loops → 应用 memory → 应用 intentions →
保存 handoff/episode

微信发送失败时：

- 不写 `lastAgentMessageAt`；
- 不把该 assistant reply 加入 episode；
- 其他由用户原文直接支持的 memory/state 变更也暂不应用，避免模型状态与用户实际看到的对话分叉。

所有写入应由一个事务式状态协调器完成；中途失败不得形成半套状态。

---

## 9. 必测项目

1. JSON Schema 拒绝额外字段和错误类型；
2. 普通回复不会把 JSON 对象文本原样发到微信；
3. 6 小时闲置只滚动一次；
4. soft limit 生成 handoff 并滚动；
5. hard limit 在 handoff 缺失时正确裁剪；
6. 连续 50 个合并 turn 后上下文不线性增长；
7. memory 无本轮 sourceQuote 时拒绝写入；
8. 重复 memory 不新增；
9. 用户纠正旧事实时标记 superseded；
10. intention 每轮最多一个、pending 最多 10；
11. reminder 无明确用户请求时拒绝；
12. resume_topic 在下一次入站时注入；
13. 重启后 episode、memory、state 和 intentions 可恢复；
14. scheduled intentions 默认不会真实主动发送；
15. Claude 临时配置目录和 transcript 隔离仍通过；
16. 最后做一次真实微信结构化回复验证。

---

## 10. 实施与交付

先提交本规格：`docs/session-2-spec.md`

然后按以下顺序实现：

1. Schema 与 runtime；
2. 状态协调器；
3. episode/handoff；
4. memory；
5. intentions；
6. 上下文组装；
7. 测试与真实微信验证。

本阶段结束时：

- 更新 `docs/cyberboss-lite-status.md`；
- 记录数据结构、实际 CLI 参数、测试结果和剩余会话三事项；
- 推送 `lite`；
- 工作区必须干净；
- 不创建 systemd，不启用 Pulse 和 Tasker。
