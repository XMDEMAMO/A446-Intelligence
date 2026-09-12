import readline from "node:readline";
import { randomUUID } from "node:crypto";

const conversationIndex = process.argv.indexOf("--conversation");
const conversationId = conversationIndex >= 0 ? process.argv[conversationIndex + 1] : `fake-${randomUUID()}`;
let turns = 0;
process.stdout.write(`${JSON.stringify({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: [] } })}\n`);

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const event = JSON.parse(line);
  if (event.event !== "user") return;
  turns += 1;
  const response = `[fake-agy:${conversationId}:turn-${turns}] ${event.message.content}`;
  process.stdout.write(`${JSON.stringify({
    event: "result",
    result: {
      conversation_id: conversationId,
      status: "SUCCESS",
      response,
      num_turns: turns,
      usage: { total_tokens: turns },
    },
  })}\n`);
});

\n