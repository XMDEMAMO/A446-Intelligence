import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { createDemoSnapshot } from './demo-data'
import { createHubTask, getHubSnapshot, sendHubCommand } from './hub-api'
import type { Agent, CreateTaskRequest, HubEvent, HubSnapshot, HubTask } from './types'

type ViewKey = 'overview' | 'tasks' | 'agents' | 'approvals' | 'audit'
type TaskFilter = 'all' | 'active' | 'approval' | 'completed' | 'failed'

interface TaskDraft {
  title: string
  input: string
  targetAgentId: string
  expectedOutput: string
  terminal: boolean
  browser: boolean
  requiresApproval: boolean
}

const navItems: Array<{ key: ViewKey; label: string; marker: string }> = [
  { key: 'overview', label: '运行总览', marker: 'OV' },
  { key: 'tasks', label: '任务中心', marker: 'TK' },
  { key: 'agents', label: '执行节点', marker: 'AG' },
  { key: 'approvals', label: '人工审批', marker: 'AP' },
  { key: 'audit', label: '审计事件', marker: 'EV' },
]

const activeStatuses = new Set(['created', 'queued', 'dispatched', 'running', 'awaiting_approval'])
const failedStatuses = new Set(['failed', 'rejected', 'cancelled'])

function createDraft(agentId = ''): TaskDraft {
  return {
    title: '',
    input: '',
    targetAgentId: agentId,
    expectedOutput: 'outputs/result.md',
    terminal: false,
    browser: false,
    requiresApproval: false,
  }
}

function App() {
  const [snapshot, setSnapshot] = useState<HubSnapshot>(() => createDemoSnapshot())
  const [connectionMode, setConnectionMode] = useState<'connecting' | 'live' | 'demo'>('connecting')
  const [lastError, setLastError] = useState('')
  const [view, setView] = useState<ViewKey>('overview')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  const [draft, setDraft] = useState<TaskDraft>(() => createDraft())
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    try {
      const next = await getHubSnapshot()
      setSnapshot(next)
      setConnectionMode('live')
      setLastError('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Hub 暂时不可用'
      setLastError(message)
      setConnectionMode((current) => (current === 'live' ? 'live' : 'demo'))
    }
  }, [])

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  const tasks = useMemo(
    () => [...snapshot.tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [snapshot.tasks],
  )
  const onlineAgents = snapshot.agents.filter((agent) => agent.status === 'online')
  const approvalTasks = tasks.filter((task) => task.status === 'awaiting_approval')
  const selectedTask = tasks.find((task) => task.taskId === selectedTaskId) ?? null

  function openTaskModal() {
    const preferredAgent = onlineAgents.find((agent) => !agent.paused)?.agentId ?? onlineAgents[0]?.agentId ?? ''
    setDraft(createDraft(preferredAgent))
    setTaskModalOpen(true)
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft.targetAgentId || !draft.input.trim()) return

    const request: CreateTaskRequest = {
      targetAgentId: draft.targetAgentId,
      input: draft.input.trim(),
      requiresApproval: draft.requiresApproval,
      taskSpec: {
        title: draft.title.trim() || draft.input.trim().slice(0, 32),
        type: 'general',
        priority: 'P1',
        expected_outputs: draft.expectedOutput.trim() ? [draft.expectedOutput.trim()] : [],
        permissions_required: {
          project_workspace: true,
          terminal: draft.terminal,
          browser: draft.browser,
        },
        checkpoint_policy: { mode: 'stage' },
        acceptance: ['按任务说明完成，并返回可核验的结果或产物清单'],
      },
    }

    setIsSubmitting(true)
    try {
      if (connectionMode === 'live') {
        const result = await createHubTask(request)
        setSelectedTaskId(result.task.taskId)
        await refresh()
      } else {
        const taskId = 'demo-' + crypto.randomUUID()
        const now = new Date().toISOString()
        const task: HubTask = {
          taskId,
          rootTaskId: taskId,
          sourceAgentId: 'human',
          targetAgentId: request.targetAgentId,
          input: request.input,
          requiresApproval: request.requiresApproval,
          taskSpec: request.taskSpec,
          status: request.requiresApproval ? 'awaiting_approval' : 'queued',
          createdAt: now,
        }
        setSnapshot((current) => ({
          ...current,
          tasks: [task, ...current.tasks],
          events: [
            {
              seq: Math.max(0, ...current.events.map((item) => item.seq)) + 1,
              ts: now,
              type: request.requiresApproval ? 'approval.requested' : 'task.created',
              details: { taskId, agentId: request.targetAgentId, demo: true },
            },
            ...current.events,
          ],
        }))
        setSelectedTaskId(taskId)
      }
      setTaskModalOpen(false)
      setNotice(connectionMode === 'live' ? '任务已提交到 Hub' : '演示任务已创建')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '任务提交失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function runCommand(command: Record<string, unknown>) {
    try {
      if (connectionMode === 'live') {
        await sendHubCommand(command)
        await refresh()
      } else {
        applyDemoCommand(command, setSnapshot)
      }
      setNotice('操作已生效')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败')
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            A4
          </span>
          <span>
            <strong>A446</strong>
            <small>Agent control</small>
          </span>
        </div>

        <nav className="main-nav" aria-label="主导航">
          <span className="nav-caption">控制中心</span>
          {navItems.map((item) => (
            <button
              className={view === item.key ? 'nav-item active' : 'nav-item'}
              key={item.key}
              onClick={() => setView(item.key)}
              type="button"
            >
              <span>{item.marker}</span>
              {item.label}
              {item.key === 'approvals' && approvalTasks.length > 0 && (
                <b className="nav-count">{approvalTasks.length}</b>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="hub-readout">
            <div className="eyebrow">本地 Hub</div>
            <div className="hub-state">
              <i className={'signal ' + connectionMode} />
              <strong>
                {connectionMode === 'live' ? '实时连接' : connectionMode === 'demo' ? '演示模式' : '正在连接'}
              </strong>
            </div>
            <small>
              {connectionMode === 'live'
                ? '协议 v' + snapshot.health.protocolVersion + ' · 3 秒同步'
                : '启动 Hub 后自动切换'}
            </small>
          </div>
          <button className="sync-button" type="button" onClick={() => void refresh()}>
            ↻ 立即同步
          </button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <div className="breadcrumb">A446 / {viewTitle(view)}</div>
            <h1>{viewTitle(view)}</h1>
          </div>
          <div className="topbar-actions">
            <div className={'connection-chip ' + connectionMode} title={lastError || undefined}>
              <span />
              {connectionMode === 'live' ? 'Hub 已连接' : connectionMode === 'demo' ? '离线演示' : '正在连接'}
            </div>
            <button className="primary-button" type="button" onClick={openTaskModal}>
              <span>＋</span> 新建任务
            </button>
          </div>
        </header>

        {lastError && connectionMode === 'live' && (
          <div className="warning-bar">最近一次同步失败，正在保留最后可用数据：{lastError}</div>
        )}

        <section className="workspace">
          {view === 'overview' && (
            <Overview
              agents={snapshot.agents}
              events={snapshot.events}
              tasks={tasks}
              approvals={approvalTasks.length}
              onSelectTask={setSelectedTaskId}
              onOpenTasks={() => setView('tasks')}
            />
          )}
          {view === 'tasks' && (
            <TasksView
              tasks={tasks}
              filter={filter}
              setFilter={setFilter}
              onSelectTask={setSelectedTaskId}
              onNewTask={openTaskModal}
            />
          )}
          {view === 'agents' && (
            <AgentsView
              agents={snapshot.agents}
              onCommand={(type, agentId) => void runCommand({ type, targetAgentId: agentId })}
            />
          )}
          {view === 'approvals' && (
            <ApprovalsView
              tasks={approvalTasks}
              onApprove={(taskId) => void runCommand({ type: 'task.approve', taskId, by: 'console-user' })}
              onSelectTask={setSelectedTaskId}
            />
          )}
          {view === 'audit' && <AuditView events={snapshot.events} />}
        </section>
      </main>

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          onClose={() => setSelectedTaskId(null)}
          onApprove={(taskId) => void runCommand({ type: 'task.approve', taskId, by: 'console-user' })}
          onCancel={(taskId) => void runCommand({ type: 'task.cancel', taskId })}
        />
      )}

      {taskModalOpen && (
        <TaskModal
          agents={snapshot.agents}
          draft={draft}
          setDraft={setDraft}
          isSubmitting={isSubmitting}
          onClose={() => setTaskModalOpen(false)}
          onSubmit={submitTask}
        />
      )}

      {notice && <div className="toast">{notice}</div>}
    </div>
  )
}

function Overview({
  agents,
  tasks,
  events,
  approvals,
  onSelectTask,
  onOpenTasks,
}: {
  agents: Agent[]
  tasks: HubTask[]
  events: HubEvent[]
  approvals: number
  onSelectTask: (taskId: string) => void
  onOpenTasks: () => void
}) {
  const online = agents.filter((agent) => agent.status === 'online').length
  const active = tasks.filter((task) => activeStatuses.has(task.status)).length
  const terminal = tasks.filter((task) => ['completed', 'failed', 'rejected', 'cancelled'].includes(task.status))
  const completionRate = terminal.length
    ? Math.round((terminal.filter((task) => task.status === 'completed').length / terminal.length) * 100)
    : 0

  return (
    <>
      <div className="metric-strip">
        <Metric label="在线节点" value={online + ' / ' + agents.length} detail="可被 Hub 调度" tone="blue" />
        <Metric label="活动任务" value={String(active)} detail="排队、执行或待审批" tone="cyan" />
        <Metric label="待人工处理" value={String(approvals)} detail={approvals ? '需要你的决策' : '当前没有阻塞'} tone="amber" />
        <Metric label="终态成功率" value={completionRate + '%'} detail="当前任务样本" tone="green" />
      </div>

      <div className="section-heading">
        <div>
          <span className="eyebrow">执行网络</span>
          <h2>节点态势</h2>
        </div>
        <span className="section-note">心跳、执行器与额度均来自 Worker 上报</span>
      </div>
      <div className="agent-ribbon">
        {agents.map((agent) => (
          <AgentSummary agent={agent} key={agent.agentId} />
        ))}
      </div>

      <div className="dashboard-grid">
        <section className="panel task-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">近期工作</span>
              <h2>最近任务</h2>
            </div>
            <button className="text-button" type="button" onClick={onOpenTasks}>
              查看全部
            </button>
          </div>
          <TaskTable tasks={tasks.slice(0, 6)} onSelectTask={onSelectTask} compact />
        </section>

        <section className="panel event-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">事件流</span>
              <h2>实时事件</h2>
            </div>
            <span className="live-label"><i /> 实时</span>
          </div>
          <EventList events={events.slice(0, 8)} />
        </section>
      </div>
    </>
  )
}

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone: string
}) {
  return (
    <article className={'metric ' + tone}>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <p>{detail}</p>
      </div>
    </article>
  )
}

function AgentSummary({ agent }: { agent: Agent }) {
  const executor = agent.executors?.[0]
  const state = agent.status !== 'online' ? 'offline' : agent.paused ? 'paused' : agent.busy ? 'busy' : 'ready'
  return (
    <article className={'agent-summary ' + state}>
      <div className="agent-topline">
        <span className={'agent-orb ' + state}>{agent.agentId.slice(0, 2).toUpperCase()}</span>
        <StatusPill status={state} />
      </div>
      <strong className="agent-name">{agent.agentId}</strong>
      <span className="mono-muted">{agent.adapter ?? 'adapter unknown'}</span>
      <div className="agent-gauges">
        <span>健康 <b>{executor?.health ?? 'Unknown'}</b></span>
        <span>额度 <b>{executor?.quota ?? 'Unknown'}</b></span>
      </div>
    </article>
  )
}

function TasksView({
  tasks,
  filter,
  setFilter,
  onSelectTask,
  onNewTask,
}: {
  tasks: HubTask[]
  filter: TaskFilter
  setFilter: (filter: TaskFilter) => void
  onSelectTask: (taskId: string) => void
  onNewTask: () => void
}) {
  const filters: Array<{ key: TaskFilter; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'active', label: '进行中' },
    { key: 'approval', label: '待审批' },
    { key: 'completed', label: '已完成' },
    { key: 'failed', label: '异常' },
  ]
  const visible = tasks.filter((task) => {
    if (filter === 'active') return activeStatuses.has(task.status)
    if (filter === 'approval') return task.status === 'awaiting_approval'
    if (filter === 'completed') return task.status === 'completed'
    if (filter === 'failed') return failedStatuses.has(task.status)
    return true
  })

  return (
    <section className="panel full-panel">
      <div className="panel-heading task-heading">
        <div>
          <span className="eyebrow">任务登记</span>
          <h2>任务队列</h2>
          <p>从下发、审批、执行到产物校验的完整状态。</p>
        </div>
        <button className="primary-button small" type="button" onClick={onNewTask}>＋ 创建任务</button>
      </div>
      <div className="filter-bar" role="group" aria-label="任务筛选">
        {filters.map((item) => (
          <button
            className={filter === item.key ? 'active' : ''}
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
          >
            {item.label}
            <span>{countForFilter(tasks, item.key)}</span>
          </button>
        ))}
      </div>
      <TaskTable tasks={visible} onSelectTask={onSelectTask} />
    </section>
  )
}

function TaskTable({
  tasks,
  onSelectTask,
  compact = false,
}: {
  tasks: HubTask[]
  onSelectTask: (taskId: string) => void
  compact?: boolean
}) {
  if (!tasks.length) return <EmptyState title="没有匹配的任务" detail="创建一个任务，或切换筛选条件。" />
  return (
    <div className="table-scroll">
      <table className="task-table">
        <thead>
          <tr>
            <th>任务</th>
            <th>执行节点</th>
            {!compact && <th>权限</th>}
            <th>状态</th>
            <th>更新时间</th>
            <th aria-label="打开">操作</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.taskId} onClick={() => onSelectTask(task.taskId)}>
              <td>
                <strong>{task.taskSpec?.title ?? task.input.slice(0, 36)}</strong>
                <span className="task-id">#{shortId(task.taskId)}</span>
              </td>
              <td><span className="agent-inline"><i />{task.targetAgentId}</span></td>
              {!compact && <td><PermissionTags task={task} /></td>}
              <td><StatusPill status={task.status} /></td>
              <td className="muted-cell">{relativeTime(task.completedAt ?? task.startedAt ?? task.createdAt)}</td>
              <td className="arrow-cell">查看</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AgentsView({
  agents,
  onCommand,
}: {
  agents: Agent[]
  onCommand: (type: 'agent.pause' | 'agent.resume', agentId: string) => void
}) {
  return (
    <div className="agents-layout">
      <div className="section-heading flush">
        <div>
          <span className="eyebrow">节点目录</span>
          <h2>已注册执行节点</h2>
        </div>
        <span className="section-note">{agents.length} 个节点 · {agents.filter((a) => a.status === 'online').length} 个在线</span>
      </div>
      <div className="agent-list">
        {agents.map((agent) => {
          const executor = agent.executors?.[0]
          return (
            <article className="agent-card" key={agent.agentId}>
              <div className="agent-card-head">
                <span className={'agent-orb large ' + (agent.status === 'online' ? 'ready' : 'offline')}>
                  {agent.agentId.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <h3>{agent.agentId}</h3>
                  <span className="mono-muted">{agent.adapter ?? '未上报适配器'}</span>
                </div>
                <StatusPill status={agent.status !== 'online' ? 'offline' : agent.paused ? 'paused' : agent.busy ? 'busy' : 'ready'} />
              </div>
              <div className="agent-facts">
                <div><small>执行器健康</small><strong>{executor?.health ?? 'Unknown'}</strong></div>
                <div><small>额度状态</small><strong>{executor?.quota ?? 'Unknown'}</strong></div>
                <div><small>最后心跳</small><strong>{relativeTime(agent.lastSeenAt ?? agent.disconnectedAt)}</strong></div>
                <div><small>当前任务</small><strong>{agent.currentTaskId ? '#' + shortId(agent.currentTaskId) : '空闲'}</strong></div>
              </div>
              <div className="capability-block">
                <small>声明能力</small>
                <div className="tag-row">
                  {(agent.capabilities ?? []).map((capability) => <span key={capability}>{capability}</span>)}
                  {!agent.capabilities?.length && <span>未上报</span>}
                </div>
              </div>
              <div className="tool-list">
                {(agent.observedCapabilities?.tools ?? []).map((tool) => (
                  <span key={tool.name}><i className={tool.available ? 'ok' : 'bad'} />{tool.name} {tool.version ?? ''}</span>
                ))}
              </div>
              <div className="agent-actions">
                <button
                  type="button"
                  disabled={agent.status !== 'online'}
                  onClick={() => onCommand(agent.paused ? 'agent.resume' : 'agent.pause', agent.agentId)}
                >
                  {agent.paused ? '恢复节点' : '暂停接单'}
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

function ApprovalsView({
  tasks,
  onApprove,
  onSelectTask,
}: {
  tasks: HubTask[]
  onApprove: (taskId: string) => void
  onSelectTask: (taskId: string) => void
}) {
  return (
    <section className="panel full-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">人工确认</span>
          <h2>等待人工决策</h2>
          <p>审批只解除 Hub 的等待状态，本地 Worker 仍会再次执行策略检查。</p>
        </div>
      </div>
      {!tasks.length ? (
        <EmptyState title="审批队列为空" detail="需要人工确认的任务会出现在这里。" />
      ) : (
        <div className="approval-list">
          {tasks.map((task) => (
            <article className="approval-item" key={task.taskId}>
              <span className="approval-flag">!</span>
              <div className="approval-copy">
                <small>{task.taskSpec?.type ?? 'general'} · {relativeTime(task.createdAt)}</small>
                <h3>{task.taskSpec?.title ?? task.input.slice(0, 50)}</h3>
                <p>{task.input}</p>
                <PermissionTags task={task} />
              </div>
              <div className="approval-side">
                <span>目标节点</span>
                <strong>{task.targetAgentId}</strong>
                <button className="primary-button small" type="button" onClick={() => onApprove(task.taskId)}>
                  批准执行
                </button>
                <button className="text-button" type="button" onClick={() => onSelectTask(task.taskId)}>
                  查看详情
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function AuditView({ events }: { events: HubEvent[] }) {
  return (
    <section className="panel full-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">审计记录</span>
          <h2>协议与审计事件</h2>
          <p>显示 Hub 最近记录的事件，便于定位任务流转和 Worker 状态变化。</p>
        </div>
        <span className="event-count">{events.length} 条事件</span>
      </div>
      <EventList events={events} detailed />
    </section>
  )
}

function EventList({ events, detailed = false }: { events: HubEvent[]; detailed?: boolean }) {
  if (!events.length) return <EmptyState title="还没有事件" detail="Worker 连接或任务创建后会留下记录。" />
  return (
    <div className={detailed ? 'event-list detailed' : 'event-list'}>
      {events.map((event) => (
        <article className="event-row" key={event.seq + '-' + event.ts}>
          <span className={'event-icon ' + eventTone(event.type)}>{event.seq}</span>
          <div className="event-copy">
            <div><strong>{eventLabel(event.type)}</strong><code>{event.type}</code></div>
            <p>{eventDescription(event)}</p>
            {detailed && <pre>{JSON.stringify(event.details, null, 2)}</pre>}
          </div>
          <time>{relativeTime(event.ts)}</time>
        </article>
      ))}
    </div>
  )
}

function TaskDrawer({
  task,
  onClose,
  onApprove,
  onCancel,
}: {
  task: HubTask
  onClose: () => void
  onApprove: (taskId: string) => void
  onCancel: (taskId: string) => void
}) {
  const cancellable = activeStatuses.has(task.status)
  return (
    <div className="drawer-layer" role="presentation" onMouseDown={onClose}>
      <aside
        className="task-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="任务详情"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <span className="eyebrow">任务 #{shortId(task.taskId)}</span>
            <h2>{task.taskSpec?.title ?? '未命名任务'}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="drawer-status">
          <StatusPill status={task.status} />
          <span>{task.targetAgentId}</span>
          <span>{relativeTime(task.createdAt)}</span>
        </div>

        <DrawerSection title="任务说明">
          <p className="task-prompt">{task.input}</p>
        </DrawerSection>

        <DrawerSection title="任务约束">
          <dl className="detail-grid">
            <div><dt>类型</dt><dd>{task.taskSpec?.type ?? 'general'}</dd></div>
            <div><dt>优先级</dt><dd>{task.taskSpec?.priority ?? '未设置'}</dd></div>
            <div><dt>根任务</dt><dd>#{shortId(task.rootTaskId ?? task.taskId)}</dd></div>
            <div><dt>人工门禁</dt><dd>{task.requiresApproval ? '需要' : '不需要'}</dd></div>
          </dl>
          <PermissionTags task={task} />
          {!!task.taskSpec?.expected_outputs?.length && (
            <div className="path-list">
              <small>预期产物</small>
              {task.taskSpec.expected_outputs.map((output) => (
                <code key={typeof output === 'string' ? output : output.path}>
                  {typeof output === 'string' ? output : output.path}
                </code>
              ))}
            </div>
          )}
        </DrawerSection>

        {task.checkpoint && (
          <DrawerSection title="最近检查点">
            <div className="checkpoint">
              <span>{task.checkpoint.stage ?? 'UNKNOWN'}</span>
              <code>{task.checkpoint.path ?? task.checkpoint.checkpointId}</code>
            </div>
          </DrawerSection>
        )}

        {(task.output || task.error) && (
          <DrawerSection title={task.error ? '异常信息' : '执行结果'}>
            <pre className={task.error ? 'result-box error' : 'result-box'}>
              {task.error ? JSON.stringify(task.error, null, 2) : task.output}
            </pre>
          </DrawerSection>
        )}

        {!!task.artifacts?.files?.length && (
          <DrawerSection title="产物清单">
            <div className="artifact-list">
              {task.artifacts.files.map((file) => (
                <div key={file.path}>
                  <strong>{file.path}</strong>
                  <span>{formatBytes(file.size)} · {file.status}</span>
                  <code>{file.sha256 ? 'sha256:' + file.sha256.slice(0, 20) + '…' : '未计算哈希'}</code>
                </div>
              ))}
            </div>
          </DrawerSection>
        )}

        <div className="drawer-actions">
          {task.status === 'awaiting_approval' && (
            <button className="primary-button" type="button" onClick={() => onApprove(task.taskId)}>批准执行</button>
          )}
          {cancellable && (
            <button className="danger-button" type="button" onClick={() => onCancel(task.taskId)}>取消任务</button>
          )}
        </div>
      </aside>
    </div>
  )
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="drawer-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function TaskModal({
  agents,
  draft,
  setDraft,
  isSubmitting,
  onClose,
  onSubmit,
}: {
  agents: Agent[]
  draft: TaskDraft
  setDraft: React.Dispatch<React.SetStateAction<TaskDraft>>
  isSubmitting: boolean
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const eligibleAgents = agents.filter((agent) => agent.status === 'online')
  return (
    <div className="modal-layer" role="presentation" onMouseDown={onClose}>
      <form className="task-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <span className="eyebrow">下发任务</span>
            <h2>创建通用任务</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <p className="modal-intro">描述目标、选择执行节点，并明确这次任务可以使用的能力。</p>

        <label>
          <span>任务名称 <em>可选</em></span>
          <input
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="例如：整理会议材料"
          />
        </label>
        <label>
          <span>任务说明 <b>*</b></span>
          <textarea
            required
            value={draft.input}
            onChange={(event) => setDraft((current) => ({ ...current, input: event.target.value }))}
            placeholder="清楚说明目标、输入信息和完成标准…"
            rows={5}
          />
        </label>
        <div className="form-grid">
          <label>
            <span>执行节点 <b>*</b></span>
            <select
              required
              value={draft.targetAgentId}
              onChange={(event) => setDraft((current) => ({ ...current, targetAgentId: event.target.value }))}
            >
              <option value="">选择在线节点</option>
              {eligibleAgents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.agentId}{agent.paused ? '（已暂停）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>预期产物路径</span>
            <input
              value={draft.expectedOutput}
              onChange={(event) => setDraft((current) => ({ ...current, expectedOutput: event.target.value }))}
              placeholder="outputs/result.md"
            />
          </label>
        </div>

        <fieldset>
          <legend>权限声明</legend>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.terminal}
              onChange={(event) => setDraft((current) => ({ ...current, terminal: event.target.checked }))}
            />
            <span><strong>终端命令</strong><small>允许 Worker 在受控工作区调用命令行工具</small></span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.browser}
              onChange={(event) => setDraft((current) => ({ ...current, browser: event.target.checked }))}
            />
            <span><strong>浏览器访问</strong><small>仅声明需求，最终仍由 Worker 本地策略决定</small></span>
          </label>
          <label className="check-row approval-check">
            <input
              type="checkbox"
              checked={draft.requiresApproval}
              onChange={(event) => setDraft((current) => ({ ...current, requiresApproval: event.target.checked }))}
            />
            <span><strong>执行前需要人工批准</strong><small>任务先进入等待审批状态</small></span>
          </label>
        </fieldset>

        {!eligibleAgents.length && <div className="form-warning">没有在线节点，暂时无法提交真实任务。</div>}
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={isSubmitting || !eligibleAgents.length || !draft.input.trim()}>
            {isSubmitting ? '正在提交…' : draft.requiresApproval ? '提交审批' : '下发任务'}
          </button>
        </div>
      </form>
    </div>
  )
}

function PermissionTags({ task }: { task: HubTask }) {
  const permissions = Object.entries(task.taskSpec?.permissions_required ?? {}).filter(([, enabled]) => enabled)
  if (!permissions.length) return <span className="permission-none">仅工作区</span>
  return (
    <span className="permission-tags">
      {permissions.slice(0, 3).map(([name]) => <span key={name}>{permissionLabel(name)}</span>)}
      {permissions.length > 3 && <span>+{permissions.length - 3}</span>}
    </span>
  )
}

function StatusPill({ status }: { status: string }) {
  return <span className={'status-pill ' + statusTone(status)}><i />{statusLabel(status)}</span>
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span>∅</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  )
}

function applyDemoCommand(
  command: Record<string, unknown>,
  setSnapshot: React.Dispatch<React.SetStateAction<HubSnapshot>>,
) {
  const now = new Date().toISOString()
  setSnapshot((current) => {
    const type = String(command.type ?? '')
    let tasks = current.tasks
    let agents = current.agents
    if (type === 'task.approve') {
      tasks = tasks.map((task) =>
        task.taskId === command.taskId
          ? { ...task, status: 'queued', requiresApproval: false, approval: { approvedAt: now, approvedBy: 'console-user' } }
          : task,
      )
    } else if (type === 'task.cancel') {
      tasks = tasks.map((task) =>
        task.taskId === command.taskId ? { ...task, status: 'cancelled', completedAt: now } : task,
      )
    } else if (type === 'agent.pause' || type === 'agent.resume') {
      agents = agents.map((agent) =>
        agent.agentId === command.targetAgentId ? { ...agent, paused: type === 'agent.pause' } : agent,
      )
    }
    return {
      ...current,
      tasks,
      agents,
      events: [
        {
          seq: Math.max(0, ...current.events.map((event) => event.seq)) + 1,
          ts: now,
          type,
          details: { ...command, demo: true },
        },
        ...current.events,
      ],
    }
  })
}

function viewTitle(view: ViewKey) {
  return navItems.find((item) => item.key === view)?.label ?? '运行总览'
}

function countForFilter(tasks: HubTask[], filter: TaskFilter) {
  if (filter === 'all') return tasks.length
  if (filter === 'active') return tasks.filter((task) => activeStatuses.has(task.status)).length
  if (filter === 'approval') return tasks.filter((task) => task.status === 'awaiting_approval').length
  if (filter === 'completed') return tasks.filter((task) => task.status === 'completed').length
  return tasks.filter((task) => failedStatuses.has(task.status)).length
}

function statusTone(status: string) {
  if (['online', 'ready', 'completed', 'Healthy'].includes(status)) return 'success'
  if (['running', 'busy', 'dispatched'].includes(status)) return 'info'
  if (['created', 'queued', 'paused', 'awaiting_approval', 'Low', 'Degraded'].includes(status)) return 'warning'
  if (['failed', 'rejected', 'cancelled', 'offline', 'Unhealthy', 'Exhausted'].includes(status)) return 'danger'
  return 'neutral'
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    online: '在线',
    offline: '离线',
    ready: '就绪',
    busy: '执行中',
    paused: '已暂停',
    created: '已创建',
    queued: '排队中',
    dispatched: '已下发',
    running: '执行中',
    awaiting_approval: '待审批',
    completed: '已完成',
    failed: '失败',
    rejected: '已拒绝',
    cancelled: '已取消',
  }
  return labels[status] ?? status
}

function permissionLabel(permission: string) {
  const labels: Record<string, string> = {
    project_workspace: '工作区',
    terminal: '终端',
    browser: '浏览器',
    browser_profile: '浏览器资料',
  }
  return labels[permission] ?? permission
}

function eventLabel(type: string) {
  if (type.includes('rejected')) return '策略拒绝'
  if (type.includes('approval')) return '等待审批'
  if (type.includes('result') || type.includes('completed')) return '任务完成'
  if (type.includes('started') || type.includes('assign')) return '开始执行'
  if (type.includes('heartbeat')) return '节点心跳'
  if (type.includes('connected') || type.includes('hello')) return '节点接入'
  if (type.includes('cancel')) return '任务取消'
  if (type.includes('pause')) return '节点暂停'
  return '状态更新'
}

function eventTone(type: string) {
  if (type.includes('rejected') || type.includes('failed') || type.includes('cancel')) return 'danger'
  if (type.includes('approval') || type.includes('pause')) return 'warning'
  if (type.includes('result') || type.includes('completed')) return 'success'
  return 'info'
}

function eventDescription(event: HubEvent) {
  const taskId = typeof event.details.taskId === 'string' ? '#' + shortId(event.details.taskId) : ''
  const agentId = typeof event.details.agentId === 'string' ? event.details.agentId : ''
  return [taskId, agentId].filter(Boolean).join(' · ') || 'Hub 记录了一次协议状态变化'
}

function shortId(id: string) {
  return id.length > 14 ? id.slice(-8) : id
}

function relativeTime(value?: string) {
  if (!value) return '未知'
  const delta = Date.now() - Date.parse(value)
  if (!Number.isFinite(delta)) return value
  if (delta < 45_000) return '刚刚'
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时前'
  return Math.floor(hours / 24) + ' 天前'
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

export default App
\n