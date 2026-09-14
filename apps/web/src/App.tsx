import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { createDemoSnapshot } from './demo-data'
import { createWorkflow, getHubSnapshot, sendConversationMessage, sendHubCommand } from './hub-api'
import type {
  Agent,
  AgentRole,
  Conversation,
  CreateWorkflowRequest,
  HubMessage,
  HubSnapshot,
  HubTask,
  QuotaSnapshot,
  TokenUsage,
} from './types'

interface WorkflowDraft {
  title: string
  objective: string
  acceptance: string
  plannerAgentId: string
  reviewerAgentId: string
  modelPreference: string
  reasoningEffort: string
  maxReviewCycles: number
}

const roleName: Record<string, string> = {
  planner: '规划 Agent',
  executor: '执行 Agent',
  reviewer: '审核 Agent',
  human: '人工',
  system: '系统',
}

const statusName: Record<string, string> = {
  active: '进行中',
  completed: '已完成',
  failed: '异常',
  needs_human: '需人工',
  queued: '排队中',
  dispatched: '已指派',
  running: '执行中',
  awaiting_approval: '待批准',
  rejected: '已拒绝',
  cancelled: '已取消',
}

function emptyDraft(): WorkflowDraft {
  return {
    title: '',
    objective: '',
    acceptance: '',
    plannerAgentId: '',
    reviewerAgentId: '',
    modelPreference: '',
    reasoningEffort: '',
    maxReviewCycles: 2,
  }
}

function App() {
  const [snapshot, setSnapshot] = useState<HubSnapshot>(() => createDemoSnapshot())
  const [connectionMode, setConnectionMode] = useState<'connecting' | 'live' | 'demo'>('connecting')
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [draft, setDraft] = useState<WorkflowDraft>(() => emptyDraft())
  const [messageText, setMessageText] = useState('')
  const [humanResponse, setHumanResponse] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState('')
  const [lastError, setLastError] = useState('')
  const chatEndRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await getHubSnapshot()
      setSnapshot(next)
      setConnectionMode('live')
      setLastError('')
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Hub 暂时不可用')
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
    const timer = window.setTimeout(() => setNotice(''), 2800)
    return () => window.clearTimeout(timer)
  }, [notice])

  const conversations = useMemo(
    () => [...snapshot.conversations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [snapshot.conversations],
  )
  const selectedConversation = conversations.find((item) => item.rootTaskId === selectedRootId) ?? conversations[0] ?? null
  const selectedMessages = useMemo(
    () => snapshot.messages.filter((item) => item.rootTaskId === selectedConversation?.rootTaskId).sort((a, b) => a.seq - b.seq),
    [snapshot.messages, selectedConversation?.rootTaskId],
  )
  const selectedTasks = useMemo(
    () => snapshot.tasks.filter((task) => task.rootTaskId === selectedConversation?.rootTaskId).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [snapshot.tasks, selectedConversation?.rootTaskId],
  )
  const participants = useMemo(
    () => (selectedConversation?.participants ?? []).map((id) => snapshot.agents.find((agent) => agent.agentId === id)).filter((agent): agent is Agent => Boolean(agent)),
    [selectedConversation?.participants, snapshot.agents],
  )
  const accounts = useMemo(() => groupAccountUsage(snapshot.agents), [snapshot.agents])
  const compatiblePlanners = snapshot.agents.filter((agent) => acceptsRole(agent, 'planner'))
  const compatibleReviewers = snapshot.agents.filter((agent) => acceptsRole(agent, 'reviewer'))
  const models = [...new Set(compatiblePlanners.flatMap((agent) => agent.models ?? []).filter((model) => model.enabled !== false && model.id).map((model) => model.id as string))]

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [selectedMessages.length, selectedConversation?.rootTaskId])

  async function submitWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft.objective.trim()) return
    const request: CreateWorkflowRequest = {
      title: draft.title.trim() || draft.objective.trim().slice(0, 40),
      objective: draft.objective.trim(),
      acceptance: draft.acceptance.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      plannerAgentId: draft.plannerAgentId || null,
      reviewerAgentId: draft.reviewerAgentId || null,
      modelPreference: draft.modelPreference || null,
      reasoningEffort: draft.reasoningEffort || null,
      maxReviewCycles: draft.maxReviewCycles,
    }
    setSubmitting(true)
    try {
      if (connectionMode === 'live') {
        const result = await createWorkflow(request)
        setSelectedRootId(result.task.rootTaskId ?? result.task.taskId)
        await refresh()
      } else {
        const rootTaskId = `demo-${crypto.randomUUID()}`
        const now = new Date().toISOString()
        const task: HubTask = {
          taskId: rootTaskId,
          rootTaskId,
          targetAgentId: request.plannerAgentId || null,
          sourceAgentId: 'human',
          input: request.objective,
          role: 'planner',
          stage: 'planning',
          status: 'queued',
          taskSpec: { title: request.title, acceptance: request.acceptance },
          createdAt: now,
        }
        const conversation: Conversation = {
          rootTaskId,
          title: request.title,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          participants: ['human'],
          taskCount: 1,
          messageCount: 1,
        }
        const message: HubMessage = {
          messageId: crypto.randomUUID(),
          seq: Math.max(0, ...snapshot.messages.map((item) => item.seq)) + 1,
          rootTaskId,
          taskId: rootTaskId,
          senderId: 'human',
          senderRole: 'human',
          kind: 'task_instruction',
          text: request.objective,
          mentions: ['@planner'],
          attachments: [],
          createdAt: now,
        }
        setSnapshot((current) => ({
          ...current,
          tasks: [task, ...current.tasks],
          conversations: [conversation, ...current.conversations],
          messages: [...current.messages, message],
        }))
        setSelectedRootId(rootTaskId)
      }
      setDraft(emptyDraft())
      setModalOpen(false)
      setNotice(connectionMode === 'live' ? '协作任务已创建' : '演示群聊已创建')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '任务创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = messageText.trim()
    if (!selectedConversation || !text) return
    setMessageText('')
    try {
      if (connectionMode === 'live') {
        await sendConversationMessage(selectedConversation.rootTaskId, text, extractMentions(text))
        await refresh()
      } else {
        const now = new Date().toISOString()
        setSnapshot((current) => ({
          ...current,
          messages: [...current.messages, {
            messageId: crypto.randomUUID(),
            seq: Math.max(0, ...current.messages.map((item) => item.seq)) + 1,
            rootTaskId: selectedConversation.rootTaskId,
            taskId: selectedConversation.rootTaskId,
            senderId: 'human',
            senderRole: 'human',
            kind: 'message',
            text,
            mentions: extractMentions(text),
            attachments: [],
            createdAt: now,
          }],
          conversations: current.conversations.map((item) => item.rootTaskId === selectedConversation.rootTaskId ? { ...item, updatedAt: now, messageCount: item.messageCount + 1 } : item),
        }))
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '消息发送失败')
    }
  }

  async function resolveHumanIntervention(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedConversation || !humanResponse.trim()) return
    try {
      if (connectionMode === 'live') {
        await sendHubCommand({ type: 'workflow.human_response', rootTaskId: selectedConversation.rootTaskId, response: humanResponse.trim(), by: 'human' })
        await refresh()
      }
      setHumanResponse('')
      setNotice('人工决定已交给规划 Agent')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提交失败')
    }
  }

  return (
    <div className="app-shell">
      <aside className="room-sidebar">
        <div className="brand-row">
          <div className="brand-mark">A4</div>
          <div><strong>A446 协作台</strong><span>Agent 群聊</span></div>
        </div>

        <button className="new-task" type="button" onClick={() => setModalOpen(true)}>＋ 新建协作任务</button>

        <div className="room-heading">
          <span>任务群聊</span>
          <b>{conversations.length}</b>
        </div>
        <div className="room-list">
          {conversations.map((conversation) => (
            <button
              className={`room-item ${selectedConversation?.rootTaskId === conversation.rootTaskId ? 'selected' : ''}`}
              key={conversation.rootTaskId}
              type="button"
              onClick={() => setSelectedRootId(conversation.rootTaskId)}
            >
              <i className={`room-status ${conversation.status}`} />
              <span>
                <strong>{conversation.title}</strong>
                <small>{statusName[conversation.status] ?? conversation.status} · {conversation.messageCount} 条消息</small>
              </span>
              <time>{relativeTime(conversation.updatedAt)}</time>
            </button>
          ))}
          {conversations.length === 0 && <div className="empty-list">还没有任务群聊</div>}
        </div>

        <div className="hub-state">
          <i className={`connection-dot ${connectionMode}`} />
          <span><strong>{connectionMode === 'live' ? 'Hub 已连接' : connectionMode === 'demo' ? '演示模式' : '连接中'}</strong><small>{snapshot.agents.filter((agent) => agent.status === 'online').length} 个 Agent 在线</small></span>
        </div>
      </aside>

      <main className="conversation-panel">
        {selectedConversation ? (
          <>
            <header className="conversation-header">
              <div>
                <span className={`status-pill ${selectedConversation.status}`}>{statusName[selectedConversation.status] ?? selectedConversation.status}</span>
                <h1>{selectedConversation.title}</h1>
                <p>一个任务对应一个群聊 · {selectedConversation.taskCount} 个内部步骤</p>
              </div>
              <div className="avatar-stack" aria-label="参与者">
                {participants.slice(0, 5).map((agent) => <AgentAvatar agent={agent} key={agent.agentId} />)}
              </div>
            </header>

            <div className="workflow-strip">
              {selectedTasks.map((task, index) => (
                <div className={`workflow-step ${task.status}`} key={task.taskId} title={task.taskSpec?.title}>
                  <span>{index + 1}</span>
                  <div><strong>{roleName[task.role ?? ''] ?? 'Agent'}</strong><small>{statusName[task.status] ?? task.status}</small></div>
                </div>
              ))}
            </div>

            <section className="message-stream" aria-label="任务群聊消息">
              <div className="chat-date">任务创建于 {formatDate(selectedConversation.createdAt)}</div>
              {selectedMessages.map((message) => <MessageBubble key={message.messageId} message={message} task={snapshot.tasks.find((task) => task.taskId === message.taskId)} agents={snapshot.agents} />)}
              {selectedMessages.length === 0 && <div className="empty-chat">Agent 的任务简报和成果附件会显示在这里。</div>}
              <div ref={chatEndRef} />
            </section>

            {selectedConversation.humanIntervention?.status === 'required' && (
              <form className="intervention-box" onSubmit={resolveHumanIntervention}>
                <div><strong>需要你的决定</strong><p>{selectedConversation.humanIntervention.question}</p></div>
                <input value={humanResponse} onChange={(event) => setHumanResponse(event.target.value)} placeholder="输入决定或补充信息" />
                <button type="submit">交给规划 Agent</button>
              </form>
            )}

            <form className="message-composer" onSubmit={submitMessage}>
              <input value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder="发送旁注，可用 @agent-id 提醒相关 Agent" />
              <button type="submit" disabled={!messageText.trim()}>发送</button>
              <small>群聊用于观察与沟通；任务状态仍由正式流程控制。</small>
            </form>
          </>
        ) : (
          <div className="no-conversation"><div>◎</div><h1>创建第一个协作任务</h1><p>规划、执行和审核 Agent 的简报会进入同一个群聊。</p><button onClick={() => setModalOpen(true)} type="button">新建任务</button></div>
        )}
      </main>

      <aside className="detail-sidebar">
        <section className="side-section">
          <div className="section-title"><h2>参与 Agent</h2><span>{participants.length}</span></div>
          <div className="participant-list">
            {participants.map((agent) => <Participant agent={agent} key={agent.agentId} />)}
            {participants.length === 0 && <p className="muted">尚未指派 Agent</p>}
          </div>
        </section>

        <section className="side-section usage-section">
          <div className="section-title"><h2>账号与额度</h2><span>本次 Hub {formatTokens(snapshot.usage.totals?.totalTokens ?? 0)} tokens</span></div>
          {accounts.map((account) => (
            <div className="account-card" key={account.key}>
              <div className="account-title"><div><strong>{account.label}</strong><small>{account.provider} · {account.plan}</small></div><QuotaBadge quota={account.quota} /></div>
              <div className="token-grid"><span>输入 <b>{formatTokens(account.usage.inputTokens)}</b></span><span>输出 <b>{formatTokens(account.usage.outputTokens)}</b></span><span>缓存 <b>{formatTokens(account.usage.cachedTokens)}</b></span><span>总计 <b>{formatTokens(account.usage.totalTokens)}</b></span></div>
              <div className="account-agents">Agent 本地累计 · {account.agents.length} 个 Agent · {account.devices.size} 台设备</div>
              <QuotaMeter quota={account.quota} />
            </div>
          ))}
          {accounts.length === 0 && <p className="muted">还没有账号统计</p>}
        </section>

        {lastError && <div className="connection-warning">当前显示{connectionMode === 'demo' ? '演示数据' : '最后一次同步结果'}：{lastError}</div>}
      </aside>

      {modalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setModalOpen(false)}>
          <form className="task-modal" onSubmit={submitWorkflow}>
            <div className="modal-header"><div><span>新群聊</span><h2>创建协作任务</h2></div><button type="button" onClick={() => setModalOpen(false)}>×</button></div>
            <label>任务名称<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：改进发布流程" /></label>
            <label>目标<textarea required rows={5} value={draft.objective} onChange={(event) => setDraft({ ...draft, objective: event.target.value })} placeholder="说明最终要解决的问题；规划 Agent 会负责拆分和指派。" /></label>
            <label>验收标准<textarea rows={3} value={draft.acceptance} onChange={(event) => setDraft({ ...draft, acceptance: event.target.value })} placeholder={'每行一项，例如：\n功能通过自动测试\n审核 Agent 确认无回归'} /></label>
            <div className="form-grid">
              <label>规划 Agent<select value={draft.plannerAgentId} onChange={(event) => setDraft({ ...draft, plannerAgentId: event.target.value })}><option value="">自动选择</option>{compatiblePlanners.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.agentId}</option>)}</select></label>
              <label>审核 Agent<select value={draft.reviewerAgentId} onChange={(event) => setDraft({ ...draft, reviewerAgentId: event.target.value })}><option value="">自动选择</option>{compatibleReviewers.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.agentId}</option>)}</select></label>
              <label>首轮规划模型<select value={draft.modelPreference} onChange={(event) => setDraft({ ...draft, modelPreference: event.target.value })}><option value="">自动选择</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
              <label>审核重试次数<input type="number" min="0" max="5" value={draft.maxReviewCycles} onChange={(event) => setDraft({ ...draft, maxReviewCycles: Number(event.target.value) })} /></label>
            </div>
            <p className="modal-note">自动选择会综合角色、能力、在线状态、设备负载和可用额度；模型不写死。</p>
            <div className="modal-actions"><button type="button" onClick={() => setModalOpen(false)}>取消</button><button className="primary" type="submit" disabled={submitting || !draft.objective.trim()}>{submitting ? '创建中…' : '创建任务群聊'}</button></div>
          </form>
        </div>
      )}

      {notice && <div className="toast">{notice}</div>}
    </div>
  )
}

function MessageBubble({ message, task, agents }: { message: HubMessage; task?: HubTask; agents: Agent[] }) {
  const agent = agents.find((item) => item.agentId === message.senderId)
  const isStatus = message.kind === 'status'
  if (isStatus) return <div className="system-message"><span>{message.text}</span><time>{formatTime(message.createdAt)}</time></div>
  return (
    <article className={`message ${message.senderRole}`}>
      {agent ? <AgentAvatar agent={agent} role={isAgentRole(message.senderRole) ? message.senderRole : undefined} /> : <div className={`avatar ${message.senderRole}`}>{message.senderRole === 'human' ? '你' : '系'}</div>}
      <div className="message-body">
        <header><strong>{agent?.agentId ?? message.senderId}</strong><span className={`role-tag ${message.senderRole}`}>{roleName[message.senderRole] ?? message.senderRole}</span><time>{formatTime(message.createdAt)}</time></header>
        <p>{message.text}</p>
        {message.mentions.length > 0 && <div className="mentions">{message.mentions.map((mention) => <span key={mention}>{mention.startsWith('@') ? mention : `@${mention}`}</span>)}</div>}
        {message.attachments.map((attachment, index) => (
          <details className="attachment" key={`${attachment.taskId ?? message.taskId}-${index}`}>
            <summary><span>▧</span><div><strong>{attachment.label}</strong><small>{attachment.version ?? '成果附件'} · 点击查看</small></div><i>⌄</i></summary>
            {attachment.content && <pre>{attachment.content}</pre>}
            {(attachment.artifacts?.files ?? []).map((file) => <div className="artifact-file" key={file.path}><span>{file.path}</span><small>{file.status} · {formatBytes(file.size)}</small></div>)}
          </details>
        ))}
        {['task_brief', 'review_decision'].includes(message.kind) && (task?.model || task?.usage) && <div className="message-metrics"><span>{task.model ?? task.execution?.model ?? '默认模型'}</span>{task.usage && <><span>输入 {formatTokens(task.usage.inputTokens)}</span><span>输出 {formatTokens(task.usage.outputTokens)}</span><b>共 {formatTokens(task.usage.totalTokens)} tokens</b></>}</div>}
      </div>
    </article>
  )
}

function AgentAvatar({ agent, role: roleOverride }: { agent: Agent; role?: AgentRole }) {
  const role = roleOverride ?? agent.roles?.[0] ?? 'executor'
  return <div className={`avatar ${role}`} title={agent.agentId}>{role === 'planner' ? '规' : role === 'reviewer' ? '审' : '执'}<i className={agent.status === 'online' ? 'online' : 'offline'} /></div>
}

function Participant({ agent }: { agent: Agent }) {
  return (
    <div className="participant">
      <AgentAvatar agent={agent} />
      <div><strong>{agent.agentId}</strong><small>{(agent.roles ?? []).map((role) => roleName[role]).join(' / ') || '通用 Agent'} · {agent.deviceId ?? agent.agentId}</small><em>{agent.models?.map((model) => model.label ?? model.id).filter(Boolean).join(' · ') || '默认模型'}</em></div>
      <span className={agent.busy ? 'busy' : ''}>{agent.status !== 'online' ? '离线' : agent.busy ? '忙碌' : '空闲'}</span>
    </div>
  )
}

function QuotaBadge({ quota }: { quota: QuotaSnapshot | null }) {
  const state = quota?.state ?? 'Unknown'
  return <span className={`quota-badge ${state.toLowerCase()}`}>{state === 'Healthy' ? '充足' : state === 'Low' ? '偏低' : state === 'Exhausted' ? '耗尽' : '未知'}</span>
}

function QuotaMeter({ quota }: { quota: QuotaSnapshot | null }) {
  const window = quota?.windows?.find((item) => item.usedPercent != null)
  if (!window || window.usedPercent == null) return <div className="quota-unknown">客户端暂无可读取的额度快照</div>
  return <div className="quota-meter"><div><span>{window.name}</span><b>已用 {Math.round(window.usedPercent)}%</b></div><progress max="100" value={window.usedPercent} /><small>{window.resetsAt ? `${formatDate(window.resetsAt)} 重置` : `来源：${quota?.source ?? 'client'}`}</small></div>
}

function acceptsRole(agent: Agent, role: AgentRole) {
  return agent.status === 'online' && !agent.paused && (!agent.roles?.length || agent.roles.includes(role))
}

function isAgentRole(value: string): value is AgentRole {
  return value === 'planner' || value === 'executor' || value === 'reviewer'
}

function groupAccountUsage(agents: Agent[]) {
  const empty = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, toolTokens: 0, totalTokens: 0 })
  const groups = new Map<string, { key: string; label: string; provider: string; plan: string; usage: TokenUsage; agents: Agent[]; devices: Set<string>; quota: QuotaSnapshot | null }>()
  for (const agent of agents) {
    const key = `${agent.account?.provider ?? 'unknown'}:${agent.account?.id ?? agent.agentId}`
    const group = groups.get(key) ?? {
      key,
      label: agent.account?.label ?? agent.account?.id ?? '未标记账号',
      provider: agent.account?.provider ?? '未知服务',
      plan: agent.account?.plan ?? '未知套餐',
      usage: empty(),
      agents: [],
      devices: new Set<string>(),
      quota: agent.quotaSnapshot ?? null,
    }
    group.agents.push(agent)
    group.devices.add(agent.deviceId ?? agent.agentId)
    for (const field of Object.keys(group.usage) as Array<keyof TokenUsage>) group.usage[field] += agent.usageTotals?.[field] ?? 0
    const candidate = agent.quotaSnapshot
    if (candidate && (!group.quota || Date.parse(candidate.checkedAt) > Date.parse(group.quota.checkedAt))) group.quota = candidate
    groups.set(key, group)
  }
  return [...groups.values()]
}

function extractMentions(text: string) {
  return [...new Set(text.match(/@[\w.-]+/g) ?? [])]
}

function formatTokens(value: number) {
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}时`
  return `${Math.floor(minutes / 1440)}天`
}

function formatBytes(value: number) {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
}

export default App
