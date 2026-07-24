const STORAGE_KEY = "dienstenlezer-busless-actions";

export const DEFAULT_BUSLESS_ACTIONS = [
  "REIS",
  "Rij mee",
  "Prep-in",
  "Rijklaarmaken",
] as const;

export function readBuslessActions(): string[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) {
      return [...DEFAULT_BUSLESS_ACTIONS];
    }
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? normaliseBuslessActions(parsed) : [...DEFAULT_BUSLESS_ACTIONS];
  } catch {
    return [...DEFAULT_BUSLESS_ACTIONS];
  }
}

export function writeBuslessActions(actions: string[]): string[] {
  const normalised = normaliseBuslessActions(actions);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalised));
  } catch {
    // De instelling blijft in deze sessie werken als browseropslag niet beschikbaar is.
  }
  return normalised;
}

export function matchesBuslessAction(raw: string, actions = readBuslessActions()): boolean {
  return actions.some((action) => {
    const words = action.trim().split(/[\s-]+/).filter(Boolean);
    if (words.length === 0) {
      return false;
    }
    const phrase = words.map(escapeRegExp).join("[\\s-]*");
    return new RegExp(`\\b${phrase}\\b`, "i").test(raw);
  });
}

export function normaliseBuslessActions(actions: unknown[]): string[] {
  const unique = new Map<string, string>();
  for (const action of actions) {
    if (typeof action !== "string") {
      continue;
    }
    const trimmed = action.trim().replace(/\s+/g, " ");
    if (trimmed) {
      unique.set(trimmed.toLocaleLowerCase("nl"), trimmed);
    }
  }
  return [...unique.values()];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
