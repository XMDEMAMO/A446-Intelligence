import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class CheckpointStore {
  constructor({ directory, workspace, includeOutput = true, maxOutputChars = 200_000 }) {
    this.directory = path.resolve(directory);
    this.workspace = path.resolve(workspace);
    this.includeOutput = includeOutput;
    this.maxOutputChars = Number(maxOutputChars);
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
  }

  async save(message, stage, details = {}) {
    const taskId = safeTaskId(message.taskId);
    const taskDir = path.join(this.directory, taskId);
    await mkdir(taskDir, { recursive: true });
    const checkpointId = `${taskId}-${String(stage).toLowerCase()}-${Date.now()}`;
    const state = {
      checkpointId,
      taskId,
      stage,
      updatedAt: new Date().toISOString(),
      sessionId: details.sessionId ?? null,
      error: details.error ?? null,
    };
    const taskSpec = {
      taskId,
      rootTaskId: message.payload?.rootTaskId ?? null,
      parentTaskId: message.payload?.parentTaskId ?? null,
      sourceAgentId: message.payload?.sourceAgentId ?? null,
      input: message.payload?.input ?? "",
      taskSpec: message.payload?.taskSpec ?? message.payload?.metadata?.taskSpec ?? null,
    };
    await Promise.all([
      writeJsonAtomic(path.join(taskDir, "state.json"), state),
      writeJsonAtomic(path.join(taskDir, "task_spec.json"), taskSpec),
      writeJsonAtomic(path.join(taskDir, "files_manifest.json"), details.artifacts ?? emptyManifest()),
      writeTextAtomic(path.join(taskDir, "continuation.md"), continuationText(stage, details)),
      this.includeOutput && details.output !== undefined
        ? writeTextAtomic(path.join(taskDir, "partial_output.txt"), String(details.output).slice(-this.maxOutputChars))
        : Promise.resolve(),
    ]);
    return {
      checkpointId,
      stage,
      path: portablePath(path.relative(this.workspace, taskDir)),
      updatedAt: state.updatedAt,
    };
  }
}

function continuationText(stage, details) {
  const completed = stage === "COMPLETED"
    ? "任务执行完成，结果和 Artifact 清单已经保存。"
    : stage === "FAILED" || stage === "CANCELLED" || stage === "REJECTED"
      ? `任务未完成：${details.error?.message ?? details.error ?? stage}。`
      : `任务已进入 ${stage} 阶段。`;
  const remaining = stage === "COMPLETED" ? "无需继续执行。" : "根据 task_spec.json 和 state.json 从当前阶段继续。";
  return [
    "# Continuation",
    "",
    `- 已经完成什么：${completed}`,
    `- 尚未完成什么：${remaining}`,
    `- 当前关键判断：${details.note ?? "以本地 Policy、Task Spec 和最新状态为准。"}`,
    "- 下一执行器从哪里继续：读取本目录中的 task_spec.json、state.json 和 files_manifest.json。",
    "",
  ].join("\n");
}

function emptyManifest() {
  return { algorithm: "sha256", generatedAt: new Date().toISOString(), files: [], missing: [] };
}

async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, value, "utf8");
  await rename(temp, file);
}

function safeTaskId(value) {
  const taskId = String(value ?? "");
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(taskId)) throw new Error("Unsafe taskId for checkpoint path");
  return taskId;
}

function portablePath(value) {
  return value.split(path.sep).join("/");
}

\n