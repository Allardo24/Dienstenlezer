import { useEffect, useState } from "react";
import { Save, Trash2 } from "lucide-react";
import type { WageSettings } from "./types";

export default function WageSettingsPanel({
  settings,
  onSave,
  onDelete,
}: {
  settings: WageSettings;
  onSave: (settings: WageSettings) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [hourlyRate, setHourlyRate] = useState(formatDecimal(settings.hourlyRateCents / 100));
  const [holidayAllowance, setHolidayAllowance] = useState(formatDecimal(settings.holidayAllowancePercent));
  const [vacationDaysAllowance, setVacationDaysAllowance] = useState(formatDecimal(settings.vacationDaysAllowancePercent));
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    setHourlyRate(formatDecimal(settings.hourlyRateCents / 100));
    setHolidayAllowance(formatDecimal(settings.holidayAllowancePercent));
    setVacationDaysAllowance(formatDecimal(settings.vacationDaysAllowancePercent));
  }, [settings]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(undefined);
    try {
      await onSave({
        hourlyRateCents: Math.round(parseDecimal(hourlyRate) * 100),
        holidayAllowancePercent: parseDecimal(holidayAllowance),
        vacationDaysAllowancePercent: parseDecimal(vacationDaysAllowance),
      });
      setMessage("Looninstellingen lokaal opgeslagen.");
    } catch {
      setMessage("Looninstellingen konden niet lokaal worden opgeslagen.");
    }
  }

  async function remove() {
    setMessage(undefined);
    try {
      await onDelete();
      setMessage("Lokale loongegevens gewist.");
    } catch {
      setMessage("Lokale loongegevens konden niet worden gewist.");
    }
  }

  return (
    <section className="settings-group wage-settings">
      <div className="settings-group-heading">
        <div>
          <h3>Loonindicatie</h3>
          <span>Deze bedragen blijven alleen in deze browser op dit apparaat staan.</span>
        </div>
      </div>
      <form className="wage-settings-form" onSubmit={submit}>
        <label>
          <span>Bruto uurloon</span>
          <div className="money-input"><span>EUR</span><input inputMode="decimal" value={hourlyRate} onChange={(event) => setHourlyRate(event.target.value)} aria-label="Bruto uurloon" /></div>
        </label>
        <label>
          <span>Vakantietoeslag</span>
          <div className="percentage-input"><input inputMode="decimal" value={holidayAllowance} onChange={(event) => setHolidayAllowance(event.target.value)} /><span>%</span></div>
        </label>
        <label>
          <span>Vakantiedagentoeslag</span>
          <div className="percentage-input"><input inputMode="decimal" value={vacationDaysAllowance} onChange={(event) => setVacationDaysAllowance(event.target.value)} /><span>%</span></div>
        </label>
        <div className="wage-settings-actions">
          <button className="secondary-button" type="submit"><Save size={17} /> Opslaan</button>
          <button className="secondary-button danger" type="button" onClick={() => void remove()}><Trash2 size={17} /> Lokale loongegevens wissen</button>
        </div>
      </form>
      <p className="settings-note">De hoofdweergave is een schatting van basisloon plus ORT, exclusief beide vakantietoeslagen.</p>
      {message && <p className="settings-save-message" role="status">{message}</p>}
    </section>
  );
}

function parseDecimal(value: string): number {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatDecimal(value: number): string {
  return value.toLocaleString("nl-NL", { maximumFractionDigits: 2, useGrouping: false });
}
