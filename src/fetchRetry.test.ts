import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./fetchRetry";

describe("fetchWithRetry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("herhaalt een mislukte leesaanvraag eenmaal", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("/api/schedules/weekday", undefined, { delayMs: 0 });

    expect(await response.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("verstuurt een schrijfactie nooit automatisch opnieuw", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithRetry("/api/files", { method: "POST" }, { delayMs: 0 })).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("herhaalt een tijdelijke gatewayfout", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("/api/qbuzz/live", undefined, { delayMs: 0 });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
