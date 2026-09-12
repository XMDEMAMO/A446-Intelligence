export type ConnectionMode = 'connecting' | 'live' | 'demo'

export type AgentHealth = 'Healthy' | 'Degraded' | 'Unhealthy' | 'Unknown'
export type QuotaState = 'Healthy' | 'Low' | 'Exhausted' | 'Unknown'

export interface ExecutorState {
  type: string
  health: AgentHealth
  quota: QuotaState
  lastError?: string | null
}

export interface ObservedTool {
  name: string
  available: boolean
  version?: string
}

export interface ObservedCapabilities {
  adapter?: {
    name?: string
    available?: boolean
    version?: string
  }
  tools?: ObservedTool[]
}

export interface Agent {
  agentId: string
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

export interface CheckpointRef {
  checkpointId?: string
  stage?: string
  path?: string
}

export interface HubTask {
  taskId: string
  rootTaskId?: string
  parentTaskId?: string
  targetAgentId: string
  sourceAgentId?: string
  input: string
  route?: string[]
  metadata?: Record<string, unknown>
  taskSpec?: TaskSpec | null
  requiresApproval?: boolean
  status: string
  createdAt: string
  dispatchedAt?: string
  startedAt?: string
  completedAt?: string
  output?: string
  error?: {
    name?: string
    message?: string
    code?: string
    reasons?: string[]
  }
  artifacts?: ArtifactManifest
  checkpoint?: CheckpointRef
  approval?: Record<string, unknown>
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
  events: HubEvent[]
}

export interface CreateTaskRequest {
  targetAgentId: string
  input: string
  requiresApproval: boolean
  taskSpec: TaskSpec
}
\n