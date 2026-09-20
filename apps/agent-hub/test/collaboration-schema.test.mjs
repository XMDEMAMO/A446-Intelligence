import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRolePrompt,
  extractDeterministicJson,
  isPathSafe,
  parseRoleSubmission,
  pathsOverlap,
  validateRoleSubmission,
} from "../src/collaboration.mjs";

test("extractDeterministicJson extracts JSON from raw text, code fences, and rejects unescaped quotes without crashing", () => {
  // 1. Raw JSON
  const r1 = extractDeterministicJson('{"brief":"ok","assignments":[]}');
  assert.equal(r1.ok, true);
  assert.equal(r1.value.brief, "ok");

  // 2. Markdown fences
  const r2 = extractDeterministicJson('```json\n{"brief":"fenced","count":1}\n```');
  assert.equal(r2.ok, true);
  assert.equal(r2.value.brief, "fenced");

  // 3. Surrounding text
  const r3 = extractDeterministicJson('Here is the plan:\n{"brief":"surrounded"}\nHope this helps!');
  assert.equal(r3.ok, true);
  assert.equal(r3.value.brief, "surrounded");

  // 4. Broken JSON with unescaped internal quotes (Test 2 real-world reproduction)
  const broken = '{"brief": "网站测试：所有agent输出"火区"两个字", "assignments": []}';
  const r4 = extractDeterministicJson(broken);
  assert.equal(r4.ok, false);
  assert.equal(r4.value, null);
  assert.match(r4.error, /JSON syntax error/i);
  assert.equal(r4.raw, broken);

  // 5. Empty output
  const r5 = extractDeterministicJson("   ");
  assert.equal(r5.ok, false);
  assert.equal(r5.error, "Empty output");

  // 6. Array output
  const r6 = extractDeterministicJson("[1, 2, 3]");
  assert.equal(r6.ok, false);
  assert.match(r6.error, /Parsed JSON.*object/i);
});

test("pathsOverlap and isPathSafe properly detect cross-directory collisions and unsafe paths", () => {
  assert.equal(isPathSafe("outputs/file.txt"), true);
  assert.equal(isPathSafe("deep/nested/result.md"), true);
  assert.equal(isPathSafe("../secret.txt"), false);
  assert.equal(isPathSafe("outputs/../../secret.txt"), false);
  assert.equal(isPathSafe("C:\\Windows\\System32"), false);
  assert.equal(isPathSafe("/etc/passwd"), false);

  assert.equal(pathsOverlap("outputs/file.txt", "outputs/file.txt"), true);
  assert.equal(pathsOverlap("outputs", "outputs/sub.txt"), true);
  assert.equal(pathsOverlap("outputs/sub.txt", "outputs"), true);
  assert.equal(pathsOverlap("outputs/a.txt", "outputs/b.txt"), false);
  assert.equal(pathsOverlap("outputs1", "outputs2"), false);
});

test("planning stage validates assignments count, overlapping paths, and deduplicates identical assignments", () => {
  // Normal planning
  const valid = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Valid plan",
    assignments: [
      { title: "Task 1", instructions: "Do task 1", expectedOutputs: ["outputs/t1.md"] },
      { title: "Task 2", instructions: "Do task 2", expectedOutputs: ["outputs/t2.md"] },
    ],
  }));
  assert.equal(valid.ok, true);
  assert.equal(valid.value.assignments.length, 2);
  assert.equal(valid.brief, "Valid plan");

  // Exceeds 8 assignments
  const nineAssignments = Array.from({ length: 9 }, (_, i) => ({
    title: `Task ${i}`,
    instructions: `Instructions ${i}`,
    expectedOutputs: [`outputs/t${i}.md`],
  }));
  const exceed = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Too many tasks",
    assignments: nineAssignments,
  }));
  assert.equal(exceed.ok, false);
  assert.match(exceed.error, /cannot exceed 8 assignments/i);

  // Empty assignments without needsHuman
  const empty = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Empty tasks",
    assignments: [],
  }));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /at least one assignment/i);

  // needsHuman with empty assignments is allowed
  const human = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Needs clarification",
    assignments: [],
    needsHuman: true,
    humanQuestion: "Which approach do you prefer?",
  }));
  assert.equal(human.ok, true);
  assert.equal(human.value.needsHuman, true);
  assert.equal(human.value.humanQuestion, "Which approach do you prefer?");

  // Overlapping expectedOutputs collision
  const collision = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Conflicting plan",
    assignments: [
      { title: "Task 1", instructions: "Write to same file", expectedOutputs: ["outputs/shared.md"] },
      { title: "Task 2", instructions: "Also write to same file", expectedOutputs: ["outputs/shared.md"] },
    ],
  }));
  assert.equal(collision.ok, false);
  assert.match(collision.error, /Conflicting expectedOutputs/i);

  // Unsafe expectedOutputs path
  const unsafe = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Unsafe plan",
    assignments: [
      { title: "Task 1", instructions: "Escape workspace", expectedOutputs: ["../../escape.txt"] },
    ],
  }));
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.error, /unsafe or absolute/i);

  // Rejection of identical assignments (no silent deduplication)
  const dups = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Duplicate tasks",
    assignments: [
      { title: "Same task", instructions: "Same instructions" },
      { title: "Same task", instructions: "Same instructions" },
    ],
  }));
  assert.equal(dups.ok, false);
  assert.match(dups.error, /重复/);

  // Distinct tasks with different expectedOutputs are allowed
  const distinct = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Distinct tasks",
    assignments: [
      { title: "Task 1", instructions: "Instructions", expectedOutputs: ["outputs/part1.md"] },
      { title: "Task 2", instructions: "Instructions", expectedOutputs: ["outputs/part2.md"] },
    ],
  }));
  assert.equal(distinct.ok, true);
  assert.equal(distinct.value.assignments.length, 2);
});

test("execution stage validates brief, fullResult, and upstreamIssue structure", () => {
  // Valid execution result
  const valid = parseRoleSubmission("executor", "execution", JSON.stringify({
    brief: "Done work",
    fullResult: "Here is the full result of the work",
  }));
  assert.equal(valid.ok, true);
  assert.equal(valid.fullResult, "Here is the full result of the work");

  // Missing fullResult
  const missingResult = parseRoleSubmission("executor", "execution", JSON.stringify({
    brief: "Done work without result",
  }));
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.error, /fullResult/i);

  // Valid upstreamIssue
  const withIssue = parseRoleSubmission("executor", "execution", JSON.stringify({
    brief: "Found upstream issue",
    fullResult: "Investigation notes",
    upstreamIssue: {
      summary: "Invalid input schema",
      evidence: ["Logs line 42", "Response code 500"],
      impact: "Cannot proceed",
      recommendation: "Replan with correct input",
    },
  }));
  assert.equal(withIssue.ok, true);
  assert.equal(withIssue.value.upstreamIssue.summary, "Invalid input schema");
  assert.equal(withIssue.value.upstreamIssue.evidence.length, 2);

  // Invalid upstreamIssue (missing evidence)
  const badIssue = parseRoleSubmission("executor", "execution", JSON.stringify({
    brief: "Found upstream issue",
    fullResult: "Notes",
    upstreamIssue: {
      summary: "Broken",
      evidence: [],
    },
  }));
  assert.equal(badIssue.ok, false);
  assert.match(badIssue.error, /evidence/i);
});

test("result_review and upstream_review enforce distinct verdicts", () => {
  // result_review accepts approved or rejected
  const approved = parseRoleSubmission("reviewer", "result_review", JSON.stringify({
    verdict: "approved",
    brief: "Looks great",
  }));
  assert.equal(approved.ok, true);
  assert.equal(approved.verdict, "approved");

  const rejected = parseRoleSubmission("reviewer", "result_review", JSON.stringify({
    verdict: "rejected",
    brief: "Found bugs",
    issues: ["Issue 1"],
  }));
  assert.equal(rejected.ok, true);
  assert.equal(rejected.verdict, "rejected");

  // result_review rejects upstream verdicts
  const invalidVerdict = parseRoleSubmission("reviewer", "result_review", JSON.stringify({
    verdict: "upstream_confirmed",
    brief: "Wrong stage verdict",
  }));
  assert.equal(invalidVerdict.ok, false);
  assert.match(invalidVerdict.error, /must be 'approved' or 'rejected'/i);

  // upstream_review accepts upstream_confirmed or upstream_denied
  const upstreamConf = parseRoleSubmission("reviewer", "upstream_review", JSON.stringify({
    verdict: "upstream_confirmed",
    brief: "Confirmed issue",
    correctionBrief: "Fix input",
  }));
  assert.equal(upstreamConf.ok, true);
  assert.equal(upstreamConf.verdict, "upstream_confirmed");

  const upstreamDen = parseRoleSubmission("reviewer", "upstream_review", JSON.stringify({
    verdict: "upstream_denied",
    brief: "Issue is not valid",
  }));
  assert.equal(upstreamDen.ok, true);
  assert.equal(upstreamDen.verdict, "upstream_denied");

  // upstream_review rejects 'approved'
  const badUpstreamVerdict = parseRoleSubmission("reviewer", "upstream_review", JSON.stringify({
    verdict: "approved",
    brief: "Wrong verdict for upstream review",
  }));
  assert.equal(badUpstreamVerdict.ok, false);
  assert.match(badUpstreamVerdict.error, /must be 'upstream_confirmed' or 'upstream_denied'/i);
});

test("result_intake requires explicit decision and rejects ambiguous completion", () => {
  // Explicit complete
  const complete = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "complete",
    brief: "Task finished successfully",
    assignments: [],
  }));
  assert.equal(complete.ok, true);
  assert.equal(complete.value.decision, "complete");

  // Explicit continue with assignments
  const cont = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "continue",
    brief: "Need second phase",
    assignments: [{ title: "Phase 2", instructions: "Do phase 2" }],
  }));
  assert.equal(cont.ok, true);
  assert.equal(cont.value.decision, "continue");
  assert.equal(cont.value.assignments.length, 1);

  // Explicit needs_human
  const needHuman = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "needs_human",
    brief: "Ambiguous result requires human approval",
  }));
  assert.equal(needHuman.ok, true);
  assert.equal(needHuman.value.decision, "needs_human");

  // Missing decision (e.g. old style empty assignments) -> MUST FAIL!
  const legacyGuess = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    brief: "I think we are done",
    assignments: [],
  }));
  assert.equal(legacyGuess.ok, false);
  assert.match(legacyGuess.error, /must contain a valid decision/i);

  // Invalid decision string
  const unknownDec = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "done",
    brief: "Done is not a valid decision keyword",
  }));
  assert.equal(unknownDec.ok, false);
  assert.match(unknownDec.error, /must contain a valid decision/i);

  // decision: "complete" with non-empty assignments -> MUST FAIL (reject ambiguous/lossy payload)
  const completeWithAssignments = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "complete",
    brief: "Finished but gave assignments anyway",
    assignments: [{ title: "Extra task", instructions: "Should not be here" }],
  }));
  assert.equal(completeWithAssignments.ok, false);
  assert.match(completeWithAssignments.error, /不得附带任何子任务/);
});

test("buildRolePrompt generates phase-specific contracts and file-writing instructions", () => {
  // Planner in result_intake receives decision options
  const intakePrompt = buildRolePrompt("planner", "Receive review", { stage: "result_intake" });
  assert.match(intakePrompt, /"decision":"complete\|continue\|needs_human"/);
  assert.match(intakePrompt, /STAGE: result_intake/);

  // Planner in planning receives assignments contract (<= 8)
  const planPrompt = buildRolePrompt("planner", "Initial planning", { stage: "planning" });
  assert.match(planPrompt, /at most 8 subtasks/);
  assert.match(planPrompt, /STAGE: planning/);

  // Executor with expected_outputs receives file writing mandate
  const execPrompt = buildRolePrompt("executor", "Write file", {
    stage: "execution",
    taskSpec: { expected_outputs: ["outputs/report.md"] },
  });
  assert.match(execPrompt, /【强制交付要求】/);
  assert.match(execPrompt, /outputs\/report\.md/);
  assert.match(execPrompt, /切勿仅在回复文本中输出结果/);

  // Reviewer in upstream_review receives upstream verdict contract
  const reviewUpstreamPrompt = buildRolePrompt("reviewer", "Review issue", { stage: "upstream_review" });
  assert.match(reviewUpstreamPrompt, /upstream_confirmed\|upstream_denied/);

  // Reviewer in result_review receives approved|rejected contract
  const reviewResultPrompt = buildRolePrompt("reviewer", "Review work", { stage: "result_review" });
  assert.match(reviewResultPrompt, /approved\|rejected/);
});

test("Windows case-insensitive collision and strict expectedOutputs validation", () => {
  // Case-insensitive collision on Windows/cross-platform (e.g. Result.txt and result.txt)
  const collision = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Case collision plan",
    assignments: [
      { title: "Task 1", instructions: "Write uppercase", expectedOutputs: ["outputs/Result.txt"] },
      { title: "Task 2", instructions: "Write lowercase", expectedOutputs: ["outputs/result.txt"] },
    ],
  }));
  assert.equal(collision.ok, false);
  assert.match(collision.error, /Conflicting expectedOutputs/i);

  // Invalid empty or whitespace-only expectedOutputs item
  const emptyOutput = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Empty output item",
    assignments: [
      { title: "Task 1", instructions: "Do work", expectedOutputs: [""] },
    ],
  }));
  assert.equal(emptyOutput.ok, false);
  assert.match(emptyOutput.error, /cannot be empty/i);
});

test("preview12: Windows reserved device names, drive-relative paths, and trailing dot collisions", () => {
  // Drive-relative paths
  assert.equal(isPathSafe("C:..\\outside.txt"), false);
  assert.equal(isPathSafe("D:file.txt"), false);

  // Windows reserved device names
  assert.equal(isPathSafe("CON.txt"), false);
  assert.equal(isPathSafe("PRN"), false);
  assert.equal(isPathSafe("AUX.log"), false);
  assert.equal(isPathSafe("NUL"), false);
  assert.equal(isPathSafe("COM1.txt"), false);
  assert.equal(isPathSafe("LPT2"), false);
  assert.equal(isPathSafe("sub/CON/test.txt"), false);

  // Trailing dots and spaces
  assert.equal(isPathSafe("outputs/result.txt."), false);
  assert.equal(isPathSafe("outputs/result.txt "), false);
  assert.equal(isPathSafe("outputs./result.txt"), false);

  // Collision detection between result.txt and result.txt.
  assert.equal(pathsOverlap("outputs/result.txt", "outputs/result.txt."), true);
  assert.equal(pathsOverlap("outputs/result.txt.", "outputs/result.txt"), true);
  assert.equal(pathsOverlap("outputs/result.txt ", "outputs/result.txt"), true);
});

test("preview12: strict schema rejects needsHuman/needs_human when accompanied by assignments (no silent drops)", () => {
  // 1. camelCase needsHuman with non-empty assignments
  const camelCaseConflict = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Conflicting plan",
    needsHuman: true,
    assignments: [{ title: "Task 1", instructions: "Do something" }],
  }));
  assert.equal(camelCaseConflict.ok, false);
  assert.match(camelCaseConflict.error, /不得附带任何子任务分配/);

  // 2. snake_case needs_human with non-empty assignments
  const snakeCaseConflict = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Conflicting plan",
    needs_human: true,
    assignments: [{ title: "Task 1", instructions: "Do something" }],
  }));
  assert.equal(snakeCaseConflict.ok, false);
  assert.match(snakeCaseConflict.error, /不得附带任何子任务分配/);

  // 3. result_intake: decision 'continue' with needsHuman declared
  const continueWithHuman = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "continue",
    brief: "Continue but also needs human",
    needsHuman: true,
    assignments: [{ title: "Task 1", instructions: "Do something" }],
  }));
  assert.equal(continueWithHuman.ok, false);
  assert.match(continueWithHuman.error, /不得声明 needsHuman/);

  // 4. result_intake: decision 'continue' with needs_human declared
  const continueWithSnakeHuman = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "continue",
    brief: "Continue but also needs human",
    needs_human: true,
    assignments: [{ title: "Task 1", instructions: "Do something" }],
  }));
  assert.equal(continueWithSnakeHuman.ok, false);
  assert.match(continueWithSnakeHuman.error, /不得声明 needsHuman/);

  // 5. result_intake: decision 'needs_human' with assignments
  const intakeHumanWithAssignments = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "needs_human",
    brief: "Needs human decision",
    assignments: [{ title: "Task 1", instructions: "Do something" }],
  }));
  assert.equal(intakeHumanWithAssignments.ok, false);
  assert.match(intakeHumanWithAssignments.error, /不得附带任何子任务分配/);
});

test("preview12: duplicate task fingerprint includes requiredCapabilities and reasoningEffort", () => {
  // Different reasoningEffort is NOT a duplicate
  const diffReasoning = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Multi-effort plan",
    assignments: [
      { title: "Optimize code", instructions: "Run benchmarks", reasoningEffort: "low" },
      { title: "Optimize code", instructions: "Run benchmarks", reasoningEffort: "high" },
    ],
  }));
  assert.equal(diffReasoning.ok, true);
  assert.equal(diffReasoning.value.assignments.length, 2);

  // Different requiredCapabilities is NOT a duplicate
  const diffCapabilities = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Multi-capability plan",
    assignments: [
      { title: "Run tests", instructions: "Verify code", requiredCapabilities: ["docker"] },
      { title: "Run tests", instructions: "Verify code", requiredCapabilities: ["gpu"] },
    ],
  }));
  assert.equal(diffCapabilities.ok, true);
  assert.equal(diffCapabilities.value.assignments.length, 2);

  // Identical reasoningEffort and capabilities IS a duplicate
  const sameEverything = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Duplicate plan",
    assignments: [
      { title: "Optimize code", instructions: "Run benchmarks", reasoningEffort: "high", requiredCapabilities: ["gpu"] },
      { title: "Optimize code", instructions: "Run benchmarks", reasoningEffort: "high", requiredCapabilities: ["gpu"] },
    ],
  }));
  assert.equal(sameEverything.ok, false);
  assert.match(sameEverything.error, /完全重复的子任务规划/);
});

test("preview13: strict schema rejects non-array assignments and mutually exclusive human fields", () => {
  // 1. assignments as object instead of array in planning rejected
  const objAssignmentsPlanning = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Object assignments",
    assignments: { "0": { title: "T", instructions: "I" } },
  }));
  assert.equal(objAssignmentsPlanning.ok, false);
  assert.match(objAssignmentsPlanning.error, /assignments.*必须为数组/);

  // 2. assignments as object with needsHuman: true in planning rejected
  const objAssignmentsWithHuman = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Object assignments with human",
    needsHuman: true,
    assignments: { "0": { title: "T", instructions: "I" } },
  }));
  assert.equal(objAssignmentsWithHuman.ok, false);
  assert.match(objAssignmentsWithHuman.error, /assignments.*必须为数组/);

  // 3. result_intake decision 'complete' with needsHuman rejected
  const completeWithNeedsHuman = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "complete",
    brief: "All done",
    needsHuman: true,
  }));
  assert.equal(completeWithNeedsHuman.ok, false);
  assert.match(completeWithNeedsHuman.error, /不得声明 needsHuman/);

  // 4. result_intake decision 'complete' with humanQuestion rejected
  const completeWithHumanQuestion = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "complete",
    brief: "All done",
    humanQuestion: "Should I do something else?",
  }));
  assert.equal(completeWithHumanQuestion.ok, false);
  assert.match(completeWithHumanQuestion.error, /不得提供 humanQuestion/);

  // 5. result_intake decision 'complete' with object assignments rejected
  const completeWithObjAssignments = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "complete",
    brief: "All done",
    assignments: { key: "val" },
  }));
  assert.equal(completeWithObjAssignments.ok, false);
  assert.match(completeWithObjAssignments.error, /assignments.*必须为数组/);

  // 6. result_intake decision 'needs_human' with object assignments rejected
  const humanWithObjAssignments = parseRoleSubmission("planner", "result_intake", JSON.stringify({
    decision: "needs_human",
    brief: "Help needed",
    assignments: { key: "val" },
  }));
  assert.equal(humanWithObjAssignments.ok, false);
  assert.match(humanWithObjAssignments.error, /assignments.*必须为数组/);

  // 7. planning stage with humanQuestion when needsHuman is false rejected
  const planningQuestionWithoutNeedsHuman = parseRoleSubmission("planner", "planning", JSON.stringify({
    brief: "Plan with stray question",
    needsHuman: false,
    humanQuestion: "Is this correct?",
    assignments: [{ title: "T", instructions: "I" }],
  }));
  assert.equal(planningQuestionWithoutNeedsHuman.ok, false);
  assert.match(planningQuestionWithoutNeedsHuman.error, /未声明 needsHuman: true 时不得提供 humanQuestion/);
});

test("preview13: isPathSafe blocks NTFS ADS, reserved devices, and illegal Windows chars", () => {
  // NTFS Alternate Data Streams (colon)
  assert.equal(isPathSafe("safe.txt:secret"), false);
  assert.equal(isPathSafe("dir/safe.txt:secret"), false);

  // Reserved DOS devices
  assert.equal(isPathSafe("CON:stream"), false);
  assert.equal(isPathSafe("CONIN$"), false);
  assert.equal(isPathSafe("CONOUT$"), false);
  assert.equal(isPathSafe("CLOCK$"), false);
  assert.equal(isPathSafe("conin$"), false);
  assert.equal(isPathSafe("NUL.txt"), false);
  assert.equal(isPathSafe("sub/COM1.dat"), false);
  assert.equal(isPathSafe("LPT1"), false);

  // Windows illegal path characters
  assert.equal(isPathSafe("foo?.txt"), false);
  assert.equal(isPathSafe("foo*bar"), false);
  assert.equal(isPathSafe("foo<bar>"), false);
  assert.equal(isPathSafe("foo\"bar"), false);
  assert.equal(isPathSafe("foo|bar"), false);

  // Legitimate paths remain safe
  assert.equal(isPathSafe("valid/path/file.txt"), true);
  assert.equal(isPathSafe("src/components/Button.tsx"), true);
  assert.equal(isPathSafe("README.md"), true);
});

