import assert from "node:assert/strict";
import test from "node:test";
import { AgentHub } from "../../agent-hub/src/hub.mjs";
import { clientIpForRequest } from "../../agent-hub/src/client-ip.mjs";

test("login route ignores forwarded addresses from direct peers and uses configured proxy chains", { timeout: 15_000 }, async () => {
  const observedIps = [];
  const authService = {
    async login(username, _password, { clientIp }) {
      observedIps.push(clientIp);
      return {
        actor: { id: `user-${observedIps.length}`, username, role: "admin", status: "active" },
        csrfToken: "fixture-csrf",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        cookie: "a446_session=fixture; HttpOnly; Path=/",
        csrfCookie: "a446_csrf=fixture; Path=/",
      };
    },
  };
  const config = {
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 1_000,
    auth: { mode: "identity", required: true, trustedProxyIps: [] },
    logs: { includePayloads: false },
  };
  const hub = new AgentHub(config, { authService });
  await hub.start();

  try {
    await postLogin(hub.url(), "198.51.100.10");
    const directPeer = observedIps[0];
    assert.ok(directPeer === "127.0.0.1" || directPeer === "::ffff:127.0.0.1");

    config.auth.trustedProxyIps = ["10.0.0.0/8"];
    await postLogin(hub.url(), "203.0.113.20");
    assert.equal(observedIps[1], directPeer, "an untrusted socket peer cannot spoof X-Forwarded-For");

    config.auth.trustedProxyIps = ["127.0.0.1/32", "10.0.0.0/8"];
    await postLogin(hub.url(), "198.51.100.30, 10.1.2.3");
    assert.equal(observedIps[2], "198.51.100.30", "the resolver walks past trusted proxy hops from right to left");
  } finally {
    await hub.stop();
  }
});

test("trusted proxy matching supports IPv6 CIDRs and fails closed on malformed forwarding data", () => {
  const request = (remoteAddress, forwarded) => ({
    socket: { remoteAddress },
    headers: { "x-forwarded-for": forwarded },
  });

  assert.equal(
    clientIpForRequest(
      request("2001:db8:ffff::2", "2001:db8:1::5, 2001:db8:2::9"),
      { trustedProxyIps: ["2001:db8:ffff::2/128", "2001:db8:2::/48"] },
    ),
    "2001:db8:1::5",
  );
  assert.equal(
    clientIpForRequest(request("::ffff:127.0.0.1", "bad-address"), { trustedProxyIps: ["127.0.0.0/8"] }),
    "127.0.0.1",
  );
});

async function postLogin(baseUrl, forwardedFor) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify({ username: "fixture-user", password: "fixture-password" }),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
}
