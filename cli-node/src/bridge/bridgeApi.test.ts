import { expect, mock, test } from "bun:test";

const posts: unknown[] = [];
mock.module("axios", () => ({
  default: {
    post: async (_url: string, body: unknown) => {
      posts.push(body);
      return {
        status: 200,
        data: { environment_id: "env", environment_secret: "secret" },
      };
    },
  },
}));

test("bridge registration attaches the official client version and no invented hash", async () => {
  const { createBridgeApiClient } = await import("./bridgeApi.ts");
  const api = createBridgeApiClient({
    baseUrl: "https://bridge.example",
    getAccessToken: () => "token",
    runnerVersion: "2.1.296",
  });
  await api.registerBridgeEnvironment({
    dir: "/work",
    machineName: "machine",
    branch: "main",
    gitRepoUrl: null,
    maxSessions: 1,
    spawnMode: "single-session",
    verbose: false,
    sandbox: false,
    bridgeId: "bridge",
    workerType: "claude_code",
    environmentId: "environment",
    apiBaseUrl: "https://bridge.example",
    sessionIngressUrl: "https://bridge.example",
  });
  const body = posts[0] as { metadata: Record<string, unknown> };
  expect(body.metadata).toEqual({
    worker_type: "claude_code",
    tool_host_cc_version: "2.1.296",
  });
  expect(Object.keys(body.metadata)).not.toContain("git_sha");
  expect(Object.keys(body.metadata)).not.toContain("sha");
});
