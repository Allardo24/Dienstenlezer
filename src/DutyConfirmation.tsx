import { useEffect, useState } from "react";
import { Check, ClipboardCheck } from "lucide-react";
import { confirmDuty, listDuties } from "./personalData";
import type { Dienst } from "./types";

export default function DutyConfirmation({
  service,
  operationalDate,
  dutyFinished,
}: {
  service: Dienst;
  operationalDate: string;
  dutyFinished: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void listDuties()
      .then((duties) => {
        if (!cancelled) {
          setConfirmed(duties.some((duty) => duty.operationalDate === operationalDate
            && duty.sourceFileId === service.sourceFileId
            && duty.serviceNumber.toLowerCase() === service.serviceNumber.toLowerCase()));
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [operationalDate, service.serviceNumber, service.sourceFileId]);

  async function confirm() {
    if (!service.sourceFileId) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await confirmDuty({ operationalDate, sourceFileId: service.sourceFileId, serviceNumber: service.serviceNumber, origin: "guidance" });
      setConfirmed(true);
      setMessage("Deze dienst telt nu mee voor je statistieken en achievements.");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text.includes("al bevestigd")) setConfirmed(true);
      else setMessage(text);
    } finally {
      setBusy(false);
    }
  }

  if (confirmed) return null;

  return (
    <section className="duty-confirmation">
      <span className="duty-confirmation-icon"><ClipboardCheck size={20} /></span>
      <div>
        <strong>{dutyFinished ? "Heb je deze dienst gereden?" : "Werkelijk gereden dienst"}</strong>
        <span>Alleen bevestigde diensten tellen mee. Je kunt dit later weer verwijderen.</span>
        {message && <small role="status">{message}</small>}
      </div>
      <button className="secondary-button" type="button" disabled={busy || !service.sourceFileId} onClick={() => void confirm()}>
        <Check size={17} /> {busy ? "Controleren..." : "Ik heb deze gereden"}
      </button>
    </section>
  );
}
