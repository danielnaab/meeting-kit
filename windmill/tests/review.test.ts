// What the flows make of the runner's results (windmill/f/meeting_kit/shared/review.ts): which steps
// failed, which notices the owner should hear about, and the one alert and one error a run ends with.
import { describe, expect, test } from "bun:test";
import {
  deliver,
  failureMessage,
  isFailure,
  NOTICE_ALERT,
  noticeAlert,
  runnerNotices,
  workdayReview,
} from "../f/meeting_kit/shared/review.ts";

const err = (message: string, step_id?: string) => ({ error: { name: "ExecutionErr", message, ...(step_id ? { step_id } : {}) } });
const summary = (over: Record<string, unknown> = {}) => ({
  agent: "meeting-briefing", status: "pushed", created: ["notebook/records/meetings/2026-11/x-briefing.md"], cost: 0.1, output: null, ...over,
});

describe("a step's result", () => {
  test("a Windmill error is a failure, and so is a runner summary that says failed", () => {
    expect(isFailure(err("exit code 1"))).toBe(true);
    expect(isFailure(summary({ status: "failed", error: "model failed" }))).toBe(true);
  });
  test("a summary, null, a list and nothing are not failures", () => {
    for (const r of [summary(), summary({ status: "nothing-to-do" }), null, undefined, [], "x"]) expect(isFailure(r)).toBe(false);
  });
  test("the message keeps the log lines on one line, and is bounded", () => {
    expect(failureMessage(err("exit code 1, last log lines:\nmeeting-kit: meeting-briefing failed: push rejected"))).toBe(
      "exit code 1, last log lines: / meeting-kit: meeting-briefing failed: push rejected",
    );
    expect(failureMessage(summary({ status: "failed", error: "model failed" }))).toBe("model failed");
    expect(failureMessage(err("x".repeat(1000))).length).toBeLessThanOrEqual(300);
  });
  test("notices are the summary's strings, and nothing else", () => {
    expect(runnerNotices(summary({ notices: ["a", "b"] }))).toEqual(["a", "b"]);
    expect(runnerNotices(summary({ notices: ["a", 3, "", null] }))).toEqual(["a"]);
    for (const r of [summary(), err("x"), null, undefined, { notices: "a" }]) expect(runnerNotices(r)).toEqual([]);
  });
});

describe("the workday review", () => {
  const gate = { date: "2026-11-09", meetings: [{ uid: "u1" }], dropped: [] };

  test("a quiet day: no meetings, so no triage and an empty loop", () => {
    expect(workdayReview({ date: "d", meetings: [] }, null, [])).toEqual({ briefings: 0, problems: [], notices: [] });
    expect(workdayReview({ date: "d", meetings: [] }, undefined, undefined)).toEqual({ briefings: 0, problems: [], notices: [] });
  });
  test("a good day", () => {
    const triage = summary({ agent: "meeting-triage", status: "no-changes", output: { meetings: [{}], skipped: [] } });
    expect(workdayReview(gate, triage, [summary()])).toEqual({ briefings: 1, problems: [], notices: [] });
  });
  test("a meeting already briefed is fine", () => {
    expect(workdayReview(gate, summary(), [summary({ status: "nothing-to-do" })]).problems).toEqual([]);
  });
  test("a failed gate", () => {
    expect(workdayReview(err("HTTP 502"), null, []).problems).toEqual(["calendar gate failed: HTTP 502"]);
  });
  test("a failed triage", () => {
    expect(workdayReview(gate, err("exit code 1"), []).problems).toEqual(["triage failed: exit code 1"]);
  });
  test("one failed briefing among several, named", () => {
    expect(workdayReview(gate, summary(), [summary(), err("stopped at 25m")]).problems).toEqual([
      "1 of 2 briefing runs failed: stopped at 25m",
    ]);
  });
  test("a failed gate is reported once, though the skipped triage carries its error", () => {
    const gateErr = err("Unable to connect", "calendar_gate");
    expect(workdayReview(gateErr, gateErr, []).problems).toEqual(["calendar gate failed: Unable to connect"]);
  });
  test("a skipped triage carries the gate's answer, which is not a failure", () => {
    const empty = { date: "d", meetings: [] };
    expect(workdayReview(empty, empty, []).problems).toEqual([]);
  });
  test("every failure at once", () => {
    expect(workdayReview(err("a"), err("b"), []).problems).toEqual(["calendar gate failed: a", "triage failed: b"]);
  });
  test("notices from the triage and every briefing, failed runs or not", () => {
    const review = workdayReview(gate, summary({ notices: ["t"] }), [summary({ notices: ["b1"] }), err("x"), summary({ notices: ["b2", "b3"] })]);
    expect(review.notices).toEqual(["t", "b1", "b2", "b3"]);
    expect(review.problems).toHaveLength(1);
  });
});

describe("the notice alert", () => {
  test("nothing to say, no alert", () => {
    expect(noticeAlert([], "f/example_vault/meeting_synthesis/tick", "j1")).toBeNull();
  });
  test("one alert carries every notice, labelled by flow and job so two runs never merge", () => {
    const alert = noticeAlert(["first", "second"], "f/example_vault/meeting_synthesis/tick", "j1")!;
    expect(alert.name).toBe(NOTICE_ALERT);
    expect(alert.severity).toBe("warning");
    expect(alert.summary).toBe("Meeting agents: 2 notices from f/example_vault/meeting_synthesis/tick");
    expect(alert.description).toBe("- first\n- second");
    expect(alert.labels).toEqual({ flow: "f/example_vault/meeting_synthesis/tick", job: "j1" });
  });
  test("one notice is the summary itself", () => {
    expect(noticeAlert(["Not synthesized: x"], "f/example_vault/meeting_synthesis/tick", undefined)!.summary).toBe(
      "Meeting agents: Not synthesized: x",
    );
  });
  test("a long description is cut, saying so", () => {
    const alert = noticeAlert(Array.from({ length: 50 }, (_, i) => `notice ${i} ${"x".repeat(100)}`), "f", "j")!;
    expect(alert.description.length).toBeLessThanOrEqual(2000);
    expect(alert.description.endsWith("(more in the run's result)")).toBe(true);
  });
});

describe("deliver", () => {
  const sent: unknown[][] = [];
  const send = async (...args: unknown[]) => void sent.push(args);

  test("sends the notices, then throws the problems", async () => {
    sent.length = 0;
    await expect(deliver({ problems: ["triage failed: x"], notices: ["n"] }, "f/flow", "j", send)).rejects.toThrow("triage failed: x");
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(NOTICE_ALERT);
  });
  test("quiet: nothing sent, nothing thrown", async () => {
    sent.length = 0;
    expect(await deliver({ problems: [], notices: [] }, "f/flow", "j", send)).toEqual({ notices: 0 });
    expect(sent).toHaveLength(0);
  });
  test("an alert that can't be sent fails the run, with the problems and the notices in the error", async () => {
    const broken = async () => {
      throw new Error("HTTP 503");
    };
    await expect(deliver({ problems: ["p"], notices: ["n"] }, "f/flow", "j", broken)).rejects.toThrow(
      "p; could not send 1 notice (HTTP 503): n",
    );
  });
});
