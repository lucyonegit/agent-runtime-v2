import { Body, Controller, Param, Post } from '@nestjs/common';
import { AgentRuntimeService } from '../agent-runtime.service.js';
import type {
  AnswerInputRequestBody,
  RunCodeBody,
  RunPlannerReactBody,
  RunReactBody,
} from '../dto.js';

@Controller('sessions/:sessionId')
export class AgentsController {
  constructor(private readonly runtime: AgentRuntimeService) {}

  @Post('react/runs')
  runReact(
    @Param('sessionId') sessionId: string,
    @Body() body: RunReactBody
  ) {
    return this.runtime.runReact(sessionId, body.input);
  }

  @Post('planner-react/runs')
  runPlannerReact(
    @Param('sessionId') sessionId: string,
    @Body() body: RunPlannerReactBody
  ) {
    return this.runtime.runPlannerReact(sessionId, body.goal);
  }

  @Post('code/runs')
  runCode(
    @Param('sessionId') sessionId: string,
    @Body() body: RunCodeBody
  ) {
    return this.runtime.runCode(sessionId, body);
  }

  @Post('input-requests/:requestId/answer')
  answerInputRequest(
    @Param('sessionId') sessionId: string,
    @Param('requestId') requestId: string,
    @Body() body: AnswerInputRequestBody
  ) {
    return this.runtime.answerInputRequest(sessionId, requestId, body.value);
  }
}
