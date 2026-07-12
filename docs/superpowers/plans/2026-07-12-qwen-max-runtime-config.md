# qwen-max Runtime Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the current local Agent Runtime from qwen-plus to qwen-max.

**Architecture:** Change only the ignored local `.env`, restart the running server, and verify parsed config plus an audited model call. Do not change committed code defaults.

**Tech Stack:** dotenv, Node.js, LangChain ChatOpenAI-compatible DashScope provider, PostgreSQL.

---

## Task 1: Switch the local model configuration

- [x] Confirm `.env` currently contains `OPENAI_MODEL=qwen-plus`.
- [x] Replace it with `OPENAI_MODEL=qwen-max` without changing credentials or committed defaults.
- [x] Load the compiled server configuration through dotenv and confirm `modelName` resolves to `qwen-max` without printing secrets.

## Task 2: Restart and verify the runtime

- [x] Stop the existing `dist/src/server/main.js` process gracefully.
- [x] Start the same compiled server so it reloads `.env`.
- [x] Create an isolated verification session and submit a minimal direct job.
- [x] Confirm the completed job's `agent_model_calls` records use `qwen-max`.
- [x] Delete the isolated verification session after capturing the result.

## Task 3: Final checks and rollback

- [x] Confirm the server remains running after verification.
- [x] Confirm `.env` is still ignored and no unrelated tracked files changed.
- [x] Roll back, if needed, by restoring `OPENAI_MODEL=qwen-plus` and restarting the server.
