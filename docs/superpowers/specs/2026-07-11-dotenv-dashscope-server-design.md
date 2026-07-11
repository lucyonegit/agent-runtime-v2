# Dotenv + DashScope Server 启动设计

## 目标

后端从项目根目录 `.env` 自动加载 PostgreSQL 与模型配置，使用用户提供的 DashScope API Key，通过阿里云北京地域 OpenAI-compatible endpoint 调用 `qwen-plus`，并保持原有 OpenAI-compatible 配置能力。

## 配置契约

本地 `.env` 由以下变量组成，文件已被 `.gitignore` 排除，任何测试、日志和提交不得输出密钥内容：

```dotenv
DATABASE_URL=postgresql://...
DASHSCOPE_API_KEY=<secret>
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_MODEL=qwen-plus
HOST=127.0.0.1
PORT=3000
```

## 实现边界

1. 安装 `dotenv`，在 `src/server/main.ts` 第一行加载 `dotenv/config`。
2. 新建纯函数 `resolveModelRuntimeConfig`：
   - `DASHSCOPE_API_KEY` 存在时优先选择 DashScope，provider 为 `dashscope`。
   - DashScope 默认 base URL 为 `https://dashscope.aliyuncs.com/compatible-mode/v1`，默认 model 为 `qwen-plus`。
   - 否则兼容 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`。
   - 两类密钥都缺失时服务仍可启动，但 Job 执行明确持久化为 credential missing failure。
3. PostgreSQL schema 不在服务启动时隐式迁移；先运行现有 `schema:migrate`，再启动 server。

## 错误处理与安全

- `.env` 永不进入 Git。
- 配置解析测试只使用假密钥。
- 启动输出只检查 host、port、provider 与 model，不输出 API key 或完整数据库连接串。
- 数据库连接失败、schema version 不匹配仍保持 fail-fast。

## 验收

- model config 单元测试覆盖 DashScope 默认值、显式覆盖、OpenAI fallback、无密钥。
- `npm run typecheck`、`npm test`、`npm run build` 通过。
- 对用户数据库执行 `npm run schema:migrate`。
- `npm run serve` 能监听配置端口。
- `GET /sessions` 返回 200。
- 创建 Session 和 Job 后，DashScope 模型调用能够完成或返回可诊断的 provider 错误，Job 不得永久停在 running。
