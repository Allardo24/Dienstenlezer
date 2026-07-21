import { afterEach, describe, expect, it, vi } from "vitest";
import { getCachedQbuzzLiveStatuses, getQbuzzLiveStatuses, plannedMarkerMinute } from "./live";

describe("plannedMarkerMinute", () => {
  it("plaatst +5 minuten vertraging vijf minuten links van de nu-lijn", () => {
    expect(plannedMarkerMinute(8 * 60, 5 * 60, 7 * 60, 8 * 60 + 30)).toBe(7 * 60 + 55);
  });

  it("plaatst -2 minuten vervroeging twee minuten rechts van de nu-lijn", () => {
    expect(plannedMarkerMinute(8 * 60, -2 * 60, 7 * 60, 8 * 60 + 30)).toBe(8 * 60 + 2);
  });

  it("markeert precies een minuut afwijking niet", () => {
    expect(plannedMarkerMinute(8 * 60, 60, 7 * 60, 8 * 60 + 30)).toBeUndefined();
    expect(plannedMarkerMinute(8 * 60, -60, 7 * 60, 8 * 60 + 30)).toBeUndefined();
  });

  it("houdt markeringen binnen het ritblok", () => {
    expect(plannedMarkerMinute(8 * 60, 20 * 60, 7 * 60 + 50, 8 * 60 + 10)).toBeUndefined();
  });
});

describe("web live-api", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stuurt in de webversie alleen de datum naar de serverbackend", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      location: { pathname: "/" },
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const responseBody = {
      statuses: [
        { movementId: "a", matched: true, delaySeconds: 120, vehicleId: "8123" },
        { movementId: "b", matched: true, delaySeconds: 120, vehicleId: "8123" },
      ],
      sync: { state: "ready", message: "Qbuzz live" },
      diagnostics: { requested: 2, matched: 2, vehicleUpdates: 2 },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await getQbuzzLiveStatuses("2026-07-12", [
      {
        movementId: "a",
        loopNumber: "806601",
        serviceNumber: "V6601",
        lineNumber: "3",
        tripNumber: "7001",
        departure: "07:51",
        arrival: "08:32",
        from: "LDN BRW",
        to: "LDD LEY",
        type: "rit",
      },
      {
        movementId: "b",
        loopNumber: "806601",
        serviceNumber: "V6601",
        lineNumber: "4",
        tripNumber: "7003",
        departure: "09:09",
        arrival: "09:44",
        from: "LDD LEY",
        to: "LDN BRW",
        type: "rit",
      },
    ]);

    expect(response.statuses).toHaveLength(2);
    expect(response.statuses[0].vehicleId).toBe(response.statuses[1].vehicleId);
    expect(response.diagnostics?.vehicleUpdates).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/qbuzz/live?date=2026-07-12",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("body");
    expect(getCachedQbuzzLiveStatuses("2026-07-12")?.response.statuses[0].vehicleId).toBe("8123");
  });
});
