# Manus-Style Agent Workspace UI Design

Date: 2026-06-30

## Goal

Redesign the current Agent Runtime V2 web UI from a loose chat demo into a
polished agent workspace inspired by Manus: session navigation on the left,
conversation in the center, and agent work state on the right.

The UI should feel like a serious tool for watching and steering an agent, not
a decorative chat page. It must keep the current runtime data model intact:
`AgentSessionView` is the canonical snapshot, and `AgentSessionPatch` updates
the same message/task/request records during SSE streaming.

## Design Direction

Tone: quiet, precise, premium SaaS workspace.

Avoid:

- heavy shadows on every message
- oversized avatars
- large API/debug controls in the primary header
- raw JSON as the default visible state
- one-note green palette

Use:

- soft off-white canvas
- dark graphite sidebar
- restrained teal accent
- compact typography
- document-like assistant messages
- clear right-side work panel for plan, tools, artifacts, and HITL

## Layout

Desktop default is a three-column workspace:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Sidebar          │ Main Conversation                            │ Work Panel │
│ 280px            │ flexible                                     │ 320px      │
├──────────────────┼──────────────────────────────────────────────┼────────────┤
│ Brand            │ Header                                       │ Run        │
│ New task         │ Session title / mode / status                │ Plan       │
│ Search/filter    │                                              │ Tools      │
│ Session list     │ Message stream                               │ Artifacts  │
│                  │                                              │ HITL       │
│                  │ Composer                                     │            │
└──────────────────┴──────────────────────────────────────────────┴────────────┘
```

Responsive behavior:

- >= 1200px: three columns.
- 900-1199px: right work panel collapses into a top "Activity" drawer button.
- < 900px: sidebar becomes an overlay drawer; main conversation fills the page.

## Visual System

### Palette

```text
Canvas             #F7F7F2
Surface            #FFFFFF
Surface muted      #F0F2EA
Sidebar            #141A17
Sidebar raised     #202823
Text primary       #1F2622
Text secondary     #6F7871
Text muted         #9AA39C
Border             #E0E4DB
Accent             #2C7A68
Accent soft        #DDF1EA
User bubble        #173B3A
Danger             #B94C3C
Warning            #B9852E
```

No gradients are required. The premium feel should come from spacing, type,
alignment, and state clarity.

### Typography

Use the existing system stack for Chinese readability:

```css
font-family:
  ui-sans-serif,
  -apple-system,
  BlinkMacSystemFont,
  "PingFang SC",
  "Hiragino Sans GB",
  "Microsoft YaHei",
  sans-serif;
```

Type scale:

- app title: 16px / 700
- page title: 18px / 700
- message body: 15px / 1.7
- metadata: 12px / 600
- sidebar item title: 14px / 700
- mono ids: 12px

## Sidebar

Purpose: session navigation, not status dashboard.

Structure:

```text
Agent Runtime
runtime v2

+ New task

Search sessions
Mode filter

Recent
[session title]
[session id]            react
```

Design notes:

- Sidebar width: 280px.
- Use dark graphite background.
- Session cards should be flat list items with active left rail, not giant
  floating cards.
- Active session uses light surface on dark sidebar.
- New task is the only strong action.

## Main Header

Purpose: identify current session and expose compact run controls.

Structure:

```text
New conversation
session_4bd2dc633818

[React ▾] [completed] [Connected] [Refresh icon]
```

Rules:

- API URL should move out of the primary visual hierarchy. Keep it in a small
  muted tooltip or secondary text only if needed.
- Header height: 72px.
- Avoid large icon blocks.

## Conversation

Purpose: readable transcript.

Message stream layout:

- Max content width: 920px.
- Centered within main column.
- Vertical rhythm: 28-36px between turns.
- Date separator appears only when needed.

### User Message

Right aligned compact bubble:

```text
You · 15:21
┌────────────────────┐
│ 你是谁？           │
└────────────────────┘
```

Style:

- background `#173B3A`
- text white
- max-width 520px
- radius 14px
- no avatar by default

### Assistant Message

Left aligned document-style block:

```text
Agent · final · 15:21
我是通义千问，可以回答问题、创作文字、调用工具...
```

Style:

- no heavy card for plain text
- optional subtle surface only for longer messages or grouped tool work
- metadata row is muted
- body line height 1.7
- max-width 760px

### Streaming

During streaming:

- show a small animated dot in the assistant metadata row
- content appears in-place
- completed patch replaces the provisional message without visual jump

## Tool Display

Tools should be grouped under the assistant message that called them.

Collapsed state:

```text
Tool  get_current_time   completed   2ms
```

Expanded state:

```text
Arguments
{ "timeZone": "Asia/Shanghai" }

Result
2026年6月30日 星期二 15:21:12
```

Rules:

- Default collapsed.
- Show summarized result first when possible.
- Raw JSON only after expansion.
- Failed tools use muted red border and error summary.
- Pending tools use spinner or "waiting".

## Right Work Panel

Purpose: make the app feel like an agent workspace.

Sections:

```text
Run
completed
task_...

Plan
No active plan

Tools
get_current_time     2ms
browse_url           581ms

Artifacts
No artifacts yet

Input
No pending requests
```

### Run Section

Shows the active or latest task:

- status
- task id
- mode/executor
- waiting request count if applicable

### Plan Section

Reads from:

- `message.metadata.kind === "plan"`
- `message.metadata.plan.steps`
- task metadata `stepId` for planner step status

Step states:

```text
1. Search source       done
2. Read page           running
3. Draft response      pending
```

If no planner task exists, show a quiet empty state.

### Tools Section

Derived from messages:

- assistant messages with `toolCalls`
- tool messages with `toolResult`

Show recent tools as compact rows:

- name
- status
- duration

### Artifacts Section

First implementation can derive from tool results:

- `write_article`
- future `artifact.updated`
- tool result metadata containing file path

No new database table is required for this UI pass.

### Input Section

Reads `view.inputRequests`.

Pending requests get strong treatment:

- prompt
- input control
- submit action

Answered requests should not dominate the panel.

## Composer

Fixed at bottom of main column.

Structure:

```text
┌──────────────────────────────────────────────┐
│ Ask agent to do something...          Send   │
└──────────────────────────────────────────────┘
```

Rules:

- Max width aligned with conversation.
- Multi-line textarea.
- Send button is icon-only with tooltip.
- Disabled state when no session or input is empty.
- Placeholder changes by mode:
  - React: `Ask the agent...`
  - Planner + React: `Describe a goal...`

## Component Plan

Existing components to reshape:

- `SessionShell`: owns three-column grid and header.
- `SessionSidebar`: dark navigation/sidebar.
- `MessageList`: transcript layout and turn grouping.
- `MessageBubble`: split into user/assistant/tool-aware rendering.
- `ToolCallBlock`: compact summarized tool block.
- `InputRequestPanel`: move into right work panel section.

New components:

- `WorkspacePanel`
- `PlanSection`
- `ToolActivitySection`
- `ArtifactSection`
- `RunSummarySection`
- `ConversationHeader`
- `Composer`

## Data Mapping

Use only existing frontend state:

```text
view.session          -> header / sidebar active item
view.tasks           -> run summary / plan step status
view.messages        -> transcript / plan / tool activity / artifacts
view.inputRequests   -> right panel input section
streamingMessageIds  -> streaming indicator
connected            -> header status
runMode              -> mode select and composer placeholder
```

Do not introduce separate UI-only conversation records. Derived panel data can
be computed in pure helper functions from `AgentSessionView`.

## Empty States

No session:

- left sidebar still visible
- center shows "Create or select a session"
- composer disabled

Empty session:

- center shows a quiet starter prompt
- right panel shows idle state

No plan:

- "No active plan"

No tools:

- "No tool activity yet"

Pending HITL:

- input section pins to top of right panel and highlights action required

## Implementation Boundaries

This design pass should not change:

- backend persistence
- SSE protocol
- runtime orchestration
- tool execution semantics

It should change:

- React component layout
- CSS design system
- derived UI selectors/helpers
- plan/tool/input presentation

## Acceptance Criteria

- UI no longer looks like a demo/test panel.
- Conversation is readable and visually calm.
- User messages are right aligned; assistant messages are left aligned.
- Tool calls/results are visually grouped under assistant turns.
- Right work panel shows current run, plan, tools, artifacts, and input
  requests.
- Refresh/recovery view looks the same as live SSE view.
- Desktop layout works at 1440px and 1920px.
- Narrow layout does not overlap or clip text.
