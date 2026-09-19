import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import AdminPanel from './AdminPanel'
import { createDemoSnapshot } from './demo-data'
import {
  clearLocalSession,
  createWorkflow,
  downloadArtifact,
  getConversationDetail,
  getCurrentUser,
  getHubOverview,
  getMessageDetail,
  HubApiError,
  login as loginToHub,
  logout as logoutFromHub,
  resolveIntervention as resolveHubIntervention,
  sendConversationMessage,
  sendHubCommand,
  setLanAccessToken,
} from './hub-api'
import { failedConnectionMode, nextPollDelay, NORMAL_POLL_MS, permitsServerMutation } from './sync-policy.js'
import type {
  Agent,
  AgentRole,
  ConnectionMode,
  ConversationDetail,
  CreateWorkflowRequest,
  HubMessage,
  HubOverview,
  HubSnapshot,
  HubTask,
  HumanIntervention,
  QuotaSnapshot,
  QuotaWindow,
  TokenUsage,
  WebUser,
} from './types'

interface WorkflowDraft {
  title: string
  objective: string
  acceptance: string
  plannerAgentId: string
  executorAgentId: string
  reviewerAgentId: string
  modelPreference: string
  reasoningEffort: string
  maxReviewCycles: number
}

type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated'
type MainView = 'conversation' | 'admin'

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
  processing_result: '处理结果',
  awaiting_approval: '待批准',
  rejected: '已拒绝',
  cancelled: '已取消',
}

const connectionName: Record<ConnectionMode, string> = {
  loading: '正在加载',
  live: 'Hub 已连接',
  reconnecting: '正在重连',
  offline: 'Hub 离线',
  demo: '只读演示',
}

const activeTaskStatuses = new Set(['queued', 'awaiting_approval', 'dispatched', 'running', 'processing_result'])
const demoEnabled = import.meta.env.VITE_DEMO_MODE === 'true'
const lanMode = import.meta.env.VITE_LAN_MODE === 'true'

function emptyDraft(): WorkflowDraft {
  return {
    title: '',
    objective: '',
    acceptance: '',
    plannerAgentId: '',
    executorAgentId: '',
    reviewerAgentId: '',
    modelPreference: '',
    reasoningEffort: '',
    maxReviewCycles: 2,
  }
}

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking')
  const [currentUser, setCurrentUser] = useState<WebUser | null>(null)
  const [overview, setOverview] = useState<HubOverview | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('loading')
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null)
  const [selectedInterventionId, setSelectedInterventionId] = useState<string | null>(null)
  const [mainView, setMainView] = useState<MainView>('conversation')
  const [modalOpen, setModalOpen] = useState(false)
  const [draft, setDraft] = useState<WorkflowDraft>(() => emptyDraft())
  const [messageText, setMessageText] = useState('')
  const [humanResponse, setHumanResponse] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [workingAction, setWorkingAction] = useState('')
  const [notice, setNotice] = useState('')
  const [lastError, setLastError] = useState('')
  const [loginName, setLoginName] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [lanTokenInput, setLanTokenInput] = useState('')
  const [loginRetrySeconds, setLoginRetrySeconds] = useState(0)
  const [authCheckRevision, setAuthCheckRevision] = useState(0)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const [demoActive, setDemoActive] = useState(false)
  const [messageDetails, setMessageDetails] = useState<Record<string, HubMessage>>({})
  const [loadingMessageIds, setLoadingMessageIds] = useState<Set<string>>(() => new Set())
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const pollAbortRef = useRef<AbortController | null>(null)
  const overviewRef = useRef<HubOverview | null>(null)
  const demoSnapshotRef = useRef<HubSnapshot | null>(null)
  const currentUserId = currentUser?.id ?? null
  const canWrite = permitsServerMutation(connectionMode) && !demoActive

  const handleUnauthorized = useCallback(() => {
    pollAbortRef.current?.abort()
    pollAbortRef.current = null
    clearLocalSession()
    if (lanMode) setLanAccessToken('')
    overviewRef.current = null
    setCurrentUser(null)
    setAuthStatus('unauthenticated')
    setOverview(null)
    setDetail(null)
    setSelectedRootId(null)
    setMainView('conversation')
    setConnectionMode('offline')
    setLastSuccessfulAt(null)
    setMessageDetails({})
    setLastError('登录已失效，请重新登录。')
  }, [])

  useEffect(() => {
    overviewRef.current = overview
  }, [overview])

  useEffect(() => {
    if (demoActive) return
    const controller = new AbortController()
    void getCurrentUser(controller.signal).then((user) => {
      setCurrentUser(user)
      setAuthStatus('authenticated')
      setLastError('')
    }).catch((error: unknown) => {
      if (isAbortError(error)) return
      if (error instanceof HubApiError && error.status === 401) {
        clearLocalSession()
        setLastError('')
      } else {
        setLastError(formatApiError(error, '无法连接 Server Hub'))
      }
      setCurrentUser(null)
      setAuthStatus('unauthenticated')
      setConnectionMode('offline')
    })
    return () => controller.abort()
  }, [authCheckRevision, demoActive])

  useEffect(() => {
    if (authStatus !== 'authenticated' || !currentUserId || demoActive) return
    let disposed = false
    let timerId: number | null = null
    let consecutiveFailures = 0

    const clearTimer = () => {
      if (timerId != null) window.clearTimeout(timerId)
      timerId = null
    }
    const schedule = (delay: number) => {
      clearTimer()
      if (!disposed) timerId = window.setTimeout(() => void refresh(), delay)
    }
    const refresh = async () => {
      if (disposed || document.hidden || pollAbortRef.current) return
      const controller = new AbortController()
      pollAbortRef.current = controller
      setSyncing(true)
      try {
        const [nextOverview, nextDetail] = await Promise.all([
          getHubOverview(controller.signal),
          selectedRootId ? getConversationDetail(selectedRootId, controller.signal) : Promise.resolve(null),
        ])
        if (disposed || controller.signal.aborted) return
        overviewRef.current = nextOverview
        setOverview(nextOverview)
        setDetail(nextDetail)
        const nextRootId = selectedRootId && nextOverview.conversations.some((item) => item.rootTaskId === selectedRootId)
          ? selectedRootId
          : nextOverview.conversations[0]?.rootTaskId ?? null
        if (nextRootId !== selectedRootId) setSelectedRootId(nextRootId)
        setConnectionMode('live')
        setLastSuccessfulAt(new Date().toISOString())
        setLastError('')
        consecutiveFailures = 0
        schedule(NORMAL_POLL_MS)
      } catch (error) {
        if (disposed || isAbortError(error)) return
        if (error instanceof HubApiError && error.status === 401) {
          handleUnauthorized()
          return
        }
        consecutiveFailures += 1
        setConnectionMode(failedConnectionMode({
          hasSnapshot: Boolean(overviewRef.current),
          consecutiveFailures,
          browserOnline: navigator.onLine,
        }))
        setLastError(formatApiError(error, 'Hub 暂时不可用'))
        schedule(nextPollDelay(consecutiveFailures))
      } finally {
        if (pollAbortRef.current === controller) {
          pollAbortRef.current = null
          setSyncing(false)
        }
      }
    }
    const interrupt = () => {
      clearTimer()
      const active = pollAbortRef.current
      pollAbortRef.current = null
      active?.abort()
      setSyncing(false)
    }
    const onVisibilityChange = () => {
      interrupt()
      if (!document.hidden) void refresh()
    }
    const onOffline = () => {
      interrupt()
      setConnectionMode('offline')
      setLastError('浏览器已离线，修改操作已禁用。')
    }
    const onOnline = () => {
      interrupt()
      setConnectionMode(overviewRef.current ? 'reconnecting' : 'loading')
      void refresh()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    void refresh()
    return () => {
      disposed = true
      interrupt()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [authStatus, currentUserId, demoActive, selectedRootId, refreshRevision, handleUnauthorized])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (loginRetrySeconds <= 0) return
    const timer = window.setInterval(() => setLoginRetrySeconds((value) => Math.max(0, value - 1)), 1_000)
    return () => window.clearInterval(timer)
  }, [loginRetrySeconds])

  const conversations = useMemo(
    () => [...(overview?.conversations ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [overview?.conversations],
  )

  useEffect(() => {
    if (!demoActive || !selectedRootId || !demoSnapshotRef.current) return
    setDetail(detailFromSnapshot(demoSnapshotRef.current, selectedRootId))
  }, [demoActive, selectedRootId])

  const selectedConversation = conversations.find((item) => item.rootTaskId === selectedRootId) ?? conversations[0] ?? null
  const selectedTasks = useMemo(
    () => detail && selectedConversation && detail.rootTaskId === selectedConversation.rootTaskId
      ? [...detail.tasks].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      : [],
    [detail, selectedConversation],
  )
  const selectedMessages = useMemo(
    () => detail && selectedConversation && detail.rootTaskId === selectedConversation.rootTaskId
      ? detail.messages.map((message) => messageDetails[message.messageId] ?? message).sort((a, b) => a.seq - b.seq)
      : [],
    [detail, messageDetails, selectedConversation],
  )
  const pendingInterventions = useMemo(
    () => detail && selectedConversation && detail.rootTaskId === selectedConversation.rootTaskId
      ? detail.interventions.filter((item) => ['pending', 'required'].includes(item.status))
      : [],
    [detail, selectedConversation],
  )

  const selectedIntervention = pendingInterventions.find((item) => interventionKey(item) === selectedInterventionId) ?? pendingInterventions[0] ?? null
  const participants = useMemo(
    () => (selectedConversation?.participants ?? []).map((id) => overview?.agents.find((agent) => agent.agentId === id)).filter((agent): agent is Agent => Boolean(agent)),
    [selectedConversation?.participants, overview?.agents],
  )
  const accounts = useMemo(() => groupAccountUsage(overview?.agents ?? []), [overview?.agents])
  const compatiblePlanners = (overview?.agents ?? []).filter((agent) => acceptsRole(agent, 'planner'))
  const compatibleExecutors = (overview?.agents ?? []).filter(isEligibleExecutor)
  const allExecutors = (overview?.agents ?? []).filter((agent) => agent.roles?.includes('executor'))
  const compatibleReviewers = (overview?.agents ?? []).filter((agent) => acceptsRole(agent, 'reviewer'))
  const models = [...new Set(compatiblePlanners.flatMap((agent) => agent.models ?? []).filter((model) => model.enabled !== false && model.id).map((model) => model.id as string))]

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [selectedMessages.length, selectedConversation?.rootTaskId])

  function requestRefresh() {
    setRefreshRevision((value) => value + 1)
  }

  function requireLive() {
    if (canWrite) return true
    setNotice('Hub 非实时状态，修改操作已禁用。')
    return false
  }

  async function submitWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!requireLive() || !draft.objective.trim()) return
    if (draft.executorAgentId && !compatibleExecutors.some((agent) => agent.agentId === draft.executorAgentId)) {
      setNotice('所选执行 Agent 已离线、暂停或角色不匹配，请重新选择。')
      return
    }
    const request: CreateWorkflowRequest = {
      title: draft.title.trim() || draft.objective.trim().slice(0, 40),
      objective: draft.objective.trim(),
      acceptance: draft.acceptance.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      plannerAgentId: draft.plannerAgentId || null,
      executorAgentId: draft.executorAgentId || null,
      reviewerAgentId: draft.reviewerAgentId || null,
      modelPreference: draft.modelPreference || null,
      reasoningEffort: draft.reasoningEffort || null,
      maxReviewCycles: Math.min(5, Math.max(0, Number.isFinite(draft.maxReviewCycles) ? draft.maxReviewCycles : 2)),
    }
    setSubmitting(true)
    try {
      const result = await createWorkflow(request)
      setSelectedRootId(result.task.rootTaskId ?? result.task.taskId)
      setDraft(emptyDraft())
      setModalOpen(false)
      setNotice('协作任务已创建')
      requestRefresh()
    } catch (error) {
      if (error instanceof HubApiError && error.status === 401) handleUnauthorized()
      else setNotice(formatApiError(error, '任务创建失败'))
    } finally {
      setSubmitting(false)
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = messageText.trim()
    if (!requireLive() || !selectedConversation || !text) return
    setSubmitting(true)
    try {
      await sendConversationMessage(selectedConversation.rootTaskId, text, extractMentions(text))
      setMessageText('')
      requestRefresh()
    } catch (error) {
      if (error instanceof HubApiError && error.status === 401) handleUnauthorized()
      else setNotice(formatApiError(error, '消息发送失败'))
    } finally {
      setSubmitting(false)
    }
  }

  async function submitHumanResponse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await decideIntervention('respond')
  }

  async function decideIntervention(decision: 'approve' | 'reject' | 'respond') {
    if (!requireLive() || !selectedConversation || !selectedIntervention) return
    if (decision === 'respond' && !humanResponse.trim()) return
    if (decision !== 'respond' && currentUser?.role !== 'admin') {
      setNotice('批准和拒绝需要管理员权限。')
      return
    }
    setSubmitting(true)
    try {
      if (selectedIntervention.interventionId) {
        await resolveHubIntervention(selectedIntervention.interventionId, decision, humanResponse.trim())
      } else if (decision === 'respond') {
        await sendHubCommand({ type: 'workflow.human_response', rootTaskId: selectedConversation.rootTaskId, response: humanResponse.trim() })
      }
      setDetail((current) => current ? {
        ...current,
        interventions: current.interventions.filter((item) => interventionKey(item) !== interventionKey(selectedIntervention)),
      } : current)
      setHumanResponse('')
      setNotice(decision === 'approve' ? '请求已批准' : decision === 'reject' ? '请求已拒绝' : '人工回复已从原节点继续')
      requestRefresh()
    } catch (error) {
      if (error instanceof HubApiError && error.status === 401) handleUnauthorized()
      else setNotice(formatApiError(error, '提交失败'))
    } finally {
      setSubmitting(false)
    }
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (loginRetrySeconds > 0) return
    setSubmitting(true)
    setLastError('')
    try {
      const user = await loginToHub(loginName, loginPassword)
      setLoginPassword('')
      setCurrentUser(user)
      setAuthStatus('authenticated')
      setConnectionMode('loading')
    } catch (error) {
      setLastError(formatApiError(error, '登录失败'))
      if (error instanceof HubApiError && error.retryAfterMs) setLoginRetrySeconds(Math.max(1, Math.ceil(error.retryAfterMs / 1_000)))
    } finally {
      setLoginPassword('')
      setSubmitting(false)
    }
  }

  function submitLanPairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!lanTokenInput.trim()) return
    setLanAccessToken(lanTokenInput)
    setLanTokenInput('')
    setLastError('')
    setAuthStatus('checking')
    setConnectionMode('loading')
    setAuthCheckRevision((value) => value + 1)
  }

  async function submitLogout() {
    if (!requireLive()) return
    setWorkingAction('logout')
    try {
      await logoutFromHub()
      resetToLogin('')
    } catch (error) {
      if (error instanceof HubApiError && error.status === 401) resetToLogin('登录已失效，请重新登录。')
      else setNotice(formatApiError(error, '退出失败'))
    } finally {
      setWorkingAction('')
    }
  }

  function resetToLogin(message: string) {
    pollAbortRef.current?.abort()
    pollAbortRef.current = null
    clearLocalSession()
    overviewRef.current = null
    setCurrentUser(null)
    setAuthStatus('unauthenticated')
    setOverview(null)
    setDetail(null)
    setSelectedRootId(null)
    setMainView('conversation')
    setConnectionMode('offline')
    setLastSuccessfulAt(null)
    setMessageDetails({})
    setLastError(message)
  }

  function enterDemo() {
    const snapshot = createDemoSnapshot()
    const nextOverview = overviewFromSnapshot(snapshot)
    const rootTaskId = nextOverview.conversations[0]?.rootTaskId ?? null
    demoSnapshotRef.current = snapshot
    overviewRef.current = nextOverview
    setOverview(nextOverview)
    setSelectedRootId(rootTaskId)
    setDetail(rootTaskId ? detailFromSnapshot(snapshot, rootTaskId) : null)
    setCurrentUser({ id: 'demo-user', username: 'demo', role: 'operator', status: 'active' })
    setAuthStatus('authenticated')
    setDemoActive(true)
    setConnectionMode('demo')
    setLastSuccessfulAt(null)
    setLastError('演示数据为本地只读样例，不代表真实 Hub 状态。')
  }

  function exitDemo() {
    demoSnapshotRef.current = null
    overviewRef.current = null
    setDemoActive(false)
    setCurrentUser(null)
    setAuthStatus('unauthenticated')
    setOverview(null)
    setDetail(null)
    setSelectedRootId(null)
    setConnectionMode('offline')
    setLastError('')
  }

  async function cancelTask(task: HubTask) {
    if (!requireLive() || currentUser?.role !== 'admin' || !activeTaskStatuses.has(task.status)) return
    if (!window.confirm(`取消“${task.taskSpec?.title ?? task.input.slice(0, 60)}”？`)) return
    setWorkingAction(`task:${task.taskId}`)
    try {
      const result = await sendHubCommand({ type: 'task.cancel', taskId: task.taskId })
      setDetail((current) => current && result.task ? {
        ...current,
        tasks: current.tasks.map((item) => item.taskId === result.task?.taskId ? result.task : item),
      } : current)
      setNotice('任务已取消')
      requestRefresh()
    } catch (error) {
      if (error instanceof HubApiError && error.status === 401) handleUnauthorized()
      else setNotice(formatApiError(error, '任务取消失败'))
    } finally {
      setWorkingAction('')
    }
  }

  async function toggleAgent(agent: Agent) {
    if (!requireLive() || currentUser?.role !== 'admin') return
    const type = agent.paused ? 'agent.resume' : 'agent.pause'
    setWorkingAction(`agent:${agent.agentId}`)
    try {
      const result = await sendHubCommand({ type, targetAgentId: agent.agentId })
      setOverview((current) => current ? {
        ...current,
        agents: current.agents.map((item) => item.agentId === agent.agentId ? (result.agent ?? { ...item, paused: !agent.paused }) : item),
      } : current)
      setNotice(agent.paused ? 'Agent 已恢复' : 'Agent 已暂停')
      requestRefresh()
    } catch (error) {
      if (error instanceof HubApiError && error.status === 401) handleUnauthorized()
      else setNotice(formatApiError(error, 'Agent 状态更新失败'))
    } finally {
      setWorkingAction('')
    }
  }

  async function loadFullMessage(message: HubMessage) {
    if (message.attachments.every((attachment) => attachment.type !== 'full_result' || attachment.content !== undefined)) return
    if (connectionMode !== 'live' || loadingMessageIds.has(message.messageId)) {
      if (connectionMode !== 'live') setNotice('恢复实时连接后才能加载完整成果。')
      return
    }
    setLoadingMessageIds((current) => new Set(current).add(message.messageId))
    try {
      const full = await getMessageDetail(message.messageId)
      setMessageDetails((current) => ({ ...current, [message.messageId]: full }))
    } catch (error) {
      if (error instanceof HubApiError && error.status === 401) handleUnauthorized()
      else setNotice(formatApiError(error, '完整成果加载失败'))
    } finally {
      setLoadingMessageIds((current) => {
        const next = new Set(current)
        next.delete(message.messageId)
        return next
      })
    }
  }

  if (authStatus === 'checking') return <LoadingGate label={lanMode ? '正在连接局域网 Hub' : '正在检查登录会话'} />

  if (authStatus === 'unauthenticated') {
    if (lanMode) {
      return (
        <main className="login-shell">
          <form className="login-card" onSubmit={submitLanPairing}>
            <div className="brand-mark">A4</div>
            <div><span>LAN package mode</span><h1>连接私人局域网</h1><p>输入协调设备启动时显示的配对令牌。令牌只保存在当前浏览器会话中。</p></div>
            <label>配对令牌<input autoComplete="off" autoFocus type="password" value={lanTokenInput} onChange={(event) => setLanTokenInput(event.target.value)} /></label>
            {lastError && <div className="login-error">{lastError}</div>}
            <button type="submit" disabled={!lanTokenInput.trim()}>连接</button>
          </form>
        </main>
      )
    }
    return (
      <main className="login-shell">
        <form className="login-card" onSubmit={submitLogin}>
          <div className="brand-mark">A4</div>
          <div><span>Server Hub</span><h1>登录 A446 协作台</h1><p>使用管理员或操作者账号继续。登录前不会轮询业务接口。</p></div>
          <label>用户名<input autoComplete="username" autoFocus value={loginName} onChange={(event) => setLoginName(event.target.value)} /></label>
          <label>密码<input autoComplete="current-password" type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} /></label>
          {lastError && <div className="login-error">{lastError}</div>}
          <button type="submit" disabled={submitting || loginRetrySeconds > 0 || !loginName || !loginPassword}>{submitting ? '登录中…' : loginRetrySeconds > 0 ? `${loginRetrySeconds} 秒后重试` : '登录'}</button>
          <button className="login-secondary" type="button" disabled={submitting} onClick={() => { setAuthStatus('checking'); setConnectionMode('loading'); setAuthCheckRevision((value) => value + 1) }}>重新检查连接</button>
          {demoEnabled && <button className="login-demo" type="button" onClick={enterDemo}>进入只读演示</button>}
        </form>
      </main>
    )
  }

  if (!overview && connectionMode === 'loading') return <LoadingGate label="正在加载真实 Hub 数据" user={currentUser} />

  if (!overview) {
    return (
      <main className="offline-gate">
        <div className="brand-mark">A4</div>
        <span>Connection unavailable</span>
        <h1>Hub 当前离线</h1>
        <p>{lastError || '尚未取得任何可显示的实时数据。'}</p>
        <div><button type="button" onClick={requestRefresh}>立即重试</button>{demoEnabled && <button type="button" onClick={enterDemo}>只读演示</button>}</div>
      </main>
    )
  }

  return (
    <div className={`app-shell ${mainView === 'admin' ? 'admin-mode' : ''}`}>
      <aside className="room-sidebar">
        <div className="brand-row">
          <div className="brand-mark">A4</div>
          <div><strong>A446 协作台</strong><span>Agent 群聊</span></div>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          <button className={mainView === 'conversation' ? 'selected' : ''} type="button" onClick={() => setMainView('conversation')}>协作任务</button>
          {currentUser?.role === 'admin' && !demoActive && !lanMode && <button className={mainView === 'admin' ? 'selected' : ''} type="button" onClick={() => setMainView('admin')}>系统管理</button>}
        </nav>

        <button className="new-task" type="button" disabled={!canWrite} onClick={() => setModalOpen(true)}>＋ 新建协作任务</button>

        <div className="room-heading"><span>任务群聊</span><b>{conversations.length}</b></div>
        <div className="room-list">
          {conversations.map((conversation) => (
            <button
              className={`room-item ${selectedConversation?.rootTaskId === conversation.rootTaskId ? 'selected' : ''}`}
              key={conversation.rootTaskId}
              type="button"
              onClick={() => { setSelectedRootId(conversation.rootTaskId); setMainView('conversation') }}
            >
              <i className={`room-status ${conversation.status}`} />
              <span><strong>{conversation.title}</strong><small>{statusName[conversation.status] ?? conversation.status} · {conversation.messageCount} 条消息</small></span>
              <time>{relativeTime(conversation.updatedAt)}</time>
            </button>
          ))}
          {conversations.length === 0 && <div className="empty-list">还没有任务群聊</div>}
        </div>

        <div className="hub-state">
          <i className={`connection-dot ${connectionMode}`} />
          <span><strong>{connectionName[connectionMode]}</strong><small>{syncing ? '正在同步' : `${overview.agents.filter((agent) => agent.status === 'online').length} 个 Agent 在线`}</small>{lastSuccessfulAt && connectionMode !== 'demo' && <small>最近成功 {formatTime(lastSuccessfulAt)}</small>}</span>
          {connectionMode !== 'demo' && <button type="button" title="立即同步" disabled={syncing} onClick={requestRefresh}>↻</button>}
        </div>

        <div className="identity-card">
          <div><strong>{lanMode ? '局域网控制端' : currentUser?.username ?? 'unknown'}</strong><small>{lanMode ? '私人 LAN · 共享配对令牌' : currentUser?.role === 'admin' ? '管理员' : '操作者'}</small></div>
          {demoActive ? <button type="button" onClick={exitDemo}>退出演示</button> : !lanMode && <button type="button" disabled={!canWrite || workingAction === 'logout'} onClick={() => void submitLogout()}>退出</button>}
        </div>
      </aside>

      {mainView === 'admin' && currentUser?.role === 'admin' && !lanMode ? (
        <AdminPanel connectionMode={connectionMode} onNotice={setNotice} onUnauthorized={handleUnauthorized} />
      ) : (
        <>
          <main className="conversation-panel">
            {connectionMode !== 'live' && (
              <div className={`sync-banner ${connectionMode}`}>
                <strong>{connectionName[connectionMode]}</strong>
                <span>{connectionMode === 'demo' ? '当前内容是本地只读样例。' : `页面保留最近一次成功数据${lastSuccessfulAt ? `（${formatDate(lastSuccessfulAt)}）` : ''}，修改操作已禁用。`}</span>
              </div>
            )}
            {selectedConversation ? (
              <>
                <header className="conversation-header">
                  <div>
                    <span className={`status-pill ${selectedConversation.status}`}>{statusName[selectedConversation.status] ?? selectedConversation.status}</span>
                    <h1>{selectedConversation.title}</h1>
                    <p>一个任务对应一个群聊 · {selectedConversation.taskCount} 个内部步骤</p>
                  </div>
                  <div className="avatar-stack" aria-label="参与者">{participants.slice(0, 5).map((agent) => <AgentAvatar agent={agent} key={agent.agentId} />)}</div>
                </header>

                <div className="workflow-strip">
                  {selectedTasks.map((task, index) => (
                    <div className={`workflow-step ${task.status} ${task.schedulingError ? 'has-error' : ''}`} key={task.taskId} title={task.taskSpec?.title}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{roleName[task.role ?? ''] ?? 'Agent'}</strong>
                        <small>{statusName[task.status] ?? task.status}</small>
                        {(task.targetAgentId || task.requestedAgentId) && <em>{task.targetAgentId ? `实际：${task.targetAgentId}` : `等待：${task.requestedAgentId}`}</em>}
                        {task.schedulingError && <mark title={task.schedulingErrorCode ?? undefined}>{task.schedulingError}</mark>}
                      </div>
                      {currentUser?.role === 'admin' && activeTaskStatuses.has(task.status) && <button type="button" disabled={!canWrite || Boolean(workingAction)} onClick={() => void cancelTask(task)}>取消</button>}
                    </div>
                  ))}
                  {detail?.rootTaskId !== selectedConversation.rootTaskId && <div className="workflow-loading">正在加载当前会话摘要…</div>}
                </div>

                <section className="message-stream" aria-label="任务群聊消息">
                  <div className="chat-date">任务创建于 {formatDate(selectedConversation.createdAt)}</div>
                  {selectedMessages.map((message) => (
                    <MessageBubble
                      key={message.messageId}
                      message={message}
                      task={selectedTasks.find((task) => task.taskId === message.taskId)}
                      agents={overview.agents}
                      loadingFullResult={loadingMessageIds.has(message.messageId)}
                      onLoadFullResult={() => void loadFullMessage(message)}
                    />
                  ))}
                  {detail?.rootTaskId === selectedConversation.rootTaskId && selectedMessages.length === 0 && <div className="empty-chat">Agent 的任务简报和成果附件会显示在这里。</div>}
                  <div ref={chatEndRef} />
                </section>

                {selectedIntervention && (
                  <form className="intervention-box" onSubmit={submitHumanResponse}>
                    <div>
                      <strong>需要你的决定 <b>{pendingInterventions.length > 1 ? `${pendingInterventions.indexOf(selectedIntervention) + 1}/${pendingInterventions.length}` : ''}</b></strong>
                      <p>{selectedIntervention.question}</p>
                      <small>{selectedIntervention.requesterRole ? `${roleName[selectedIntervention.requesterRole] ?? selectedIntervention.requesterRole} · ${selectedIntervention.requesterStage ?? '等待恢复'}` : '持久人工介入'}</small>
                    </div>
                    <div className="intervention-inputs">
                      {pendingInterventions.length > 1 && <select aria-label="待处理人工介入" value={interventionKey(selectedIntervention)} onChange={(event) => { setSelectedInterventionId(event.target.value); setHumanResponse('') }}>{pendingInterventions.map((item, index) => <option key={interventionKey(item)} value={interventionKey(item)}>{index + 1}. {item.question.slice(0, 48)}</option>)}</select>}
                      <input value={humanResponse} onChange={(event) => setHumanResponse(event.target.value)} placeholder={selectedIntervention.allowedActions?.includes('respond') ? '输入决定或补充信息' : '可选：说明批准或拒绝原因'} />
                    </div>
                    <div className="intervention-actions">
                      {currentUser?.role === 'admin' && selectedIntervention.allowedActions?.includes('approve') && <button type="button" disabled={!canWrite || submitting} onClick={() => void decideIntervention('approve')}>批准</button>}
                      {currentUser?.role === 'admin' && selectedIntervention.allowedActions?.includes('reject') && <button className="reject" type="button" disabled={!canWrite || submitting} onClick={() => void decideIntervention('reject')}>拒绝</button>}
                      {(selectedIntervention.allowedActions?.includes('respond') ?? true) && <button type="submit" disabled={!canWrite || submitting || !humanResponse.trim()}>提交回复</button>}
                    </div>
                  </form>
                )}

                <form className="message-composer" onSubmit={submitMessage}>
                  <input disabled={!canWrite} value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder={canWrite ? '发送旁注，可用 @agent-id 提醒相关 Agent' : '恢复实时连接后可发送旁注'} />
                  <button type="submit" disabled={!canWrite || submitting || !messageText.trim()}>发送</button>
                  <small>群聊用于观察与沟通；任务状态仍由正式流程控制。</small>
                </form>
              </>
            ) : (
              <div className="no-conversation"><div>◎</div><h1>创建第一个协作任务</h1><p>规划、执行和审核 Agent 的简报会进入同一个群聊。</p><button disabled={!canWrite} onClick={() => setModalOpen(true)} type="button">新建任务</button></div>
            )}
          </main>

          <aside className="detail-sidebar">
            <section className="side-section">
              <div className="section-title"><h2>参与 Agent</h2><span>{participants.length}</span></div>
              <div className="participant-list">{participants.map((agent) => <Participant agent={agent} key={agent.agentId} />)}{participants.length === 0 && <p className="muted">尚未指派 Agent</p>}</div>
            </section>

            {currentUser?.role === 'admin' && (
              <section className="side-section">
                <div className="section-title"><h2>Agent 运维</h2><span>服务端强制管理员权限</span></div>
                <div className="agent-operations">
                  {overview.agents.map((agent) => <AgentOperation key={agent.agentId} agent={agent} disabled={!canWrite || Boolean(workingAction)} onToggle={() => void toggleAgent(agent)} />)}
                </div>
              </section>
            )}

            <section className="side-section usage-section">
              <div className="section-title"><h2>账号与额度</h2><span>本次 Hub {formatTokens(overview.usage.totals?.totalTokens ?? 0)} tokens</span></div>
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

            {lastError && <div className="connection-warning">{connectionMode === 'demo' ? lastError : `最近同步失败：${lastError}`}</div>}
          </aside>
        </>
      )}

      {modalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setModalOpen(false)}>
          <form className="task-modal" role="dialog" aria-modal="true" aria-labelledby="create-workflow-title" onSubmit={submitWorkflow}>
            <div className="modal-header"><div><span>新群聊</span><h2 id="create-workflow-title">创建协作任务</h2></div><button type="button" onClick={() => setModalOpen(false)}>×</button></div>
            <label>任务名称<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：改进发布流程" /></label>
            <label>目标<textarea required rows={5} value={draft.objective} onChange={(event) => setDraft({ ...draft, objective: event.target.value })} placeholder="说明最终要解决的问题；规划 Agent 会负责拆分和指派。" /></label>
            <label>验收标准<textarea rows={3} value={draft.acceptance} onChange={(event) => setDraft({ ...draft, acceptance: event.target.value })} placeholder={'每行一项，例如：\n功能通过自动测试\n审核 Agent 确认无回归'} /></label>
            <div className="form-grid">
              <label>规划 Agent<select value={draft.plannerAgentId} onChange={(event) => setDraft({ ...draft, plannerAgentId: event.target.value })}><option value="">自动选择</option>{compatiblePlanners.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.agentId}</option>)}</select></label>
              <label>执行 Agent<select value={draft.executorAgentId} onChange={(event) => setDraft({ ...draft, executorAgentId: event.target.value })}><option value="">自动调度</option>{compatibleExecutors.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.agentId} · {executorStatus(agent)}</option>)}</select></label>
              <label>审核 Agent<select value={draft.reviewerAgentId} onChange={(event) => setDraft({ ...draft, reviewerAgentId: event.target.value })}><option value="">自动选择</option>{compatibleReviewers.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.agentId}</option>)}</select></label>
              <label>首轮规划模型<select value={draft.modelPreference} onChange={(event) => setDraft({ ...draft, modelPreference: event.target.value })}><option value="">自动选择</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
              <label>推理强度<select value={draft.reasoningEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })}><option value="">使用 Agent 默认值</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label>
              <label>审核重试次数<input type="number" min="0" max="5" value={draft.maxReviewCycles} onChange={(event) => setDraft({ ...draft, maxReviewCycles: Number(event.target.value) })} /></label>
            </div>
            <div className="executor-candidates">
              <strong>Executor 候选状态</strong>
              {allExecutors.length > 0 ? allExecutors.map((agent) => <span className={isEligibleExecutor(agent) ? 'eligible' : 'unavailable'} key={agent.agentId}><b>{agent.agentId}</b>{executorStatus(agent)}</span>) : <span className="unavailable">当前没有声明 executor 角色的 Agent</span>}
            </div>
            <p className="modal-note">自动调度会综合角色、在线状态、负载和可信额度。显式选择是服务端硬约束，多个执行任务可能受该 Agent 并发上限影响而串行排队；提交时前端与 Hub 会再次校验。</p>
            <div className="modal-actions"><button type="button" onClick={() => setModalOpen(false)}>取消</button><button className="primary" type="submit" disabled={!canWrite || submitting || !draft.objective.trim()}>{submitting ? '创建中…' : '创建任务群聊'}</button></div>
          </form>
        </div>
      )}

      {notice && <div className="toast" role="status" aria-live="polite">{notice}</div>}
    </div>
  )
}

function LoadingGate({ label, user }: { label: string; user?: WebUser | null }) {
  return <main className="loading-gate"><div className="brand-mark">A4</div><div className="loading-spinner" /><h1>{label}</h1><p>{user ? `${user.username} · ${user.role}` : '不会显示演示数据或过期业务内容'}</p></main>
}

function MessageBubble({ message, task, agents, loadingFullResult, onLoadFullResult }: { message: HubMessage; task?: HubTask; agents: Agent[]; loadingFullResult: boolean; onLoadFullResult: () => void }) {
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
          <details className="attachment" key={`${attachment.taskId ?? message.taskId}-${index}`} onToggle={(event) => event.currentTarget.open && attachment.type === 'full_result' && attachment.content === undefined && onLoadFullResult()}>
            <summary><span>▧</span><div><strong>{attachment.label}</strong><small>{attachment.version ?? '成果附件'} · 点击按需加载</small></div><i>⌄</i></summary>
            {loadingFullResult && attachment.type === 'full_result' && attachment.content === undefined && <div className="attachment-loading">正在加载完整成果…</div>}
            {attachment.content !== undefined && <pre>{attachment.content}</pre>}
            {(attachment.artifacts?.files ?? []).map((file) => <div className="artifact-file" key={file.path}>{file.status === 'ready' && file.downloadUrl ? <button type="button" onClick={() => void downloadArtifact(file.downloadUrl!, file.path).catch((error) => window.alert(error instanceof Error ? error.message : '成果下载失败'))}>{file.path}</button> : <span>{file.path}</span>}<small>{file.status} · {formatBytes(file.size)}</small></div>)}
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
  const resource = agent.resourceSnapshot
  const cpu = resource?.capabilities?.device?.cpu?.logicalCores
  const memory = resource?.capabilities?.device?.memory?.totalBytes
  const resourceLabel = resource?.state === 'available' ? '资源可用' : resource?.state === 'stale' ? '资源陈旧' : resource?.state === 'unavailable' ? '部分不可用' : '资源未知'
  const modelResourceLabel = resource?.models?.state === 'available' ? '模型可用' : resource?.models?.state === 'stale' ? '模型陈旧' : resource?.models?.state === 'unavailable' ? '模型不可用' : '模型来源待确认'
  const resourceTitle = resource ? `探测：${formatDate(resource.checkedAt)}${resource.errorSummary ? `；${resource.errorSummary}` : ''}` : '尚未收到统一资源快照'
  return (
    <div className="participant">
      <AgentAvatar agent={agent} />
      <div><strong>{agent.agentId}</strong><small>{(agent.roles ?? []).map((role) => roleName[role]).join(' / ') || '通用 Agent'} · {agent.deviceId ?? agent.agentId}</small><em>{agent.models?.map((model) => model.label ?? model.id).filter(Boolean).join(' · ') || '默认模型'}</em><small className={`resource-summary ${resource?.state ?? 'unknown'}`} title={resourceTitle}>{resourceLabel} · {modelResourceLabel}{cpu ? ` · ${cpu} 线程` : ''}{memory ? ` · ${formatBytes(memory)}` : ''}</small></div>
      <span className={agent.busy ? 'busy' : agent.paused ? 'paused' : ''}>{agent.status !== 'online' ? '离线' : agent.paused ? '暂停' : agent.busy ? '忙碌' : '空闲'}</span>
    </div>
  )
}

function AgentOperation({ agent, disabled, onToggle }: { agent: Agent; disabled: boolean; onToggle: () => void }) {
  return <div className="agent-operation"><div><strong>{agent.agentId}</strong><small>{agent.status === 'online' ? agent.paused ? '在线 · 已暂停' : agent.busy ? '在线 · 忙碌' : '在线 · 空闲' : '离线'}</small></div><button type="button" disabled={disabled || agent.status !== 'online'} onClick={onToggle}>{agent.paused ? '恢复' : '暂停'}</button></div>
}

function isPartiallyLimited(quota: QuotaSnapshot | null | undefined) {
  const groups = new Map<string, number[]>()
  for (const window of quota?.windows ?? []) {
    const remaining = quotaRemaining(window)
    if (remaining == null) continue
    const group = quotaGroupLabel(window)
    groups.set(group, [...(groups.get(group) ?? []), remaining])
  }
  const groupMinimums = [...groups.values()].map((values) => Math.min(...values))
  return groupMinimums.some((value) => value <= 0) && groupMinimums.some((value) => value > 0)
}

function QuotaBadge({ quota }: { quota: QuotaSnapshot | null }) {
  const state = quota?.state ?? 'Unknown'
  const partiallyLimited = isPartiallyLimited(quota)
  const style = quota?.stale ? 'stale' : partiallyLimited ? 'partial' : state.toLowerCase()
  const label = quota?.stale ? '陈旧' : partiallyLimited ? '部分受限' : state === 'Healthy' ? '充足' : state === 'Low' ? '偏低' : state === 'Exhausted' ? '耗尽' : '未知'
  return <span className={`quota-badge ${style}`}>{label}</span>
}

function QuotaMeter({ quota }: { quota: QuotaSnapshot | null }) {
  const windows = (quota?.windows ?? []).map((window) => ({ window, remaining: quotaRemaining(window) })).filter((item): item is { window: QuotaWindow; remaining: number } => item.remaining != null)
  if (!windows.length) return <div className={`quota-unknown ${quota?.stale ? 'stale' : ''}`}>{quota?.stale ? '最近可信额度已陈旧' : '客户端暂无可读取的额度快照'}<small>来源：{quota?.source ?? 'unavailable'}</small></div>
  const groups = new Map<string, typeof windows>()
  for (const item of windows) {
    const group = quotaGroupLabel(item.window)
    groups.set(group, [...(groups.get(group) ?? []), item])
  }
  return <div className="quota-groups">{[...groups.entries()].map(([group, items]) => <section className="quota-group" key={group}><strong>{group}</strong>{items.map(({ window, remaining }) => <div className="quota-meter" key={window.id ?? `${window.name}-${window.windowType ?? ''}`}><div><span>{quotaDurationLabel(window)}</span><b>剩余 {Math.round(remaining)}%</b></div><progress aria-label={`${group} ${quotaDurationLabel(window)}剩余额度`} max="100" value={remaining} /><small>{window.resetsAt ? `${formatDate(window.resetsAt)} 重置` : `来源：${quota?.source ?? 'client'}`}</small></div>)}</section>)}</div>
}

function quotaRemaining(window: QuotaWindow) {
  if (Number.isFinite(window.remainingPercent)) return Math.max(0, Math.min(100, Number(window.remainingPercent)))
  if (Number.isFinite(window.usedPercent)) return Math.max(0, Math.min(100, 100 - Number(window.usedPercent)))
  return null
}

function quotaGroupLabel(window: QuotaWindow) {
  if (window.quotaGroup) return window.quotaGroup
  if (/gemini models/i.test(window.name)) return 'Gemini Models'
  if (/claude and gpt models/i.test(window.name)) return 'Claude and GPT models'
  if (/codex/i.test(window.name)) return 'Codex'
  return '额度窗口'
}

function quotaDurationLabel(window: QuotaWindow) {
  if (window.durationMinutes === 300) return '5 小时'
  if (window.durationMinutes === 10_080) return '7 天'
  const value = `${window.windowType ?? ''} ${window.name}`.toLowerCase()
  if (/5h|five[ -]?hour|primary/.test(value)) return '5 小时'
  if (/7d|weekly|secondary/.test(value)) return '7 天'
  return window.windowType ?? window.name
}

function acceptsRole(agent: Agent, role: AgentRole) {
  return agent.status === 'online' && !agent.paused && (!agent.roles?.length || agent.roles.includes(role))
}

function isEligibleExecutor(agent: Agent) {
  return agent.status === 'online' && !agent.paused && Boolean(agent.roles?.includes('executor'))
}

function executorStatus(agent: Agent) {
  if (agent.status !== 'online') return '离线，不可选'
  if (agent.paused) return '已暂停，不可选'
  if (!agent.roles?.includes('executor')) return '角色不匹配'
  if (agent.quotaSnapshot?.state === 'Exhausted') {
    if (isPartiallyLimited(agent.quotaSnapshot)) return '部分额度受限'
    return '额度耗尽，可能排队'
  }
  if (agent.busy) return '忙碌，创建后排队'
  return '在线可用'
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

function overviewFromSnapshot(snapshot: HubSnapshot): HubOverview {
  return { health: snapshot.health, agents: snapshot.agents, conversations: snapshot.conversations, usage: snapshot.usage }
}

function detailFromSnapshot(snapshot: HubSnapshot, rootTaskId: string): ConversationDetail {
  return {
    rootTaskId,
    tasks: snapshot.tasks.filter((task) => (task.rootTaskId ?? task.taskId) === rootTaskId),
    messages: snapshot.messages.filter((message) => message.rootTaskId === rootTaskId),
    interventions: snapshot.interventions.filter((item) => item.rootTaskId === rootTaskId && ['pending', 'required'].includes(item.status)),
  }
}

function interventionKey(intervention: HumanIntervention) {
  return intervention.interventionId ?? `${intervention.rootTaskId ?? 'root'}:${intervention.taskId ?? 'task'}:${intervention.requestedAt ?? intervention.question}`
}

function extractMentions(text: string) {
  return [...new Set(text.match(/@[\w.-]+/g) ?? [])]
}

function formatTokens(value: number) {
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
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
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : value < 1024 * 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatApiError(error: unknown, fallback: string) {
  if (error instanceof HubApiError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : fallback
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export default App
