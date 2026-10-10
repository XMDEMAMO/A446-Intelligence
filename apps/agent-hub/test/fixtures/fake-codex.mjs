const args = process.argv.slice(2);
const requireSandbox = args[0] === "--require-workspace-sandbox";
if (requireSandbox) args.shift();

if (args[0] === "--version") {
  process.stdout.write("codex-cli v1.2.3\n");
} else if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in using test account\n");
} else if (args[0] === "exec") {
  if (args[1] === "resume" && args.includes("--sandbox")) {
    process.stderr.write("unexpected argument '--sandbox' for exec resume\n");
    process.exit(2);
  }
  if (requireSandbox && !args.includes('sandbox_mode="workspace-write"')) {
    process.stderr.write("workspace sandbox configuration was not supplied\n");
    process.exit(2);
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fixture-session" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `received: ${input.trim()}` } })}\n`);
} else {
  process.exitCode = 2;
}
