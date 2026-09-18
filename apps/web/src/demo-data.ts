import type { Agent, Conversation, HubEvent, HubMessage, HubSnapshot, HubTask, TokenUsage } from './types'

const minute = 60_000
const usage = (inputTokens: number, outputTokens: number): TokenUsage => ({
  inputTokens,
  outputTokens,
  cachedTokens: 0,
  reasoningTokens: 0,
  toolTokens: 0,
  totalTokens: inputTokens + outputTokens,
})

function isoAgo(minutes: number) {
  return new Date(Date.now() - minutes * minute).toISOString()
}

export function createDemoSnapshot(): HubSnapshot {
  const rootTaskId = 'workflow-release'
  const agents: Agent[] = [
    {
      agentId: 'laptop-01-planner',
      deviceId: 'laptop-01',
      account: { id: 'gpt-plus-01', provider: 'openai', plan: 'Plus', label: 'GPT Plus 01' },
      roles: ['planner'],
      models: [
        { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', quota: quota('Healthy', 34) },
        { id: 'gpt-6-astra', label: 'GPT 6 Astra', quota: quota('Low', 82) },
      ],
      status: 'online',
      busy: true,
      adapter: 'codex-exec-resume',
      capabilities: ['planning', 'coding', 'document_editing'],
      currentTaskId: 'task-intake',
      lastSeenAt: isoAgo(0),
      executors: [{ type: 'codex-exec-resume', health: 'Healthy', quota: 'Healthy' }],
      usageTotals: usage(14_820, 4_610),
      quotaSnapshot: quota('Healthy', 34),
    },
    {
      agentId: 'laptop-01-executor',
      deviceId: 'laptop-01',
      account: { id: 'gpt-plus-01', provider: 'openai', plan: 'Plus', label: 'GPT Plus 01' },
      roles: ['executor'],
      models: [{ id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', quota: quota('Healthy', 34) }],
      status: 'online',
      busy: false,
      adapter: 'codex-exec-resume',
      capabilities: ['coding', 'document_editing', 'terminal'],
      lastSeenAt: isoAgo(0),
      executors: [{ type: 'codex-exec-resume', health: 'Healthy', quota: 'Healthy' }],
      usageTotals: usage(21_440, 8_120),
      quotaSnapshot: quota('Healthy', 34),
    },
    {
      agentId: 'laptop-02-reviewer',
      deviceId: 'laptop-02',
      account: { id: 'gemini-pro-01', provider: 'google', plan: 'AI Pro', label: 'Gemini Pro 01' },
      roles: ['reviewer'],
      models: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', quota: quota('Unknown') }],
      status: 'online',
      busy: false,
      adapter: 'antigravity-stream-json',
      capabilities: ['reasoning', 'review', 'document_editing'],
      lastSeenAt: isoAgo(1),
      executors: [{ type: 'antigravity-stream-json', health: 'Healthy', quota: 'Unknown' }],
      usageTotals: usage(7_240, 1_860),
      quotaSnapshot: quota('Unknown'),
    },
  ]

  const tasks: HubTask[] = [
    task(rootTaskId, rootTaskId, 'laptop-01-planner', 'planner', 'planning', 'completed', 28, '规划发布说明改进任务'),
    task('task-execute', rootTaskId, 'laptop-01-executor', 'executor', 'execution', 'completed', 22, '完成发布说明与检查清单'),
    task('task-review', rootTaskId, 'laptop-02-reviewer', 'reviewer', 'result_review', 'completed', 13, '审核完整成果'),
    task('task-intake', rootTaskId, 'laptop-01-planner', 'planner', 'result_intake', 'running', 5, '接收通过审核的简报'),
  ]

  const messages: HubMessage[] = [
    message(1, rootTaskId, rootTaskId, 'human', 'human', 'task_instruction', '改进发布说明流程，最终交付一份可直接发布的说明。', 28, ['@planner']),
    message(2, rootTaskId, rootTaskId, 'laptop-01-planner', 'planner', 'task_brief', '已拆成一个独立交付：完成发布说明并按三项标准自检。', 25, ['@executor']),
    message(3, rootTaskId, 'task-execute', 'laptop-01-executor', 'executor', 'task_brief', '发布说明和核对清单已完成，内容覆盖变更、影响与回退方式。', 16, ['@reviewer'], [{
      type: 'full_result',
      label: '完整成果',
      taskId: 'task-execute',
      version: 'v1',
      content: '# 发布说明\n\n本次更新完善了多 Agent 任务协作流程，并加入审核与用量记录。\n\n## 影响\n任务结果必须经过审核后才能交给规划 Agent。',
    }]),
    message(4, rootTaskId, 'task-review', 'laptop-02-reviewer', 'reviewer', 'review_decision', '审核通过：内容完整，三项验收标准均满足。', 10, ['laptop-01-executor']),
    message(5, rootTaskId, 'task-intake', 'laptop-01-planner', 'planner', 'status', '正在接收审核后的任务简报。', 5),
  ]

  const conversations: Conversation[] = [{
    rootTaskId,
    title: '发布说明协作改进',
    status: 'active',
    createdAt: isoAgo(28),
    updatedAt: isoAgo(5),
    participants: ['human', 'laptop-01-planner', 'laptop-01-executor', 'laptop-02-reviewer'],
    taskCount: 4,
    messageCount: messages.length,
    humanIntervention: null,
  }]

  const events: HubEvent[] = messages.map((item) => ({
    seq: item.seq,
    ts: item.createdAt,
    type: `message.${item.kind}`,
    details: { rootTaskId, taskId: item.taskId, senderId: item.senderId },
  })).reverse()

  return {
    health: { ok: true, protocolVersion: 1, now: new Date().toISOString() },
    agents,
    tasks,
    conversations,
    messages,
    interventions: [],
    usage: {
      totals: usage(43_500, 14_590),
      byAgent: agents.map((agent) => ({
        agentId: agent.agentId,
        deviceId: agent.deviceId,
        account: agent.account,
        usageTotals: agent.usageTotals,
        quotaSnapshot: agent.quotaSnapshot,
      })),
    },
    events,
  }
}

function quota(state: 'Healthy' | 'Low' | 'Exhausted' | 'Unknown', usedPercent?: number) {
  return {
    state,
    checkedAt: new Date().toISOString(),
    source: state === 'Unknown' ? 'unavailable' : 'client',
    windows: usedPercent == null ? [] : [{
      name: 'rolling-window',
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: new Date(Date.now() + 180 * minute).toISOString(),
    }],
  }
}

function task(
  taskId: string,
  rootTaskId: string,
  targetAgentId: string,
  role: 'planner' | 'executor' | 'reviewer',
  stage: string,
  status: string,
  minutesAgo: number,
  title: string,
): HubTask {
  return {
    taskId,
    rootTaskId,
    targetAgentId,
    sourceAgentId: taskId === rootTaskId ? 'human' : 'agent',
    input: title,
    role,
    stage,
    status,
    taskSpec: { title, acceptance: ['内容完整', '可直接核验', '无越权操作'] },
    createdAt: isoAgo(minutesAgo),
    ...(status === 'running' ? { startedAt: isoAgo(minutesAgo - 1) } : { completedAt: isoAgo(minutesAgo - 3) }),
  }
}

function message(
  seq: number,
  rootTaskId: string,
  taskId: string,
  senderId: string,
  senderRole: string,
  kind: string,
  text: string,
  minutesAgo: number,
  mentions: string[] = [],
  attachments: HubMessage['attachments'] = [],
): HubMessage {
  return { messageId: `demo-message-${seq}`, seq, rootTaskId, taskId, senderId, senderRole, kind, text, mentions, attachments, createdAt: isoAgo(minutesAgo) }
}
