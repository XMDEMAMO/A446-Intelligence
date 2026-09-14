import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export class EventLog {
  constructor({ file, includePayloads = true, maxMemoryEvents = 2000 } = {}) {
    this.file = file;
    this.includePayloads = includePayloads;
    this.maxMemoryEvents = maxMemoryEvents;
    this.events = [];
    this.sequence = 0;
  }

  async init() {
    if (this.file) await mkdir(path.dirname(this.file), { recursive: true });
  }

  async record(type, details = {}) {
    const event = {
      seq: ++this.sequence,
      ts: new Date().toISOString(),
      type,
      details: this.includePayloads ? details : redactPayloads(details),
    };
    this.events.push(event);
    if (this.events.length > this.maxMemoryEvents) this.events.shift();
    if (this.file) await appendFile(this.file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  recent(limit = 100) {
    return this.events.slice(-Math.max(1, Math.min(Number(limit) || 100, 1000)));
  }
}

function redactPayloads(value) {
  if (Array.isArray(value)) return value.map(redactPayloads);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = /input|output|prompt|content/i.test(key) ? "[redacted]" : redactPayloads(item);
  }
  return result;
}
