import { describe, expect, it } from "vitest";
import { appendAchievementCondition, parseAchievementJson } from "./PersonalDataPanel";
import type { AchievementCondition } from "./personalData";

const metric = (name: "dutyCount" | "pauseMinutes"): AchievementCondition => ({
  kind: "metric",
  metric: name,
  lines: [],
  comparison: "gte",
  value: 1,
});

describe("achievement JSON", () => {
  it("leest geneste EN- en OF-groepen zonder vertaallaag", () => {
    const input = parseAchievementJson(JSON.stringify({
      id: "complex",
      title: "Complex",
      description: "Een complexe regel.",
      badge: "C",
      enabled: false,
      condition: {
        kind: "group",
        operator: "all",
        conditions: [
          metric("dutyCount"),
          { kind: "group", operator: "any", conditions: [metric("pauseMinutes")] },
        ],
      },
    }));

    expect(input.condition).toMatchObject({ kind: "group", operator: "all" });
  });

  it("weigert onbekende statistieken", () => {
    expect(() => parseAchievementJson(JSON.stringify({
      id: "fout",
      title: "Fout",
      description: "Ongeldige regel.",
      badge: "F",
      enabled: false,
      condition: { kind: "metric", metric: "bestaatNiet", lines: [], comparison: "gte", value: 1 },
    }))).toThrow("metric is onbekend");
  });

  it("voegt dezelfde groep samen en maakt voor een andere operator een nieuwe groep", () => {
    const all = appendAchievementCondition(metric("dutyCount"), metric("pauseMinutes"), "all");
    const extended = appendAchievementCondition(all, metric("dutyCount"), "all");
    const wrapped = appendAchievementCondition(extended, metric("pauseMinutes"), "any");

    expect(extended).toMatchObject({ kind: "group", operator: "all" });
    expect(extended.kind === "group" && extended.conditions).toHaveLength(3);
    expect(wrapped).toMatchObject({ kind: "group", operator: "any" });
    expect(wrapped.kind === "group" && wrapped.conditions).toHaveLength(2);
  });
});
