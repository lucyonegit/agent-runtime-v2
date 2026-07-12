# browse_url 二进制响应安全修复设计

## 问题

`browse_url` 对所有成功响应调用 `Response.text()` 并按 HTML 清理。访问 PDF 时，二进制内容会产生 NUL 字符；工具 artifact 随后写入 PostgreSQL `jsonb`，触发 `22P05: \\u0000 cannot be converted to text`。底层异常被统一映射成 `storage_error`，导致当前 StepRun 和 Job 失败。

## 目标

- 非文本响应不进入 HTML 提取和持久化。
- 所有通过 `jsonToolOutput` 返回的 JSON-compatible 工具结果都不包含 NUL 字符。
- 不修改 PostgreSQL schema、Store 写接口、事务命令或 Plan/Step/ReAct 链路。
- PDF 阅读不在本次修复中实现；后续使用独立 `read_pdf` 工具承载。

## 方案

### browse_url 内容类型边界

在读取响应体之前检查规范化后的 `Content-Type`。只允许 `text/*`，以及明确属于文本的 `application/json`、`application/xml`、`application/xhtml+xml` 和 `application/*+json|xml`。其他类型抛出普通工具错误，错误中包含安全、简短的 MIME 类型和建议使用专用工具的信息。

该错误由现有 `ToolExecutor` 转换为 `tool_failed`，并通过原有 `commitToolResult` 流程持久化，不再升级为 Job 级 `storage_error`。

### JSON 工具输出净化

`jsonToolOutput` 在序列化前递归复制 JSON-compatible 值，并从所有字符串中删除 NUL 字符。数组与普通对象保持结构；数字、布尔值和 null 保持不变。这样 content 字符串与 artifact 使用同一份净化结果，避免只清理展示文本却让 JSONB artifact 再次失败。

净化位于工具输出边界，不修改通用数据库写入语义。

## 测试

- `browse_url` 面对 `application/pdf` 时返回稳定的工具失败，不调用 `Response.text()`。
- `browse_url` 继续接受 HTML/JSON 等文本类型。
- `jsonToolOutput` 同时净化嵌套对象、数组和顶层字符串中的 NUL。
- Runtime tools、完整单测、PostgreSQL 集成测试、typecheck 与 build 全部通过。

## 非目标

- 不解析 PDF、Office、图片或压缩包。
- 不改变错误 DTO、SSE payload 或前端卡片。
- 不在持久化层静默改写任意业务数据。
