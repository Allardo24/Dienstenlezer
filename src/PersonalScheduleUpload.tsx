import { useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { deletePersonalSchedule, savePersonalSchedule, splitPersonalSchedules, suggestPersonalDivision, type PersonalSchedule } from "./personalSchedules";
import type { Dienst, Division, ParseResult } from "./types";

export default function PersonalScheduleUpload({ schedules, divisions, knownServices, onChange }: {
  schedules: PersonalSchedule[]; divisions: Division[]; knownServices: Dienst[]; onChange: () => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<{ result: ParseResult; divisionId: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function read(files: File[]) {
    setBusy(true); setError(undefined);
    try {
      if (files.some((file) => !file.name.toLowerCase().endsWith(".pdf") || file.size > 20 * 1024 * 1024)) throw new Error("Kies PDF-bestanden van maximaal 20 MB.");
      const { parsePdfFiles } = await import("./pdfParser");
      const parsed = splitPersonalSchedules(await parsePdfFiles(files));
      if (!parsed.length) throw new Error("Geen diensten gevonden.");
      setDrafts(parsed.map((result) => ({ result, divisionId: suggestPersonalDivision(result.diensten[0], knownServices) })));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  async function save() {
    setBusy(true); setError(undefined);
    try {
      // Remove each successful draft immediately, so a partial failure can be retried safely.
      for (const draft of drafts) {
        await savePersonalSchedule(draft.result, draft.divisionId);
        setDrafts((current) => current.filter((item) => item !== draft));
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { await onChange(); setBusy(false); }
  }
  async function remove(schedule: PersonalSchedule) {
    if (!window.confirm(`Persoonlijke dienst ${schedule.parseResult.diensten[0].serviceNumber} verwijderen? Een bevestigde gereden dienst blijft bewaard.`)) return;
    setBusy(true); setError(undefined);
    try { await deletePersonalSchedule(schedule.id); await onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="settings-group personal-schedule-upload">
    <div className="settings-group-heading">
      <h3>Persoonlijke diensten</h3>
      <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => void read(Array.from(e.target.files ?? []))} />
      <button className="secondary-button" disabled={busy} onClick={() => input.current?.click()}><Upload size={17} />{busy ? "Verwerken..." : "Dienstblad uploaden"}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="personal-schedule-list">
      {schedules.map((schedule) => <div className="personal-schedule-chip" key={schedule.id}>
        <div><strong>{schedule.parseResult.diensten[0].serviceNumber}</strong><small>{schedule.operationalDate.split("-").reverse().join("-")}</small></div>
        <button className="icon-button" disabled={busy} title="Persoonlijke dienst verwijderen" aria-label={`Verwijder ${schedule.parseResult.diensten[0].serviceNumber}`} onClick={() => void remove(schedule)}><X size={16} /></button>
      </div>)}
    </div>
    {drafts.map((draft, index) => <div className="personal-schedule-draft" key={index}>
      <strong>{draft.result.diensten[0].serviceNumber}</strong>
      <span>{draft.result.diensten[0].date} · {draft.result.diensten[0].depot}</span>
      <label>Divisie<select value={draft.divisionId} disabled={busy} onChange={(e) => setDrafts((current) => current.map((d, i) => i === index ? { ...d, divisionId: e.target.value } : d))}>
        <option value="">Kies divisie</option>{divisions.map((division) => <option value={division.id} key={division.id}>{division.name}</option>)}
      </select></label>
      <button className="icon-button" title="Annuleren" aria-label="Upload annuleren" disabled={busy} onClick={() => setDrafts((current) => current.filter((_, i) => i !== index))}><X size={16} /></button>
    </div>)}
    {drafts.length > 0 && <button className="secondary-button" disabled={busy || drafts.some((d) => !d.divisionId)} onClick={() => void save()}>Dienstgegevens opslaan</button>}
  </section>;
}
