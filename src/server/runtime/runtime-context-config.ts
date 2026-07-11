export const WORKSPACE_TOOL_ROUTING_INSTRUCTION =
  'Webpages, applications, scripts, and source code must use write_file with paths under code/. Use write_article only for non-code prose articles and reports.';

export const JOB_EXECUTION_SYSTEM_PROMPT =
  `Act as a reliable tool-using agent. Complete the user goal. ${WORKSPACE_TOOL_ROUTING_INSTRUCTION}`;

export const RUNTIME_SYSTEM_PROMPT_VERSION = 'runtime-system-v2';
