# qwen-max 本地运行配置设计

## 目标

将当前本地 Agent Runtime 使用的 DashScope 模型从 `qwen-plus` 切换为 `qwen-max`。

## 边界

- 只修改被 `.gitignore` 排除的本地 `.env`：`OPENAI_MODEL=qwen-max`。
- 不修改代码默认值、数据库、模型审计结构或前端。
- 重启当前 Server，使环境变量重新加载。
- 通过运行时配置解析和一次 LangChain 模型调用记录确认生效。

## 回滚

将 `.env` 恢复为 `OPENAI_MODEL=qwen-plus` 后重启 Server。
