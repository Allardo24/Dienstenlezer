import { accountRequest } from "./auth";
import type { Dienst, LiveStatusResponse, ParseResult } from "./types";

export type PersonalSchedule = { id: string; operationalDate: string; divisionId: string; parseResult: ParseResult };

export async function listPersonalSchedules(): Promise<PersonalSchedule[]> {
  return (await accountRequest("/api/me/personal-schedules", { cache: "no-store" })).json();
}

export async function savePersonalSchedule(parseResult: ParseResult, divisionId: string): Promise<PersonalSchedule> {
  return (await accountRequest("/api/me/personal-schedules", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parseResult, divisionId }),
  })).json();
}

export async function deletePersonalSchedule(id: string): Promise<void> {
  await accountRequest(`/api/me/personal-schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function personalScheduleLive(id: string): Promise<LiveStatusResponse> {
  return (await accountRequest(`/api/me/personal-schedules/${encodeURIComponent(id)}/live`, { cache: "no-store" })).json();
}

export function splitPersonalSchedules(results: ParseResult[]): ParseResult[] {
  return results.flatMap((result) => {
    if (result.warnings.length) throw new Error(result.warnings.join(" "));
    return result.diensten.map((service) => {
      if (!service.date || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(service.date) || service.serviceNumber.startsWith("pagina-")) {
        throw new Error("Dienstnummer of uitvoeringsdatum niet herkend. Er is niets opgeslagen.");
      }
      const movements = result.movements.filter((m) => m.pageNumber === service.pageNumber && m.dienstnummer === service.serviceNumber);
      if (!movements.length) throw new Error(`Geen ritregels gevonden voor ${service.serviceNumber}.`);
      return { fileName: "Persoonlijke dienst", diensten: [service], movements, warnings: [] };
    });
  });
}

export function suggestPersonalDivision(service: Dienst, known: Dienst[]): string {
  const depot = service.depot?.trim().toLocaleLowerCase("nl");
  if (!depot) return "";
  const matches = new Set(known.filter((s) => s.depot?.trim().toLocaleLowerCase("nl") === depot).map((s) => s.divisionId).filter(Boolean));
  return matches.size === 1 ? [...matches][0]! : "";
}
