import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatUrl, pingHeartbeat } from "../src/capture-only.ts";

describe("heartbeatUrl — derive from capture endpoint", () => {
  it("defaults to the cloud heartbeat URL when no endpoint override", () => {
    expect(heartbeatUrl(undefined)).toBe(
      "https://app.insitue.com/api/v1/heartbeat",
    );
  });

  it("swaps a trailing /capture for /heartbeat on a custom host", () => {
    expect(heartbeatUrl("https://eu.example.com/api/v1/capture")).toBe(
      "https://eu.example.com/api/v1/heartbeat",
    );
  });

  it("falls back to default when the endpoint isn't a /capture URL", () => {
    expect(heartbeatUrl("https://weird.example.com/ingest")).toBe(
      "https://app.insitue.com/api/v1/heartbeat",
    );
  });
});

describe("pingHeartbeat — fire-and-forget liveness ping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the key + sdk version to the heartbeat URL", () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    pingHeartbeat({ kind: "cloud", projectKey: "pk_test_123" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://app.insitue.com/api/v1/heartbeat");
    expect(init?.method).toBe("POST");
    expect(
      (init?.headers as Record<string, string>)["x-insitue-key"],
    ).toBe("pk_test_123");
    expect(init?.keepalive).toBe(true);
    const body = JSON.parse(String(init?.body));
    expect(body.projectKey).toBe("pk_test_123");
    expect(typeof body.sdkVersion).toBe("string");
  });

  it("targets the custom endpoint's host when one is set", () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    pingHeartbeat({
      kind: "cloud",
      projectKey: "pk_x",
      endpoint: "https://eu.example.com/api/v1/capture",
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://eu.example.com/api/v1/heartbeat",
    );
  });

  it("never throws when fetch rejects (best-effort)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("offline")),
    );
    expect(() =>
      pingHeartbeat({ kind: "cloud", projectKey: "pk_x" }),
    ).not.toThrow();
    // let the swallowed rejection settle
    await Promise.resolve();
  });
});
