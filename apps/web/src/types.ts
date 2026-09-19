export type ConnectionMode = 'loading' | 'live' | 'reconnecting' | 'offline' | 'demo'
export type AgentRole = 'planner' | 'executor' | 'reviewer'
export type AgentHealth = 'Healthy' | 'Degraded' | 'Unhealthy' | 'Unknown'
export type QuotaState = 'Healthy' | 'Low' | 'Exhausted' | 'Unknown'
export type ResourceState = 'available' | 'unavailable' | 'unknown' | 'stale'
export type WebUserRole = 'admin' | 'operator'
export type WebUserStatus = 'active' | 'disabled'

export interface WebUser {
  id: string
  username: string
  role: WebUserRole
  status?: WebUserStatus
  createdAt?: string
  updatedAt?: string
  lastLoginAt?: string | null
  activeSessionCount?: number | null
}

export interface WorkerCredential {
  credentialId: string
  agentId: string
  deviceId: string
  status: 'active' | 'revoked' | string
  createdAt?: string
  lastUsedAt?: string | null
  revokedAt?: string | null
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  toolTokens: number
  totalTokens: number
}

export interface QuotaWindow {
  id?: string
  name: string
  quotaGroup?: string
  windowType?: string
  durationMinutes?: number | null
  usedPercent: number | null
  remainingPercent: number | null
  resetsAt: string | null
}

export interface QuotaSnapshot {
  state: QuotaState
  checkedAt: string
  source: string
  windows: QuotaWindow[]
  lastSuccessAt?: string | null
  stale?: boolean
  errorSummary?: string | null
}

export interface AccountProfile {
  id?: string
  provider?: string
  plan?: string
  label?: string
  maxConcurrency?: number
}

export interface ModelProfile {
  id: string | null
  label?: string
  family?: string
  quotaGroup?: string
  enabled?: boolean
  capabilities?: string[]
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string | null
  quota?: QuotaSnapshot | null
  quotaState?: QuotaState
  availability?: ResourceState
  source?: string
  checkedAt?: string
  lastSuccessAt?: string | null
  stale?: boolean
  errorSummary?: string | null
}

export interface ExecutorState {
  type: string
  health: AgentHealth
  quota: QuotaState
  checkedAt?: string
  lastError?: { name?: string; message?: string } | null
}

export interface ObservedCapabilities {
  state?: ResourceState
  source?: string
  checkedAt?: string
  lastSuccessAt?: string | null
  stale?: boolean
  errorSummary?: string | null
  adapter?: ResourceProbe
  tools?: ResourceProbe[]
  services?: ResourceProbe[]
  device?: {
    system?: ResourceProbe & { platform?: string; arch?: string; release?: string }
    cpu?: ResourceProbe & { model?: string | null; logicalCores?: number }
    memory?: ResourceProbe & { totalBytes?: number; freeBytes?: number }
    node?: ResourceProbe
    python?: ResourceProbe
    gpu?: ResourceProbe
    browsers?: ResourceProbe[]
  }
}

export interface ResourceProbe {
  name?: string
  state?: ResourceState
  source?: string
  checkedAt?: string
  lastSuccessAt?: string | null
  stale?: boolean
  errorSummary?: string | null
  available?: boolean | null
  ready?: boolean
  version?: string | null
  description?: string
  capabilities?: string[]
}

export interface ResourceSnapshot {
  schemaVersion: number
  state: ResourceState
  checkedAt: string
  stale: boolean
  errorSummary?: string | null
  capabilities?: ObservedCapabilities
  account?: {
    state: ResourceState
    source: string
    checkedAt: string
    lastSuccessAt?: string | null
    stale?: boolean
    errorSummary?: string | null
    profile?: AccountProfile | null
    authMode?: string | null
    identityVerified?: boolean | null
  }
  models?: {
    state: ResourceState
    source: string
    checkedAt: string
    lastSuccessAt?: string | null
    stale?: boolean
    errorSummary?: string | null
    items: ModelProfile[]
  }
  quota?: QuotaSnapshot | null
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
  resourceSnapshot?: ResourceSnapshot | null
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
  artifactId?: string
  path: string
  size: number
  sha256: string | null
  status: string
  downloadUrl?: string
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
  interventionId?: string
  rootTaskId?: string
  taskId?: string
  kind?: 'workflow_input' | 'task_approval' | 'worker_approval' | 'lease_expiry' | string
  status: 'pending' | 'required' | 'resolved'
  recordStatus?: 'pending' | 'resolved'
  question: string
  requestedBy?: string
  requesterRole?: string
  requesterStage?: string | null
  sessionScopeId?: string | null
  allowedActions?: Array<'approve' | 'reject' | 'respond'>
  context?: Record<string, unknown>
  resume?: { type?: string; role?: string | null; stage?: string | null; sessionScopeId?: string | null } | null
  requestedAt?: string
  decision?: 'approve' | 'reject' | 'respond'
  response?: string
  resolvedAt?: string
  resolvedBy?: string
}

export interface HubTask {
  taskId: string
  rootTaskId?: string
  parentTaskId?: string | null
  targetAgentId: string | null
  requestedAgentId?: string | null
  executorAgentId?: string | null
  sourceAgentId?: string
  input: string
  role?: AgentRole | null
  stage?: string
  route?: string[]
  metadata?: Record<string, unknown>
  workflow?: {
    enabled?: boolean
    plannerAgentId?: string | null
    executorAgentId?: string | null
    reviewerAgentId?: string | null
    maxReviewCycles?: number
  } | null
  sessionScopeId?: string | null
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
  schedulingError?: string | null
  schedulingErrorCode?:
    | 'NO_ELIGIBLE_AGENT'
    | 'EXECUTOR_UNAVAILABLE'
    | 'EXECUTOR_PAUSED'
    | 'EXECUTOR_ROLE_MISMATCH'
    | 'EXECUTOR_AT_CAPACITY'
    | 'EXECUTOR_QUOTA_UNAVAILABLE'
    | string
    | null
  schedulingErrorDetails?: {
    reason?: string
    agentId?: string
    observedAt?: string
    [key: string]: unknown
  } | null
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
  status: 'active' | 'completed' | 'failed' | 'needs_human' | 'cancelled' | string
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
  interventions: HumanIntervention[]
  usage: { totals: TokenUsage | null; byAgent: UsageAgentSummary[] }
  events: HubEvent[]
}

export interface HubOverview {
  health: HubHealth
  agents: Agent[]
  conversations: Conversation[]
  usage: { totals: TokenUsage | null; byAgent: UsageAgentSummary[] }
}

export interface ConversationDetail {
  rootTaskId: string
  tasks: HubTask[]
  messages: HubMessage[]
  interventions: HumanIntervention[]
}

export interface CreateWorkflowRequest {
  title: string
  objective: string
  acceptance: string[]
  plannerAgentId?: string | null
  executorAgentId?: string | null
  reviewerAgentId?: string | null
  modelPreference?: string | null
  reasoningEffort?: string | null
  maxReviewCycles: number
}
