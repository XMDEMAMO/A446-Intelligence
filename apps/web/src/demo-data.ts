import type { Agent, HubEvent, HubSnapshot, HubTask } from './types'

const minute = 60_000

function isoAgo(minutes: number) {
  return new Date(Date.now() - minutes * minute).toISOString()
}

export function createDemoSnapshot(): HubSnapshot {
  const agents: Agent[] = [
    {
      agentId: 'studio-codex-01',
      status: 'online',
      busy: true,
      paused: false,
      adapter: 'codex-exec-resume',
      capabilities: ['coding', 'document_editing', 'terminal'],
      currentTaskId: 'task-research-brief',
      lastSeenAt: isoAgo(0),
      observedCapabilities: {
        adapter: { name: 'codex', available: true, version: 'codex-cli' },
        tools: [
          { name: 'git', available: true, version: 'git 2.x' },
          { name: 'node', available: true, version: 'node 24' },
        ],
      },
      executors: [{ type: 'codex-exec-resume', health: 'Healthy', quota: 'Healthy' }],
    },
    {
      agentId: 'lab-antigravity-02',
      status: 'online',
      busy: false,
      paused: false,
      adapter: 'antigravity-stream-json',
      capabilities: ['reasoning', 'document_editing', 'terminal'],
      lastSeenAt: isoAgo(1),
      observedCapabilities: {
        adapter: { name: 'antigravity', available: true, version: 'agy' },
        tools: [{ name: 'git', available: true, version: 'git 2.x' }],
      },
      executors: [{ type: 'antigravity-stream-json', health: 'Degraded', quota: 'Low' }],
    },
    {
      agentId: 'archive-local-03',
      status: 'offline',
      busy: false,
      paused: false,
      adapter: 'local-tools',
      capabilities: ['file_processing', 'validation'],
      disconnectedAt: isoAgo(18),
      lastSeenAt: isoAgo(18),
      executors: [{ type: 'local-tools', health: 'Unhealthy', quota: 'Unknown' }],
    },
  ]

  const tasks: HubTask[] = [
    {
      taskId: 'task-research-brief',
      rootTaskId: 'task-research-brief',
      targetAgentId: 'studio-codex-01',
      sourceAgentId: 'human',
      input: '整理访谈记录，提炼高频问题并生成结构化摘要。',
      taskSpec: {
        title: '生成客户访谈摘要',
        type: 'document_analysis',
        priority: 'P1',
        expected_outputs: ['outputs/interview-summary.md'],
        permissions_required: { project_workspace: true, terminal: true, browser: false },
        acceptance: ['包含主要主题、证据与待确认项'],
      },
      status: 'running',
      createdAt: isoAgo(24),
      dispatchedAt: isoAgo(23),
      startedAt: isoAgo(22),
      checkpoint: {
        checkpointId: 'cp-task-research-brief-running',
        stage: 'RUNNING',
        path: '.agent-hub/checkpoints/task-research-brief',
      },
    },
    {
      taskId: 'task-release-note',
      rootTaskId: 'task-release-note',
      targetAgentId: 'lab-antigravity-02',
      sourceAgentId: 'human',
      input: '根据变更清单生成对外发布说明。',
      taskSpec: {
        title: '发布说明审批',
        type: 'content_generation',
        priority: 'P0',
        expected_outputs: ['outputs/release-note.md'],
        permissions_required: { project_workspace: true, browser: false },
      },
      requiresApproval: true,
      status: 'awaiting_approval',
      createdAt: isoAgo(15),
    },
    {
      taskId: 'task-catalog-check',
      rootTaskId: 'task-catalog-check',
      targetAgentId: 'studio-codex-01',
      sourceAgentId: 'human',
      input: '检查交付目录中的文件命名与完整性。',
      taskSpec: {
        title: '校验交付目录',
        type: 'validation',
        priority: 'P1',
        expected_outputs: ['outputs/catalog-report.json'],
        permissions_required: { project_workspace: true, terminal: true },
      },
      status: 'completed',
      createdAt: isoAgo(58),
      dispatchedAt: isoAgo(57),
      startedAt: isoAgo(56),
      completedAt: isoAgo(49),
      output: '目录检查完成，共验证 18 个文件，未发现缺失项。',
      artifacts: {
        algorithm: 'sha256',
        files: [
          {
            path: 'outputs/catalog-report.json',
            size: 1842,
            sha256: '5f2d8e11a7f24f8f4fb5af44ea92a78bf05dd8eb2f1ad812d35795b3e55d4ca4',
            status: 'ready',
          },
        ],
        missing: [],
      },
      checkpoint: {
        checkpointId: 'cp-task-catalog-check-completed',
        stage: 'COMPLETED',
        path: '.agent-hub/checkpoints/task-catalog-check',
      },
    },
    {
      taskId: 'task-browser-profile',
      rootTaskId: 'task-browser-profile',
      targetAgentId: 'studio-codex-01',
      sourceAgentId: 'human',
      input: '读取浏览器个人资料并导出登录状态。',
      taskSpec: {
        title: '读取浏览器资料',
        type: 'restricted_operation',
        priority: 'P2',
        permissions_required: { browser_profile: true },
      },
      status: 'rejected',
      createdAt: isoAgo(72),
      completedAt: isoAgo(72),
      error: {
        name: 'PolicyDeniedError',
        code: 'POLICY_DENIED',
        reasons: ['browser_profile is never allowed by local policy'],
      },
      checkpoint: {
        checkpointId: 'cp-task-browser-profile-rejected',
        stage: 'REJECTED',
        path: '.agent-hub/checkpoints/task-browser-profile',
      },
    },
  ]

  const events: HubEvent[] = [
    event(41, 'task.started', 22, { taskId: 'task-research-brief', agentId: 'studio-codex-01' }),
    event(42, 'worker.heartbeat', 11, { agentId: 'lab-antigravity-02', quota: 'Low' }),
    event(43, 'task.created', 15, { taskId: 'task-release-note', sourceAgentId: 'human' }),
    event(44, 'approval.requested', 14, { taskId: 'task-release-note', agentId: 'lab-antigravity-02' }),
    event(45, 'task.result', 49, { taskId: 'task-catalog-check', agentId: 'studio-codex-01' }),
    event(46, 'task.rejected', 72, { taskId: 'task-browser-profile', agentId: 'studio-codex-01' }),
  ].sort((a, b) => b.seq - a.seq)

  return {
    health: { ok: true, protocolVersion: 1, now: new Date().toISOString() },
    agents,
    tasks,
    events,
  }
}

function event(seq: number, type: string, minutesAgo: number, details: Record<string, unknown>): HubEvent {
  return { seq, type, ts: isoAgo(minutesAgo), details }
}
\n