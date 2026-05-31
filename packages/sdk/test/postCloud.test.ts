import { afterEach, describe, expect, it, vi } from "vitest";
import { postCloud } from "../src/capture-only.ts";

// Minimal IssueDraft stand-in — postCloud only reads draft.bundle and
// draft.bundle.userNote.
function draft(bundle: Record<string, unknown> = {}) {
  return {
    title: "t",
    body: "b",
    bundle: { userNote: null, ...bundle },
  } as never;
}

describe("postCloud — capture delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does NOT set keepalive (capture bundles exceed the 64 KiB keepalive cap)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await postCloud(
      { kind: "cloud", projectKey: "pk_test" },
      // a deliberately large bundle — well over 64 KiB — to mirror a
      // real screenshot-bearing capture.
      draft({ screenshot: "data:image/png;base64," + "A".repeat(200_000) }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://app.insitue.com/api/v1/capture");
    expect(init?.method).toBe("POST");
    // The whole point of the fix: keepalive must be absent/falsy so the
    // browser doesn't refuse the oversized body.
    expect(init?.keepalive ?? false).toBe(false);
    expect(
      (init?.headers as Record<string, string>)["x-insitue-key"],
    ).toBe("pk_test");
    expect(init?.credentials).toBe("omit");
    expect(String(init?.body).length).toBeGreaterThan(64 * 1024);
  });

  it("targets the custom endpoint when one is set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await postCloud(
      {
        kind: "cloud",
        projectKey: "pk_x",
        endpoint: "https://eu.example.com/api/v1/capture",
      },
      draft(),
    );
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://eu.example.com/api/v1/capture",
    );
  });

  it("swallows network errors (best-effort)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(
      postCloud({ kind: "cloud", projectKey: "pk_x" }, draft()),
    ).resolves.toBeUndefined();
  });
});
