export type ConnectionMode = 'connecting' | 'live' | 'demo'
export type AgentRole = 'planner' | 'executor' | 'reviewer'
export type AgentHealth = 'Healthy' | 'Degraded' | 'Unhealthy' | 'Unknown'
export type QuotaState = 'Healthy' | 'Low' | 'Exhausted' | 'Unknown'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  toolTokens: number
  totalTokens: number
}

export interface QuotaWindow {
  name: string
  usedPercent: number | null
  remainingPercent: number | null
  resetsAt: string | null
}

export interface QuotaSnapshot {
  state: QuotaState
  checkedAt: string
  source: string
  windows: QuotaWindow[]
}

export interface AccountProfile {
  id?: string
  provider?: string
  plan?: string
  label?: string
}

export interface ModelProfile {
  id: string | null
  label?: string
  enabled?: boolean
  capabilities?: string[]
  reasoningEfforts?: string[]
  quota?: QuotaSnapshot | null
}

export interface ExecutorState {
  type: string
  health: AgentHealth
  quota: QuotaState
  checkedAt?: string
  lastError?: { name?: string; message?: string } | null
}

export interface ObservedCapabilities {
  adapter?: { name?: string; available?: boolean; ready?: boolean; version?: string }
  tools?: Array<{ name: string; available: boolean; version?: string }>
}

export interface Agent {
  agentId: string
  deviceId?: string
  account?: AccountProfile | null
  roles?: AgentRole[]
  models?: ModelProfile[]
  maxConcurrency?: number
  status: 'online' | 'offline' | string
  paused?: boolean
  busy?: boolean
  adapter?: string
  capabilities?: string[]
  sessionId?: string | null
  currentTaskId?: string | null
  connectedAt?: string
  disconnectedAt?: string
  lastSeenAt?: string
  observedCapabilities?: ObservedCapabilities
  executors?: ExecutorState[]
  usageTotals?: TokenUsage | null
  quotaSnapshot?: QuotaSnapshot | null
}

export interface TaskSpec {
  title?: string
  type?: string
  priority?: string
  inputs?: Array<string | { path: string }>
  expected_outputs?: Array<string | { path: string }>
  permissions_required?: Record<string, boolean | string | number>
  checkpoint_policy?: Record<string, unknown>
  acceptance?: string[]
}

export interface ArtifactFile {
  path: string
  size: number
  sha256: string | null
  status: string
}

export interface ArtifactManifest {
  algorithm?: string
  files?: ArtifactFile[]
  missing?: string[]
}

export interface RoleSubmission {
  brief?: string
  fullResult?: string
  verdict?: 'approved' | 'rejected' | 'upstream_confirmed' | 'upstream_denied'
  assignments?: Array<Record<string, unknown>>
  issues?: string[]
  correctionBrief?: string | null
  needsHuman?: boolean
  humanQuestion?: string | null
  upstreamIssue?: Record<string, unknown> | null
}

export interface HumanIntervention {
  status: 'required' | 'resolved'
  question: string
  requestedBy?: string
  requestedAt?: string
  response?: string
  resolvedAt?: string
}

export interface HubTask {
  taskId: string
  rootTaskId?: string
  parentTaskId?: string | null
  targetAgentId: string | null
  sourceAgentId?: string
  input: string
  role?: AgentRole | null
  stage?: string
  route?: string[]
  metadata?: Record<string, unknown>
  taskSpec?: TaskSpec | null
  contextBundle?: Record<string, unknown>
  execution?: { model?: string | null; reasoningEffort?: string | null; reason?: string }
  model?: string | null
  usage?: TokenUsage | null
  submission?: RoleSubmission
  reviewStatus?: string
  reviewCycle?: number
  requiresApproval?: boolean
  status: string
  createdAt: string
  dispatchedAt?: string
  startedAt?: string
  completedAt?: string
  output?: string
  error?: { name?: string; message?: string; code?: string; reasons?: string[] }
  artifacts?: ArtifactManifest
  humanIntervention?: HumanIntervention | null
}

export interface MessageAttachment {
  type: 'full_result' | 'artifacts' | string
  label: string
  taskId?: string
  version?: string
  content?: string
  artifacts?: ArtifactManifest | null
}

export interface HubMessage {
  messageId: string
  seq: number
  rootTaskId: string
  taskId: string
  parentTaskId?: string | null
  senderId: string
  senderRole: AgentRole | 'human' | 'system' | string
  kind: string
  text: string
  mentions: string[]
  attachments: MessageAttachment[]
  createdAt: string
}

export interface Conversation {
  rootTaskId: string
  title: string
  status: 'active' | 'completed' | 'failed' | 'needs_human' | string
  createdAt: string
  updatedAt: string
  participants: string[]
  taskCount: number
  messageCount: number
  humanIntervention?: HumanIntervention | null
}

export interface UsageAgentSummary {
  agentId: string
  deviceId?: string
  account?: AccountProfile | null
  usageTotals?: TokenUsage | null
  quotaSnapshot?: QuotaSnapshot | null
}

export interface HubEvent {
  seq: number
  ts: string
  type: string
  details: Record<string, unknown>
}

export interface HubHealth {
  ok: boolean
  protocolVersion: number
  now: string
}

export interface HubSnapshot {
  health: HubHealth
  agents: Agent[]
  tasks: HubTask[]
  conversations: Conversation[]
  messages: HubMessage[]
  usage: { totals: TokenUsage | null; byAgent: UsageAgentSummary[] }
  events: HubEvent[]
}

export interface CreateWorkflowRequest {
  title: string
  objective: string
  acceptance: string[]
  plannerAgentId?: string | null
  reviewerAgentId?: string | null
  modelPreference?: string | null
  reasoningEffort?: string | null
  maxReviewCycles: number
}
