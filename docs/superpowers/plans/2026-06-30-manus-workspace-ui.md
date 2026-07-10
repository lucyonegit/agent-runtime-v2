# Manus Workspace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Agent Runtime V2 web UI into a Manus-style three-column agent workspace.

**Architecture:** Keep `AgentSessionView` as the only source of UI records. Add pure derived selectors for run summary, plan, tool activity, and artifacts. Reshape existing React components and CSS; do not change backend storage, SSE, or orchestration.

**Tech Stack:** React 19, TypeScript, Vite, lucide-react, existing REST/SSE API.

---

### Task 1: Workspace Derived Data

**Files:**
- Create: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/components/workspaceData.ts`

- [ ] Create pure helpers:
  - `getLatestTask(tasks)`
  - `getPlanSummary(view)`
  - `getToolActivities(messages)`
  - `getArtifactActivities(messages)`
  - `getPendingRequests(inputRequests)`

- [ ] Verify helpers compile through `npm run build`.

### Task 2: Right Workspace Panel

**Files:**
- Create: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/components/WorkspacePanel.tsx`
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/components/InputRequestPanel.tsx`

- [ ] Build `WorkspacePanel` with Run, Plan, Tools, Artifacts, and Input sections.
- [ ] Reuse existing `InputRequestPanel` card logic inside the panel.
- [ ] Keep all data derived from `AgentSessionView`.

### Task 3: Conversation Header And Composer

**Files:**
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/components/SessionShell.tsx`

- [ ] Move top controls into compact header.
- [ ] Keep session selector, run mode selector, connected status, task status, and refresh.
- [ ] Move input panel out of the main column into `WorkspacePanel`.
- [ ] Keep composer fixed at bottom of main column.

### Task 4: Message Rendering

**Files:**
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/components/MessageBubble.tsx`
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/components/ToolCallBlock.tsx`
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/components/MessageList.tsx`

- [ ] Make user turns right-aligned compact bubbles.
- [ ] Make assistant turns document-style blocks.
- [ ] Keep tool calls grouped under assistant messages.
- [ ] Collapse raw JSON by default.

### Task 5: Visual System CSS

**Files:**
- Replace: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/styles.css`

- [ ] Implement the palette and spacing from the design spec.
- [ ] Implement desktop three-column layout.
- [ ] Implement responsive collapse for narrow screens.
- [ ] Ensure no text overlaps or clips in buttons, chips, cards, or composer.

### Task 6: Verification

**Files:**
- No production files unless verification reveals an issue.

- [ ] Run `npm run build` in `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web`.
- [ ] If the dev server is running, verify the UI at `http://127.0.0.1:5174`.
- [ ] Fix any visual breakages discovered during build/manual inspection.
