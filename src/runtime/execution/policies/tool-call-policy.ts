import type { RuntimeTool } from '../tool-executor.js';

export class ToolCallPolicy {
  readonly #toolsByName: Map<string, RuntimeTool>;

  constructor(tools: RuntimeTool[]) {
    this.#toolsByName = new Map(tools.map(tool => [tool.tool.name, tool]));
  }

  async validate(toolCalls: Array<{ name: string }>) {
    const freshContextCall = toolCalls.find(
      call => this.#toolsByName.get(call.name)?.requiresFreshContext
    );
    const prerequisiteSibling = freshContextCall
      ? toolCalls.find(call => !this.#toolsByName.get(call.name)?.requiresFreshContext)
      : undefined;
    if (!freshContextCall || !prerequisiteSibling) return { type: 'accept' as const };
    return {
      type: 'retry' as const,
      code: 'tool_batch.requires_fresh_context',
      feedback: [
        `Runtime validation rejected the previous tool batch because ${JSON.stringify(freshContextCall.name)} cannot share a model turn with prerequisite tool ${JSON.stringify(prerequisiteSibling.name)}.`,
        `The rejected batch was not persisted or executed: ${JSON.stringify(toolCalls.map(call => call.name))}.`,
        'Execute searches and reads first, wait for their ToolMessages, then call the write tool alone using those observed results.',
      ].join('\n'),
    };
  }
}
