import { useEffect, useState } from "react";
import { Award, ChevronDown, ChevronLeft, ChevronRight, Download, Plus, Trash2, X } from "lucide-react";
import { listAdminAccounts, type Account } from "./auth";
import {
  deleteAchievementDefinition,
  deleteDuty,
  exportDuties,
  getAccountAchievements,
  getAchievementProgress,
  getEarnedAchievements,
  getPersonalStatistics,
  listAchievementDefinitions,
  listDuties,
  revokeAccountAchievement,
  revokeAchievementForAll,
  saveAchievement,
  type AchievementDefinition,
  type AchievementProgress,
  type DutyRecord,
  type DutyExportRow,
  type EarnedAchievement,
  type PersonalStatistics,
} from "./personalData";
import type { Division } from "./types";

export function PersonalDataPanel() {
  const dutiesPerPage = 5;
  const [duties, setDuties] = useState<DutyRecord[]>([]);
  const [dutyPage, setDutyPage] = useState(1);
  const [statistics, setStatistics] = useState<PersonalStatistics>();
  const [achievements, setAchievements] = useState<EarnedAchievement[]>([]);
  const [achievementProgress, setAchievementProgress] = useState<AchievementProgress[]>([]);
  const [error, setError] = useState<string>();
  const [exporting, setExporting] = useState(false);

  async function reload() {
    try {
      setError(undefined);
      const [nextDuties, nextStatistics, nextAchievements, nextProgress] = await Promise.all([
        listDuties(), getPersonalStatistics(), getEarnedAchievements(), getAchievementProgress(),
      ]);
      setDuties(nextDuties);
      setStatistics(nextStatistics);
      setAchievements(nextAchievements);
      setAchievementProgress(nextProgress);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  useEffect(() => { void reload(); }, []);

  const dutyPageCount = Math.max(1, Math.ceil(duties.length / dutiesPerPage));
  const currentDutyPage = Math.min(dutyPage, dutyPageCount);
  const visibleDuties = duties.slice(
    (currentDutyPage - 1) * dutiesPerPage,
    currentDutyPage * dutiesPerPage,
  );

  useEffect(() => {
    setDutyPage((current) => Math.min(current, dutyPageCount));
  }, [dutyPageCount]);

  async function remove(duty: DutyRecord) {
    if (!window.confirm(`Dienst ${duty.serviceNumber} op ${formatDate(duty.operationalDate)} verwijderen?`)) return;
    try {
      await deleteDuty(duty.id);
      await reload();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  async function downloadDuties() {
    try {
      setExporting(true);
      setError(undefined);
      const rows = await exportDuties();
      downloadText("dienstenlezer-gereden-diensten.csv", dutiesToCsv(rows));
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="personal-data-grid">
      <section className="account-card personal-statistics">
        <h3>Statistieken</h3>
        {statistics ? (
          <>
            <dl className="statistics-summary">
              <div><dt>Diensten</dt><dd>{statistics.dutyCount}</dd></div>
              <div><dt>Lijnminuten</dt><dd>{formatMinutes(statistics.totalLineMinutes)}</dd></div>
              <div><dt>Pauze</dt><dd>{formatMinutes(statistics.pauseMinutes)}</dd></div>
              <div><dt>Materieel</dt><dd>{formatMinutes(statistics.materialMinutes)}</dd></div>
              <div><dt>Unieke lijnen</dt><dd>{statistics.uniqueLines}</dd></div>
            </dl>
            {statistics.lineMinutes.length > 0 && (
              <details className="line-statistics-details">
                <summary>
                  <span>Minuten per lijn ({statistics.lineMinutes.length})</span>
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <div className="line-statistics">
                  {statistics.lineMinutes.map((line) => (
                    <span key={`${line.divisionId}:${line.lineNumber}`}>
                      L{line.lineNumber}{line.divisionId ? ` · ${line.divisionId}` : ""} <strong>{formatMinutes(line.minutes)}</strong>
                    </span>
                  ))}
                </div>
              </details>
            )}
            {statistics.materialTypeMinutes.length > 0 && (
              <details className="line-statistics-details">
                <summary>
                  <span>Minuten per materieelsoort ({statistics.materialTypeMinutes.length})</span>
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <div className="line-statistics">
                  {statistics.materialTypeMinutes.map((material) => (
                    <span key={material.materialType}>
                      {material.materialType} <strong>{formatMinutes(material.minutes)}</strong>
                    </span>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : <p>Nog geen bevestigde diensten.</p>}
      </section>

      <section className="account-card achievements-card">
        <h3>Achievements</h3>
        {achievements.length === 0 ? <p>Nog geen badges behaald.</p> : (
          <ul className="achievement-list">
            {achievements.map((achievement) => (
              <li key={achievement.id}><span className="achievement-badge"><Award size={18} /> {achievement.badge}</span><div><strong>{achievement.title}</strong><span>{achievement.description}</span></div></li>
            ))}
          </ul>
        )}
        <details className="unearned-achievements">
          <summary>
            <span>Nog niet behaald</span>
            <span className="unearned-achievement-count">{achievementProgress.length}</span>
            <ChevronDown size={18} aria-hidden="true" />
          </summary>
          {achievementProgress.length === 0 ? <p className="unearned-achievements-empty">Geen actieve achievements om te behalen.</p> : (
            <ul className="unearned-achievement-list">
              {achievementProgress.map((achievement) => {
                const percentage = progressPercentage(achievement.current, achievement.target);
                return (
                  <li key={achievement.id}>
                    <span className="achievement-badge unearned-badge"><Award size={18} /> {achievement.badge}</span>
                    <div className="unearned-achievement-content">
                      <strong>{achievement.title}</strong>
                      <span>{achievement.description}</span>
                      <div className="achievement-progress-label">
                        <span>{formatAchievementProgress(achievement.current, achievement.unit)} / {formatAchievementProgress(achievement.target, achievement.unit)}</span>
                        <span>{percentage}%</span>
                      </div>
                      <progress max="100" value={percentage} aria-label={`Voortgang voor ${achievement.title}: ${percentage}%`} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </details>
      </section>

      <section className="account-card duty-history-card">
        <div className="duty-history-heading">
          <h3>Gereden diensten</h3>
          {duties.length > 0 && <button className="secondary-button" type="button" onClick={() => void downloadDuties()} disabled={exporting}>
            <Download size={17} /> {exporting ? "Voorbereiden..." : "Gegevens downloaden"}
          </button>}
        </div>
        {duties.length === 0 ? <p>Bevestig een gereden dienst vanuit Dienstbegeleiding.</p> : (
          <>
            <ul className="duty-history-list">
              {visibleDuties.map((duty) => (
                <li key={duty.id}>
                  <div><strong>{duty.serviceNumber}</strong><span>{formatDate(duty.operationalDate)} · {formatOperationalMinute(duty.startMinute)}-{formatOperationalMinute(duty.endMinute)}</span></div>
                  <button className="icon-button danger" type="button" title="Registratie verwijderen" onClick={() => void remove(duty)}><Trash2 size={17} /></button>
                </li>
              ))}
            </ul>
            {dutyPageCount > 1 && (
              <nav className="duty-history-pagination" aria-label="Pagina's met gereden diensten">
                <button
                  className="icon-button"
                  type="button"
                  title="Vorige pagina"
                  aria-label="Vorige pagina"
                  disabled={currentDutyPage === 1}
                  onClick={() => setDutyPage((current) => Math.max(1, current - 1))}
                >
                  <ChevronLeft size={18} />
                </button>
                <span>Pagina {currentDutyPage} van {dutyPageCount}</span>
                <button
                  className="icon-button"
                  type="button"
                  title="Volgende pagina"
                  aria-label="Volgende pagina"
                  disabled={currentDutyPage === dutyPageCount}
                  onClick={() => setDutyPage((current) => Math.min(dutyPageCount, current + 1))}
                >
                  <ChevronRight size={18} />
                </button>
              </nav>
            )}
          </>
        )}
      </section>
      {error && <p className="account-error" role="alert">{error}</p>}
    </div>
  );
}

export function AchievementManagement({ divisions }: { divisions: Division[] }) {
  const [definitions, setDefinitions] = useState<AchievementDefinition[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [badge, setBadge] = useState("");
  const [metric, setMetric] = useState<AchievementMetric>("totalMinutes");
  const [lines, setLines] = useState<string[]>([]);
  const [lineDraft, setLineDraft] = useState("");
  const [materialTypes, setMaterialTypes] = useState<string[]>([]);
  const [materialDraft, setMaterialDraft] = useState("");
  const [divisionId, setDivisionId] = useState("");
  const [withinSingleDuty, setWithinSingleDuty] = useState(false);
  const [consecutive, setConsecutive] = useState(false);
  const [comparison, setComparison] = useState<"gt" | "gte" | "lt" | "lte" | "eq">("gte");
  const [value, setValue] = useState(100);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountAchievements, setAccountAchievements] = useState<EarnedAchievement[]>([]);
  const [error, setError] = useState<string>();

  async function reload() {
    try {
      const [nextDefinitions, nextAccounts] = await Promise.all([
        listAchievementDefinitions(), listAdminAccounts(),
      ]);
      setDefinitions(nextDefinitions);
      setAccounts(nextAccounts);
      setSelectedAccountId((current) => current || nextAccounts[0]?.id || "");
    }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); }
  }
  useEffect(() => { void reload(); }, []);

  useEffect(() => {
    if (!selectedAccountId) {
      setAccountAchievements([]);
      return;
    }
    void getAccountAchievements(selectedAccountId)
      .then(setAccountAchievements)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, [selectedAccountId]);

  const selectedLines = mergeAchievementLines(lines, parseAchievementLines(lineDraft));
  const selectedMaterialTypes = mergeAchievementValues(materialTypes, parseAchievementValues(materialDraft));
  const selectedDivision = divisions.find((division) => division.id === divisionId);
  const rulePreview = achievementRulePreview(
    metric,
    selectedLines,
    selectedMaterialTypes,
    selectedDivision?.name,
    withinSingleDuty,
    consecutive,
    comparison,
    value,
  );

  function addDraftLines() {
    const additions = parseAchievementLines(lineDraft);
    if (additions.length === 0) return;
    setLines((current) => mergeAchievementLines(current, additions));
    setLineDraft("");
  }

  function removeLine(lineToRemove: string) {
    setLines((current) => current.filter((line) => line !== lineToRemove));
  }

  function addDraftMaterialTypes() {
    const additions = parseAchievementValues(materialDraft);
    if (additions.length === 0) return;
    setMaterialTypes((current) => mergeAchievementValues(current, additions));
    setMaterialDraft("");
  }

  function removeMaterialType(typeToRemove: string) {
    setMaterialTypes((current) => current.filter((materialType) => materialType !== typeToRemove));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    if ((metric === "lineMinutes" || metric === "fullDutyLines") && selectedLines.length === 0) {
      setError("Voeg minimaal een lijn toe die voor deze achievement moet meetellen.");
      return;
    }
    if (metric === "fullDutyMaterial" && selectedMaterialTypes.length === 0) {
      setError("Voeg minimaal een materieelsoort toe voor een volledige materieeldienst.");
      return;
    }
    try {
      await saveAchievement({
        id: achievementId(title), title, description, badge: badge || "Badge", enabled: false,
        condition: {
          kind: "metric", metric, lines: ["lineMinutes", "fullDutyLines"].includes(metric) ? selectedLines : [],
          materialTypes: ["materialMinutes", "fullDutyMaterial"].includes(metric) ? selectedMaterialTypes : [],
          divisionId: divisionId || undefined,
          withinSingleDuty: !["dutyCount", "fullDutyMaterial", "fullDutyLines"].includes(metric) && withinSingleDuty,
          consecutive: ["fullDutyMaterial", "fullDutyLines"].includes(metric) && consecutive,
          comparison, value,
        },
      });
      setTitle(""); setDescription(""); setBadge(""); setLines([]); setLineDraft(""); setMaterialTypes([]); setMaterialDraft(""); setDivisionId(""); setWithinSingleDuty(false); setConsecutive(false);
      await reload();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : String(saveError)); }
  }

  async function toggle(definition: AchievementDefinition) {
    try {
      await saveAchievement({
        id: definition.id,
        title: definition.title,
        description: definition.description,
        badge: definition.badge,
        enabled: !definition.enabled,
        condition: definition.condition,
      });
      await reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }

  async function removeDefinition(definition: AchievementDefinition) {
    if (!window.confirm(`Achievement '${definition.title}' verwijderen? De regel deelt daarna niets nieuws meer uit; reeds behaalde exemplaren blijven behouden.`)) return;
    try {
      setError(undefined);
      await deleteAchievementDefinition(definition.id);
      await reload();
      if (selectedAccountId) setAccountAchievements(await getAccountAchievements(selectedAccountId));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  async function revokeForAll(definition: AchievementDefinition) {
    if (!window.confirm(`Achievement '${definition.title}' bij alle accounts terugtrekken? De achievementregel zelf blijft bestaan.`)) return;
    try {
      setError(undefined);
      await revokeAchievementForAll(definition.id);
      if (selectedAccountId) setAccountAchievements(await getAccountAchievements(selectedAccountId));
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : String(revokeError));
    }
  }

  async function revoke(achievement: EarnedAchievement) {
    const account = accounts.find((candidate) => candidate.id === selectedAccountId);
    if (!account || !window.confirm(`Achievement '${achievement.title}' bij ${account.username} intrekken?`)) return;
    try {
      await revokeAccountAchievement(account.id, achievement.id);
      setAccountAchievements(await getAccountAchievements(account.id));
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : String(revokeError));
    }
  }

  return (
    <section className="account-card achievement-management">
      <div><p className="eyebrow">Admin</p><h2>Achievements beheren</h2></div>
      <ul className="achievement-definition-list">
        {definitions.map((definition) => <li key={definition.id}>
          <div><strong>{definition.title}</strong><span>v{definition.version} · {definition.enabled ? "Actief" : "Uit"}</span></div>
          <div className="achievement-definition-actions">
            <button className="secondary-button" type="button" onClick={() => void toggle(definition)}>{definition.enabled ? "Uitschakelen" : "Inschakelen"}</button>
            <button className="secondary-button danger" type="button" onClick={() => void revokeForAll(definition)}>Bij iedereen intrekken</button>
            <button className="icon-button danger" type="button" title={`${definition.title} verwijderen`} onClick={() => void removeDefinition(definition)}><Trash2 size={17} /></button>
          </div>
        </li>)}
      </ul>
      <form className="achievement-form" onSubmit={submit}>
        <label><span>Titel</span><input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
        <label><span>Beschrijving</span><input value={description} onChange={(event) => setDescription(event.target.value)} required /></label>
        <label><span>Badge</span><input value={badge} onChange={(event) => setBadge(event.target.value)} placeholder="Bijv. 10K" /></label>
        <label><span>Statistiek</span><select value={metric} onChange={(event) => {
          const nextMetric = event.target.value as AchievementMetric;
          setMetric(nextMetric);
          setWithinSingleDuty(false);
          setConsecutive(false);
          if (nextMetric === "fullDutyMaterial" || nextMetric === "fullDutyLines") setValue(1);
        }}><option value="totalMinutes">Totaal lijnminuten</option><option value="lineMinutes">Minuten op lijnen</option><option value="fullDutyLines">Volledige dienst op gekozen lijnen</option><option value="pauseMinutes">Pauzeminuten</option><option value="materialMinutes">Minuten op materieelsoort</option><option value="fullDutyMaterial">Volledige dienst op materieelsoort</option><option value="dutyCount">Aantal diensten</option><option value="uniqueLines">Unieke lijnen</option></select></label>
        {(metric === "lineMinutes" || metric === "uniqueLines" || metric === "fullDutyMaterial" || metric === "fullDutyLines") && (
          <label><span>Divisie (optioneel)</span><select value={divisionId} onChange={(event) => setDivisionId(event.target.value)}><option value="">Alle divisies</option>{divisions.map((division) => <option key={division.id} value={division.id}>{division.name}</option>)}</select></label>
        )}
        {(metric === "lineMinutes" || metric === "fullDutyLines") && (
          <div className="achievement-lines-field">
            <span>Lijnen optellen</span>
            <div className="achievement-line-input">
              <input
                value={lineDraft}
                onChange={(event) => setLineDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addDraftLines();
                }}
                placeholder="Bijv. 20, 21"
                aria-label="Lijnen om op te tellen"
              />
              <button className="icon-button" type="button" title="Lijnen toevoegen" onClick={addDraftLines}><Plus size={17} /></button>
            </div>
            {lines.length > 0 && <div className="achievement-line-chips" aria-label="Geselecteerde lijnen">
              {lines.map((line) => <span key={line}>L{line}<button type="button" title={`Lijn ${line} verwijderen`} onClick={() => removeLine(line)}><X size={13} /></button></span>)}
            </div>}
            <small>{metric === "fullDutyLines" ? "Een dienst telt alleen als alle ritlijnen in deze lijst staan." : "De minuten van alle gekozen lijnen worden bij elkaar opgeteld."}</small>
          </div>
        )}
        {(metric === "materialMinutes" || metric === "fullDutyMaterial") && (
          <div className="achievement-lines-field">
            <span>Materieelsoorten</span>
            <div className="achievement-line-input">
              <input
                value={materialDraft}
                onChange={(event) => setMaterialDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addDraftMaterialTypes();
                }}
                placeholder="Bijv. Yutong 15m R-NET"
                aria-label="Materieelsoorten voor achievement"
              />
              <button className="icon-button" type="button" title="Materieelsoorten toevoegen" onClick={addDraftMaterialTypes}><Plus size={17} /></button>
            </div>
            {materialTypes.length > 0 && <div className="achievement-line-chips" aria-label="Geselecteerde materieelsoorten">
              {materialTypes.map((materialType) => <span key={materialType}>{materialType}<button type="button" title={`${materialType} verwijderen`} onClick={() => removeMaterialType(materialType)}><X size={13} /></button></span>)}
            </div>}
            <small>{metric === "fullDutyMaterial" ? "Alle bekende busritten van dezelfde dienst moeten op een gekozen materieelsoort zijn gereden." : "Leeg laten telt alle materieelminuten; gekozen soorten worden bij elkaar opgeteld."}</small>
          </div>
        )}
        {!["dutyCount", "fullDutyMaterial", "fullDutyLines"].includes(metric) && (
          <label className="achievement-single-duty-toggle">
            <input type="checkbox" checked={withinSingleDuty} onChange={(event) => setWithinSingleDuty(event.target.checked)} />
            <span>Moet binnen één dienst passen</span>
          </label>
        )}
        {(metric === "fullDutyMaterial" || metric === "fullDutyLines") && (
          <label className="achievement-single-duty-toggle">
            <input type="checkbox" checked={consecutive} onChange={(event) => setConsecutive(event.target.checked)} />
            <span>Moeten opeenvolgende gereden diensten zijn</span>
          </label>
        )}
        <label><span>Vergelijking</span><select value={comparison} onChange={(event) => setComparison(event.target.value as typeof comparison)}><option value="gte">Minimaal</option><option value="gt">Groter dan</option><option value="eq">Gelijk aan</option><option value="lte">Maximaal</option><option value="lt">Kleiner dan</option></select></label>
        <label><span>{metric === "fullDutyMaterial" || metric === "fullDutyLines" ? "Aantal volledige diensten" : "Waarde"}</span><input type="number" min="0" value={value} onChange={(event) => setValue(Number(event.target.value))} /></label>
        <div className="achievement-rule-preview">
          <span>Regelvoorbeeld</span>
          <strong>ALS {rulePreview}, DAN geef deze achievement.</strong>
        </div>
        <button className="secondary-button" type="submit"><Plus size={17} /> Achievement toevoegen</button>
      </form>
      <p className="settings-note">De server ondersteunt ook geneste EN/OF-regels; de eerste editor maakt bewust één duidelijke voorwaarde per badge.</p>
      <div className="achievement-correction">
        <div>
          <h3>Behaalde achievements corrigeren</h3>
          <p className="settings-note">Een behaalde badge blijft staan totdat een admin hem hier intrekt.</p>
        </div>
        <label>
          <span>Account</span>
          <select value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.username}</option>)}
          </select>
        </label>
        {selectedAccountId && accountAchievements.length === 0 ? <p>Dit account heeft nog geen achievements.</p> : (
          <ul className="achievement-definition-list">
            {accountAchievements.map((achievement) => (
              <li key={achievement.id}>
                <div><strong>{achievement.title}</strong><span>Behaald op {formatTimestamp(achievement.earnedAt)} · v{achievement.version}</span></div>
                <button className="secondary-button danger" type="button" onClick={() => void revoke(achievement)}>Intrekken</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="account-error" role="alert">{error}</p>}
    </section>
  );
}

function achievementId(title: string): string {
  return title.trim().toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `achievement-${Date.now()}`;
}

function parseAchievementLines(value: string): string[] {
  return value
    .split(/[,;+\s]+/)
    .map((line) => line.trim().replace(/^l(?=\d+$)/i, ""))
    .filter(Boolean);
}

function mergeAchievementLines(current: string[], additions: string[]): string[] {
  return [...new Set([...current, ...additions])];
}

type AchievementMetric = "totalMinutes" | "pauseMinutes" | "materialMinutes" | "dutyCount" | "uniqueLines" | "lineMinutes" | "fullDutyMaterial" | "fullDutyLines";

function parseAchievementValues(value: string): string[] {
  return value.split(/[,;]+/).map((item) => item.trim()).filter(Boolean);
}

function mergeAchievementValues(current: string[], additions: string[]): string[] {
  const values = new Map(current.map((item) => [item.toLocaleLowerCase("nl-NL"), item]));
  for (const item of additions) values.set(item.toLocaleLowerCase("nl-NL"), item);
  return [...values.values()];
}

function achievementRulePreview(
  metric: AchievementMetric,
  lines: string[],
  materialTypes: string[],
  divisionName: string | undefined,
  withinSingleDuty: boolean,
  consecutive: boolean,
  comparison: "gt" | "gte" | "lt" | "lte" | "eq",
  value: number,
): string {
  const comparisonText = { gt: "groter is dan", gte: "minimaal", lt: "kleiner is dan", lte: "maximaal", eq: "gelijk is aan" }[comparison];
  const scope = divisionName ? ` binnen divisie ${divisionName}` : "";
  const dutyScope = withinSingleDuty ? " binnen dezelfde dienst" : "";
  const materialLabel = materialTypes.length > 0 ? materialTypes.join(" + ") : "alle materieelsoorten";
  const subject = {
    totalMinutes: `het totaal aantal lijnminuten${dutyScope}`,
    pauseMinutes: `het aantal pauzeminuten${dutyScope}`,
    materialMinutes: `de minuten op ${materialLabel}${dutyScope}`,
    dutyCount: "het aantal gereden diensten",
    uniqueLines: `het aantal unieke lijnen${scope}${dutyScope}`,
    lineMinutes: lines.length > 0
      ? `de minuten van ${lines.map((line) => `L${line}`).join(" + ")}${scope}${dutyScope}`
      : `de minuten van de gekozen lijnen${scope}${dutyScope}`,
    fullDutyMaterial: `het aantal ${consecutive ? "opeenvolgende " : ""}volledige diensten op ${materialLabel}${scope}`,
    fullDutyLines: `het aantal ${consecutive ? "opeenvolgende " : ""}volledige diensten met alleen ${lines.map((line) => `L${line}`).join(" + ")}${scope}`,
  }[metric];
  return `${subject} ${comparisonText} ${value}`;
}
function formatDate(value: string): string { return new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium" }).format(new Date(`${value}T12:00:00`)); }
function formatMinutes(value: number): string { return value < 60 ? `${value} min` : `${Math.floor(value / 60)}u ${value % 60}m`; }
function formatAchievementProgress(value: number, unit: AchievementProgress["unit"]): string {
  return unit === "min" ? formatMinutes(value) : `${value} ${unit}`;
}
function progressPercentage(current: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / target) * 100)));
}
function formatOperationalMinute(value: number): string { const minute = ((value % 1440) + 1440) % 1440; return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`; }
function formatTimestamp(value: number): string { return new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value * 1000)); }

function dutiesToCsv(rows: DutyExportRow[]): string {
  const headers = ["datum", "divisie", "dienst", "dienst_start", "dienst_eind", "bron", "bevestigd_op", "volgorde", "actie", "materieelsoort", "lijn", "rit", "actie_start", "actie_eind", "duur_minuten", "onbetaald", "bron_beweging", "bron_bestand"];
  const values = rows.map((row) => [
    row.operationalDate,
    row.divisionId,
    row.serviceNumber,
    formatOperationalMinute(row.dutyStartMinute),
    formatOperationalMinute(row.dutyEndMinute),
    row.origin,
    formatTimestamp(row.confirmedAt),
    row.segmentSequence ?? "",
    row.movementType ?? "",
    row.materialType ?? "",
    row.lineNumber ?? "",
    row.tripNumber ?? "",
    row.segmentStartMinute === undefined ? "" : formatOperationalMinute(row.segmentStartMinute),
    row.segmentEndMinute === undefined ? "" : formatOperationalMinute(row.segmentEndMinute),
    row.durationMinutes ?? "",
    row.unpaid === undefined ? "" : row.unpaid ? "ja" : "nee",
    row.sourceMovementId ?? "",
    row.sourceFileId,
  ]);
  return [headers, ...values].map((row) => row.map(csvValue).join(";")).join("\r\n");
}

function csvValue(value: string | number): string {
  const text = String(value);
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadText(fileName: string, contents: string) {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
