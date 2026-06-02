import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  IGNORED_ACTIONS,
  verifySignature,
  isFilteredBotEvent,
  normalizeGithubEvent,
} from "../src/webhook.js";

/**
 * Phase 0 safety net — GitHub webhook signature verification, bot/ignore
 * filtering, and payload → EventEnvelope normalization. These are pure
 * functions (no env, no network); they pin the contract before the connector
 * logic moves into @nearform/mac-github (Phase 3).
 */

const SECRET = "test-webhook-secret";

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifySignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = sign(body);
    expect(verifySignature(body + "x", sig, SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const body = "payload";
    expect(verifySignature(body, sign(body, "other"), SECRET)).toBe(false);
  });

  it("returns false (does not throw) on a malformed signature of different length", () => {
    const body = "payload";
    expect(verifySignature(body, "sha256=deadbeef", SECRET)).toBe(false);
  });
});

describe("IGNORED_ACTIONS", () => {
  it("includes the noisy actions", () => {
    for (const a of ["deleted", "edited", "labeled", "closed", "assigned", "locked"]) {
      expect(IGNORED_ACTIONS.has(a)).toBe(true);
    }
  });

  it("does NOT include synchronize (the canonical fresh-review trigger)", () => {
    expect(IGNORED_ACTIONS.has("synchronize")).toBe(false);
    expect(IGNORED_ACTIONS.has("opened")).toBe(false);
    expect(IGNORED_ACTIONS.has("created")).toBe(false);
  });
});

describe("isFilteredBotEvent", () => {
  const BOT = "mac";

  it("filters a comment from the configured bot login", () => {
    const payload = { sender: { login: BOT, type: "User" } };
    expect(isFilteredBotEvent(payload, "issue_comment", "created", BOT)).toBe(true);
  });

  it("filters a sender whose type is Bot", () => {
    const payload = { sender: { login: "anything", type: "Bot" } };
    expect(isFilteredBotEvent(payload, "issue_comment", "created", BOT)).toBe(true);
  });

  it("filters any *[bot] sender login", () => {
    const payload = { sender: { login: "dependabot[bot]", type: "User" } };
    expect(isFilteredBotEvent(payload, "issue_comment", "created", BOT)).toBe(true);
  });

  it("does NOT filter a human sender", () => {
    const payload = { sender: { login: "alice", type: "User" } };
    expect(isFilteredBotEvent(payload, "issue_comment", "created", BOT)).toBe(false);
  });

  it("does NOT filter a bot's own PR opened/synchronize/reopened (PR attention)", () => {
    const payload = { sender: { login: BOT, type: "Bot" } };
    expect(isFilteredBotEvent(payload, "pull_request", "opened", BOT)).toBe(false);
    expect(isFilteredBotEvent(payload, "pull_request", "synchronize", BOT)).toBe(false);
    expect(isFilteredBotEvent(payload, "pull_request", "reopened", BOT)).toBe(false);
  });

  it("DOES filter a bot's PR closed (not an attention action)", () => {
    const payload = { sender: { login: BOT, type: "Bot" } };
    expect(isFilteredBotEvent(payload, "pull_request", "closed", BOT)).toBe(true);
  });
});

describe("normalizeGithubEvent", () => {
  const reply = vi.fn(async () => {});

  function base(extra: Record<string, unknown>) {
    return {
      repository: { full_name: "acme/widgets" },
      sender: { login: "alice" },
      ...extra,
    };
  }

  it("maps issues.opened → issue.opened with fields", () => {
    const env = normalizeGithubEvent(
      "issues",
      "opened",
      base({
        issue: {
          number: 7,
          body: "the body",
          title: "the title",
          labels: [{ name: "bug" }, { name: "p1" }],
          author_association: "OWNER",
        },
      }),
      "delivery-1",
      reply,
    );
    expect(env).not.toBeNull();
    expect(env!.type).toBe("issue.opened");
    expect(env!.source).toBe("github");
    expect(env!.repo).toBe("acme/widgets");
    expect(env!.issueNumber).toBe(7);
    expect(env!.title).toBe("the title");
    expect(env!.body).toBe("the body");
    expect(env!.labels).toEqual(["bug", "p1"]);
    expect(env!.authorAssociation).toBe("OWNER");
    expect(env!.id).toBe("delivery-1");
    expect(env!.senderIsBot).toBe(false);
  });

  it("maps issues.reopened → issue.reopened", () => {
    const env = normalizeGithubEvent("issues", "reopened", base({ issue: { number: 1 } }), "d", reply);
    expect(env!.type).toBe("issue.reopened");
  });

  it("maps pull_request opened/synchronize/reopened and sets prNumber+issueNumber", () => {
    for (const [action, type] of [
      ["opened", "pr.opened"],
      ["synchronize", "pr.synchronize"],
      ["reopened", "pr.reopened"],
    ] as const) {
      const env = normalizeGithubEvent(
        "pull_request",
        action,
        base({ pull_request: { number: 42, body: "b", title: "t", labels: [] } }),
        "d",
        reply,
      );
      expect(env!.type).toBe(type);
      expect(env!.prNumber).toBe(42);
      expect(env!.issueNumber).toBe(42);
    }
  });

  it("maps issue_comment.created → comment.created; sets prNumber when issue is a PR", () => {
    const onIssue = normalizeGithubEvent(
      "issue_comment",
      "created",
      base({ issue: { number: 5, labels: [{ name: "security-scan" }] }, comment: { body: "hi", author_association: "MEMBER" } }),
      "d",
      reply,
    );
    expect(onIssue!.type).toBe("comment.created");
    expect(onIssue!.issueNumber).toBe(5);
    expect(onIssue!.prNumber).toBeUndefined();
    expect(onIssue!.labels).toEqual(["security-scan"]);
    expect(onIssue!.authorAssociation).toBe("MEMBER");

    const onPr = normalizeGithubEvent(
      "issue_comment",
      "created",
      base({ issue: { number: 9, pull_request: { url: "x" } }, comment: { body: "c" } }),
      "d",
      reply,
    );
    expect(onPr!.prNumber).toBe(9);
  });

  it("maps pull_request_review.submitted and pull_request_review_comment.created", () => {
    const review = normalizeGithubEvent(
      "pull_request_review",
      "submitted",
      base({ pull_request: { number: 3 }, review: { body: "lgtm" } }),
      "d",
      reply,
    );
    expect(review!.type).toBe("pr_review.submitted");
    expect(review!.prNumber).toBe(3);

    const comment = normalizeGithubEvent(
      "pull_request_review_comment",
      "created",
      base({ pull_request: { number: 3 }, comment: { body: "nit" } }),
      "d",
      reply,
    );
    expect(comment!.type).toBe("pr_review_comment.created");
  });

  it("returns null for unmapped event/action combinations", () => {
    expect(normalizeGithubEvent("issues", "labeled", base({ issue: { number: 1 } }), "d", reply)).toBeNull();
    expect(normalizeGithubEvent("push", undefined, base({}), "d", reply)).toBeNull();
  });

  it("builds a reply closure that calls the provided reply with owner/repo/number", async () => {
    const captured = vi.fn(async () => {});
    const env = normalizeGithubEvent(
      "issues",
      "opened",
      base({ issue: { number: 11 } }),
      "d",
      captured,
    );
    await env!.reply("hello");
    expect(captured).toHaveBeenCalledWith("acme", "widgets", 11, "hello");
  });
});
