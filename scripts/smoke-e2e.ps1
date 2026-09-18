$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HubRoot = Join-Path $ProjectRoot 'apps\agent-hub'
$BaseUrl = 'http://127.0.0.1:8787'
$StartedHub = $false
$Headers = @{}

if ($env:HUB_TOKEN) {
  $Headers.Authorization = "Bearer $($env:HUB_TOKEN)"
}

function Invoke-HubRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body
  )

  $Parameters = @{
    Method = $Method
    Uri = "$BaseUrl$Path"
    Headers = $Headers
    TimeoutSec = 5
  }
  if ($null -ne $Body) {
    $Parameters.ContentType = 'application/json'
    $Parameters.Body = $Body | ConvertTo-Json -Depth 12
  }
  Invoke-RestMethod @Parameters
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) {
    throw "Smoke assertion failed: $Message"
  }
}

function Wait-ForAgents {
  param([int]$ExpectedCount)
  for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
    $Agents = (Invoke-HubRequest -Method Get -Path '/v1/agents').agents
    if (($Agents | Where-Object status -eq 'online').Count -ge $ExpectedCount) {
      return $Agents
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out waiting for $ExpectedCount online agents."
}

function Wait-ForTask {
  param([string]$TaskId, [string[]]$Statuses)
  for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
    $Task = (Invoke-HubRequest -Method Get -Path '/v1/tasks').tasks |
      Where-Object taskId -eq $TaskId |
      Select-Object -First 1
    if ($Task.status -in $Statuses) {
      return $Task
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out waiting for task $TaskId to reach: $($Statuses -join ', ')."
}

function Wait-ForWorkflow {
  param([string]$RootTaskId)
  for ($Attempt = 0; $Attempt -lt 100; $Attempt++) {
    $Tasks = @((Invoke-HubRequest -Method Get -Path "/v1/tasks?rootTaskId=$RootTaskId").tasks)
    if ($Tasks.Count -ge 4 -and ($Tasks | Where-Object status -NotIn @('completed', 'failed', 'rejected', 'cancelled')).Count -eq 0) {
      return $Tasks
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out waiting for workflow $RootTaskId."
}

function Wait-ForMessageAttachment {
  param([string]$RootTaskId, [string]$AttachmentType)
  for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
    $Messages = @((Invoke-HubRequest -Method Get -Path "/v1/messages?rootTaskId=$RootTaskId").messages)
    foreach ($Message in $Messages) {
      foreach ($Attachment in @($Message.attachments)) {
        if ([string]$Attachment.type -eq $AttachmentType) {
          return $Messages
        }
      }
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out waiting for attachment $AttachmentType in workflow $RootTaskId."
}

try {
  $Health = $null
  try {
    $Health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 1
  } catch {
    $Health = $null
  }
  if (-not $Health.ok) {
    & (Join-Path $HubRoot 'scripts\start-demo.ps1')
    $StartedHub = $true
  }

  $Agents = Wait-ForAgents -ExpectedCount 2
  Assert-True ($Agents.Count -ge 2) 'two workers should be online'

  $Workflow = Invoke-HubRequest -Method Post -Path '/v1/workflows' -Body @{
    title = 'batch smoke collaboration'
    objective = 'produce one reviewed mock result'
    acceptance = @('reviewer approves the result')
    maxReviewCycles = 2
  }
  $WorkflowTasks = Wait-ForWorkflow -RootTaskId $Workflow.task.rootTaskId
  Assert-True ($WorkflowTasks.Count -eq 4) 'workflow should run planner, executor, reviewer, and planner intake'
  $WorkflowRoles = @($WorkflowTasks | ForEach-Object role)
  Assert-True (($WorkflowRoles -join ',') -eq 'planner,executor,reviewer,planner') 'workflow role order should be planner, executor, reviewer, planner'
  $Messages = Wait-ForMessageAttachment -RootTaskId $Workflow.task.rootTaskId -AttachmentType 'full_result'
  $FullResultAttachmentCount = @($Messages | ForEach-Object { $_.attachments } | Where-Object { $_.type -eq 'full_result' }).Count
  Assert-True ($FullResultAttachmentCount -ge 1) 'executor should publish a full-result attachment'
  $Conversations = @((Invoke-HubRequest -Method Get -Path '/v1/conversations').conversations)
  Assert-True (@($Conversations | Where-Object rootTaskId -eq $Workflow.task.rootTaskId).Count -eq 1) 'one root task should create one conversation'
  $Usage = Invoke-HubRequest -Method Get -Path '/v1/usage'
  Assert-True ($Usage.totals.totalTokens -gt 0) 'workflow should accumulate token counts'

  $Success = Invoke-HubRequest -Method Post -Path '/v1/tasks' -Body @{
    targetAgentId = 'agent-a'
    input = 'batch smoke: successful task'
  }
  $SuccessTask = Wait-ForTask -TaskId $Success.task.taskId -Statuses @('completed', 'failed', 'rejected', 'cancelled')
  Assert-True ($SuccessTask.status -eq 'completed') 'ordinary task should complete'

  $Approval = Invoke-HubRequest -Method Post -Path '/v1/tasks' -Body @{
    targetAgentId = 'agent-b'
    input = 'batch smoke: approval task'
    requiresApproval = $true
  }
  Assert-True ($Approval.task.status -eq 'awaiting_approval') 'gated task should wait for approval'
  $null = Invoke-HubRequest -Method Post -Path '/v1/commands' -Body @{
    type = 'task.approve'
    taskId = $Approval.task.taskId
    by = 'smoke-test'
  }
  $ApprovedTask = Wait-ForTask -TaskId $Approval.task.taskId -Statuses @('completed', 'failed', 'rejected', 'cancelled')
  Assert-True ($ApprovedTask.status -eq 'completed') 'approved task should complete'

  $null = Invoke-HubRequest -Method Post -Path '/v1/commands' -Body @{
    type = 'agent.pause'
    targetAgentId = 'agent-a'
  }
  $PausedTask = Invoke-HubRequest -Method Post -Path '/v1/tasks' -Body @{
    targetAgentId = 'agent-a'
    input = 'batch smoke: queued while paused'
  }
  Assert-True ($PausedTask.task.status -eq 'queued') 'task should queue while its worker is paused'
  $null = Invoke-HubRequest -Method Post -Path '/v1/commands' -Body @{
    type = 'agent.resume'
    targetAgentId = 'agent-a'
  }
  $ResumedTask = Wait-ForTask -TaskId $PausedTask.task.taskId -Statuses @('completed', 'failed', 'rejected', 'cancelled')
  Assert-True ($ResumedTask.status -eq 'completed') 'queued task should complete after resume'

  $Cancelled = Invoke-HubRequest -Method Post -Path '/v1/tasks' -Body @{
    targetAgentId = 'agent-b'
    input = 'batch smoke: cancel before approval'
    requiresApproval = $true
  }
  $null = Invoke-HubRequest -Method Post -Path '/v1/commands' -Body @{
    type = 'task.cancel'
    taskId = $Cancelled.task.taskId
  }
  $CancelledTask = Wait-ForTask -TaskId $Cancelled.task.taskId -Statuses @('cancelled')
  Assert-True ($CancelledTask.status -eq 'cancelled') 'cancel command should produce a terminal cancelled task'

  $ApproveAfterCancelStatus = 0
  try {
    $null = Invoke-HubRequest -Method Post -Path '/v1/commands' -Body @{
      type = 'task.approve'
      taskId = $Cancelled.task.taskId
      by = 'smoke-test'
    }
  } catch {
    if ($_.Exception.Response) {
      $ApproveAfterCancelStatus = [int]$_.Exception.Response.StatusCode
    }
  }
  Assert-True ($ApproveAfterCancelStatus -eq 409) 'cancelled task approval should be rejected with HTTP 409'

  $Events = (Invoke-HubRequest -Method Get -Path '/v1/events?limit=100').events
  $EventTypes = @($Events | ForEach-Object type)
  foreach ($ExpectedType in @('task.result', 'agent.pause', 'agent.resume', 'task.cancelled')) {
    Assert-True ($EventTypes -contains $ExpectedType) "event stream should contain $ExpectedType"
  }

  [pscustomobject]@{
    result = 'PASS'
    onlineAgents = ($Agents | Where-Object status -eq 'online').Count
    successfulTask = $SuccessTask.status
    approvedTask = $ApprovedTask.status
    resumedTask = $ResumedTask.status
    cancelledTask = $CancelledTask.status
    approveAfterCancel = $ApproveAfterCancelStatus
    eventsChecked = $Events.Count
    collaborationTasks = $WorkflowTasks.Count
    collaborationMessages = $Messages.Count
    totalTokens = $Usage.totals.totalTokens
  } | Format-List
} finally {
  if ($StartedHub) {
    & (Join-Path $HubRoot 'scripts\stop-demo.ps1')
  }
}
