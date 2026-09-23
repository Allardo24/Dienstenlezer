import { useEffect, useState } from "react";
import { appConfig } from "./appConfig";
import { Award, Braces, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Download, Plus, Save, Trash2, X } from "lucide-react";
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
  type AchievementCondition,
  type AchievementDefinition,
  type AchievementProgress,
  type DutyRecord,
  type DutyExportRow,
  type EarnedAchievement,
  type PersonalStatistics,
} from "./personalData";
import type { Concession, Division } from "./types";

export function PersonalDataPanel() {
  const dutiesPerPage = appConfig.account.dutiesPerPage;
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
  const totalDutyMinutes = duties.reduce(
    (total, duty) => total + Math.max(0, duty.endMinute - duty.startMinute),
    0,
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
              <div><dt>Diensten</dt><dd className="duty-count-value">{statistics.dutyCount} ({formatMinutes(totalDutyMinutes)})</dd></div>
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

export function AchievementManagement({
  divisions,
  concessions,
}: {
  divisions: Division[];
  concessions: Concession[];
}) {
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
  const [depot, setDepot] = useState("");
  const [withinSingleDuty, setWithinSingleDuty] = useState(false);
  const [consecutive, setConsecutive] = useState(false);
  const [comparison, setComparison] = useState<"gt" | "gte" | "lt" | "lte" | "eq">("gte");
  const [value, setValue] = useState(100);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountAchievements, setAccountAchievements] = useState<EarnedAchievement[]>([]);
  const [error, setError] = useState<string>();
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  const [jsonDraft, setJsonDraft] = useState(() => achievementJsonTemplate());
  const [jsonError, setJsonError] = useState<string>();
  const [jsonMessage, setJsonMessage] = useState<string>();
  const [jsonJoinOperator, setJsonJoinOperator] = useState<"all" | "any">("all");

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
  const selectedScope = [achievementScopeLabel(divisionId || undefined, divisions, concessions), depot.trim() ? `van stalling ${depot.trim()}` : ""].filter(Boolean).join(" ");
  const rulePreview = achievementRulePreview(
    metric,
    selectedLines,
    selectedMaterialTypes,
    selectedScope,
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
          depot: depot.trim() || undefined,
          withinSingleDuty: !["dutyCount", "fullDutyMaterial", "fullDutyLines"].includes(metric) && withinSingleDuty,
          consecutive: ["fullDutyMaterial", "fullDutyLines"].includes(metric) && consecutive,
          comparison, value,
        },
      });
      setTitle(""); setDescription(""); setBadge(""); setLines([]); setLineDraft(""); setMaterialTypes([]); setMaterialDraft(""); setDivisionId(""); setDepot(""); setWithinSingleDuty(false); setConsecutive(false);
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

  function loadDefinitionInJsonEditor(definition: AchievementDefinition) {
    setJsonDraft(formatAchievementJson(definition));
    setJsonError(undefined);
    setJsonMessage(`${definition.title} geladen.`);
    setJsonEditorOpen(true);
  }

  function loadJsonExample() {
    setJsonDraft(achievementJsonTemplate());
    setJsonError(undefined);
    setJsonMessage(undefined);
  }

  function validateJsonDraft() {
    try {
      const input = parseAchievementJson(jsonDraft);
      setJsonError(undefined);
      setJsonMessage(`Geldige regel: ALS ${achievementConditionPreview(input.condition, divisions, concessions)}.`);
    } catch (validationError) {
      setJsonMessage(undefined);
      setJsonError(validationError instanceof Error ? validationError.message : String(validationError));
    }
  }

  function addJsonMetric(metric: AchievementMetric) {
    try {
      const input = parseAchievementJson(jsonDraft);
      const addition = achievementMetricConditionTemplate(metric);
      const condition = appendAchievementCondition(input.condition, addition, jsonJoinOperator);
      const option = ACHIEVEMENT_METRIC_OPTIONS.find((candidate) => candidate.id === metric);
      setJsonDraft(JSON.stringify({ ...input, condition }, null, 2));
      setJsonError(undefined);
      setJsonMessage(`${option?.label ?? metric} toegevoegd met ${jsonJoinOperator === "all" ? "EN" : "OF"}. Pas de standaardwaarde aan.`);
    } catch (validationError) {
      setJsonMessage(undefined);
      setJsonError(`Bouwsteen kon niet worden toegevoegd: ${validationError instanceof Error ? validationError.message : String(validationError)}`);
    }
  }

  async function saveJsonDraft() {
    try {
      const input = parseAchievementJson(jsonDraft);
      const exists = definitions.some((definition) => definition.id === input.id);
      const saved = await saveAchievement({ ...input, enabled: exists ? input.enabled : false });
      setJsonDraft(formatAchievementJson(saved));
      setJsonError(undefined);
      setJsonMessage(exists
        ? `${saved.title} opgeslagen.`
        : `${saved.title} opgeslagen als inactieve achievement.`);
      await reload();
    } catch (saveError) {
      setJsonMessage(undefined);
      setJsonError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }

  return (
    <section className="account-card achievement-management">
      <div><p className="eyebrow">Admin</p><h2>Achievements beheren</h2></div>
      <ul className="achievement-definition-list">
        {definitions.map((definition) => <li key={definition.id}>
          <div>
            <strong>{definition.title}</strong>
            <span>{definition.enabled ? "Actief" : "Uit"}</span>
            <span className="achievement-condition-summary">
              <b>ALS</b> {achievementConditionPreview(definition.condition, divisions, concessions)}
            </span>
          </div>
          <div className="achievement-definition-actions">
            <button className="secondary-button" type="button" onClick={() => loadDefinitionInJsonEditor(definition)}><Braces size={16} /> JSON</button>
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
        }}>{ACHIEVEMENT_METRIC_OPTIONS.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
        {(metric === "lineMinutes" || metric === "uniqueLines" || metric === "fullDutyMaterial" || metric === "fullDutyLines") && (
          <label><span>Divisie (optioneel)</span><select value={divisionId} onChange={(event) => setDivisionId(event.target.value)}><option value="">Alle divisies</option>{divisions.map((division) => <option key={division.id} value={division.id}>{division.name}</option>)}</select></label>
        )}
        <label><span>Stalling (optioneel)</span><input value={depot} onChange={(event) => setDepot(event.target.value)} placeholder="Alle stallingen" /></label>
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
      <p className="settings-note">Gebruik de geavanceerde JSON-editor voor geneste EN/OF-regels; het formulier hierboven maakt bewust één duidelijke voorwaarde per badge.</p>
      <details
        className="achievement-json-editor"
        open={jsonEditorOpen}
        onToggle={(event) => setJsonEditorOpen(event.currentTarget.open)}
      >
        <summary>
          <Braces size={18} />
          <div>
            <strong>Geavanceerde JSON-editor</strong>
            <span>Maak geneste EN/OF-regels met het interne achievementmodel.</span>
          </div>
          <ChevronDown size={18} />
        </summary>
        <div className="achievement-json-content">
          <div className="achievement-json-workspace">
            <label>
              <span>Achievement-JSON</span>
              <textarea
                aria-label="Achievement-JSON"
                spellCheck={false}
                value={jsonDraft}
                onChange={(event) => {
                  setJsonDraft(event.target.value);
                  setJsonError(undefined);
                  setJsonMessage(undefined);
                }}
              />
            </label>
            <aside className="achievement-json-builder" aria-label="JSON-bouwstenen">
              <div>
                <strong>Voorwaarde toevoegen</strong>
                <span>Alle statistieken staan hieronder.</span>
              </div>
              <div className="achievement-json-join" aria-label="Nieuwe voorwaarde combineren met">
                <button className={jsonJoinOperator === "all" ? "active" : ""} type="button" onClick={() => setJsonJoinOperator("all")}>EN</button>
                <button className={jsonJoinOperator === "any" ? "active" : ""} type="button" onClick={() => setJsonJoinOperator("any")}>OF</button>
              </div>
              <div className="achievement-json-metrics">
                {ACHIEVEMENT_METRIC_OPTIONS.map((option) => (
                  <button type="button" key={option.id} onClick={() => addJsonMetric(option.id)}>
                    <Plus size={15} />
                    <span><strong>{option.label}</strong><code>{option.id}</code></span>
                    <small>{option.description}</small>
                  </button>
                ))}
              </div>
              <div className="achievement-json-field-help">
                <strong>Optionele filters</strong>
                <span><code>divisionId</code> divisie</span>
                <span><code>depot</code> stalling, bijvoorbeeld Lisse, Garage</span>
                <span><code>lines</code> lijnen optellen</span>
                <span><code>materialTypes</code> materieel</span>
                <span><code>withinSingleDuty</code> binnen één dienst</span>
                <span><code>consecutive</code> opeenvolgende diensten</span>
              </div>
            </aside>
          </div>
          {divisions.length > 0 && (
            <p className="achievement-json-scopes">
              Divisie-ID's: {divisions.map((division) => <code key={division.id}>{division.id}</code>)}
            </p>
          )}
          {jsonError && <p className="account-error achievement-json-feedback" role="alert">{jsonError}</p>}
          {jsonMessage && <p className="achievement-json-feedback success" role="status">{jsonMessage}</p>}
          <div className="achievement-json-actions">
            <button className="secondary-button" type="button" onClick={loadJsonExample}><Braces size={16} /> Voorbeeld laden</button>
            <button className="secondary-button" type="button" onClick={validateJsonDraft}><CheckCircle2 size={16} /> Controleren</button>
            <button className="primary-button" type="button" onClick={() => void saveJsonDraft()}><Save size={16} /> Opslaan</button>
          </div>
        </div>
      </details>
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
                <div><strong>{achievement.title}</strong><span>Behaald op {formatTimestamp(achievement.earnedAt)}</span></div>
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

export type AchievementInput = Omit<AchievementDefinition, "version">;
export type AchievementMetric = "totalMinutes" | "pauseMinutes" | "materialMinutes" | "dutyCount" | "uniqueLines" | "lineMinutes" | "fullDutyMaterial" | "fullDutyLines";

const ACHIEVEMENT_METRIC_OPTIONS: { id: AchievementMetric; label: string; description: string }[] = [
  { id: "totalMinutes", label: "Totaal lijnminuten", description: "Alle gereden lijnminuten." },
  { id: "lineMinutes", label: "Minuten op lijnen", description: "Eén of meer lijnen bij elkaar." },
  { id: "pauseMinutes", label: "Pauzeminuten", description: "Alle pauze of binnen één dienst." },
  { id: "materialMinutes", label: "Materieelminuten", description: "Alle of gekozen materieelsoorten." },
  { id: "dutyCount", label: "Aantal diensten", description: "Eventueel binnen één divisie." },
  { id: "uniqueLines", label: "Unieke lijnen", description: "Alle lijnen of binnen een divisie." },
  { id: "fullDutyLines", label: "Volledige lijndienst", description: "Een hele dienst op gekozen lijnen." },
  { id: "fullDutyMaterial", label: "Volledige materieeldienst", description: "Een hele dienst op gekozen materieel." },
];

const ACHIEVEMENT_METRICS = new Set<AchievementMetric>([
  "totalMinutes",
  "pauseMinutes",
  "materialMinutes",
  "dutyCount",
  "uniqueLines",
  "lineMinutes",
  "fullDutyMaterial",
  "fullDutyLines",
]);
const ACHIEVEMENT_COMPARISONS = new Set(["gt", "gte", "lt", "lte", "eq", "between"]);

function achievementJsonTemplate(): string {
  const divisionCondition = {
    kind: "metric",
    metric: "dutyCount",
    lines: [],
    comparison: "gte",
    value: 1,
  };
  return JSON.stringify({
    id: "nieuwe-achievement",
    title: "Nieuwe achievement",
    description: "Behaal alle voorwaarden.",
    badge: "NIEUW",
    enabled: false,
    condition: {
      kind: "group",
      operator: "all",
      conditions: [
        divisionCondition,
        {
          kind: "metric",
          metric: "lineMinutes",
          lines: ["20", "21"],
          comparison: "gte",
          value: 100,
        },
      ],
    },
  }, null, 2);
}

function achievementMetricConditionTemplate(metric: AchievementMetric): AchievementCondition {
  const condition = {
    kind: "metric" as const,
    metric,
    lines: metric === "fullDutyLines" ? ["VUL-LIJN-IN"] : [],
    comparison: "gte" as const,
    value: ["totalMinutes", "lineMinutes", "pauseMinutes", "materialMinutes"].includes(metric) ? 60 : 1,
  };
  if (metric === "fullDutyMaterial") {
    return { ...condition, materialTypes: ["VUL-MATERIEELSOORT-IN"], consecutive: false };
  }
  if (metric === "materialMinutes") {
    return { ...condition, materialTypes: [] };
  }
  if (metric === "fullDutyLines") {
    return { ...condition, consecutive: false };
  }
  return condition;
}

export function appendAchievementCondition(
  current: AchievementCondition,
  addition: AchievementCondition,
  operator: "all" | "any",
): AchievementCondition {
  return current.kind === "group" && current.operator === operator
    ? { ...current, conditions: [...current.conditions, addition] }
    : { kind: "group", operator, conditions: [current, addition] };
}

function formatAchievementJson(definition: AchievementDefinition): string {
  return JSON.stringify({
    id: definition.id,
    title: definition.title,
    description: definition.description,
    badge: definition.badge,
    enabled: definition.enabled,
    condition: definition.condition,
  }, null, 2);
}

export function parseAchievementJson(source: string): AchievementInput {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Ongeldige JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonObject(value)) throw new Error("De JSON moet één achievement-object bevatten.");
  if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.id)) {
    throw new Error("id is verplicht en mag alleen letters, cijfers, - en _ bevatten.");
  }
  if (typeof value.title !== "string" || !value.title.trim()) throw new Error("title is verplicht.");
  if (typeof value.description !== "string" || !value.description.trim()) throw new Error("description is verplicht.");
  if (typeof value.badge !== "string") throw new Error("badge moet tekst zijn.");
  if (typeof value.enabled !== "boolean") throw new Error("enabled moet true of false zijn.");
  validateAchievementConditionJson(value.condition, "condition", 0);
  return value as AchievementInput;
}

function validateAchievementConditionJson(value: unknown, path: string, depth: number): asserts value is AchievementCondition {
  if (depth > 8) throw new Error(`${path} bevat te veel geneste groepen.`);
  if (!isJsonObject(value)) throw new Error(`${path} moet een object zijn.`);
  if (value.kind === "group") {
    if (value.operator !== "all" && value.operator !== "any") {
      throw new Error(`${path}.operator moet "all" of "any" zijn.`);
    }
    if (!Array.isArray(value.conditions) || value.conditions.length === 0) {
      throw new Error(`${path}.conditions moet minimaal één voorwaarde bevatten.`);
    }
    value.conditions.forEach((condition, index) => validateAchievementConditionJson(condition, `${path}.conditions[${index}]`, depth + 1));
    return;
  }
  if (value.kind !== "metric") throw new Error(`${path}.kind moet "group" of "metric" zijn.`);
  if (typeof value.metric !== "string" || !ACHIEVEMENT_METRICS.has(value.metric as AchievementMetric)) {
    throw new Error(`${path}.metric is onbekend.`);
  }
  // Normalize absent filters to the same defaults used by the server.
  if (value.lines == null) value.lines = [];
  if (value.depot === null || (typeof value.depot === "string" && !value.depot.trim())) delete value.depot;
  if (value.depot !== undefined && typeof value.depot !== "string") throw new Error(`${path}.depot moet tekst zijn.`);
  if (value.materialTypes === null) delete value.materialTypes;
  if (value.divisionId === null || (typeof value.divisionId === "string" && !value.divisionId.trim())) delete value.divisionId;
  if (value.withinSingleDuty === null) delete value.withinSingleDuty;
  if (value.consecutive === null) delete value.consecutive;
  if (!Array.isArray(value.lines) || value.lines.some((line) => typeof line !== "string")) {
    throw new Error(`${path}.lines moet een lijst met tekstwaarden zijn.`);
  }
  if (value.materialTypes !== undefined && (!Array.isArray(value.materialTypes) || value.materialTypes.some((item) => typeof item !== "string"))) {
    throw new Error(`${path}.materialTypes moet een lijst met tekstwaarden zijn.`);
  }
  if (value.divisionId !== undefined && typeof value.divisionId !== "string") {
    throw new Error(`${path}.divisionId moet tekst zijn.`);
  }
  if (value.withinSingleDuty !== undefined && typeof value.withinSingleDuty !== "boolean") {
    throw new Error(`${path}.withinSingleDuty moet true of false zijn.`);
  }
  if (value.consecutive !== undefined && typeof value.consecutive !== "boolean") {
    throw new Error(`${path}.consecutive moet true of false zijn.`);
  }
  if (typeof value.comparison !== "string" || !ACHIEVEMENT_COMPARISONS.has(value.comparison)) {
    throw new Error(`${path}.comparison is onbekend.`);
  }
  if (!Number.isSafeInteger(value.value) || (value.value as number) < 0) {
    throw new Error(`${path}.value moet een positief geheel getal of 0 zijn.`);
  }
  if (value.comparison === "between" && (!Number.isSafeInteger(value.maxValue) || (value.maxValue as number) < (value.value as number))) {
    throw new Error(`${path}.maxValue moet bij "between" een geheel getal vanaf value zijn.`);
  }
  if (value.metric === "fullDutyLines" && value.lines.length === 0) {
    throw new Error(`${path}.lines vereist minimaal één lijn voor fullDutyLines.`);
  }
  if (value.metric === "fullDutyMaterial" && (!Array.isArray(value.materialTypes) || value.materialTypes.length === 0)) {
    throw new Error(`${path}.materialTypes vereist minimaal één soort voor fullDutyMaterial.`);
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  scopeLabel: string | undefined,
  withinSingleDuty: boolean,
  consecutive: boolean,
  comparison: "gt" | "gte" | "lt" | "lte" | "eq",
  value: number,
): string {
  const comparisonText = { gt: "groter is dan", gte: "minimaal", lt: "kleiner is dan", lte: "maximaal", eq: "gelijk is aan" }[comparison];
  const scope = scopeLabel ? ` ${scopeLabel}` : "";
  const dutyScope = withinSingleDuty ? " binnen dezelfde dienst" : "";
  const materialLabel = materialTypes.length > 0 ? materialTypes.join(" + ") : "alle materieelsoorten";
  const subject = {
    totalMinutes: `het totaal aantal lijnminuten${scope}${dutyScope}`,
    pauseMinutes: `het aantal pauzeminuten${scope}${dutyScope}`,
    materialMinutes: `de minuten op ${materialLabel}${scope}${dutyScope}`,
    dutyCount: `het aantal gereden diensten${scope}`,
    uniqueLines: `het aantal unieke lijnen${scope}${dutyScope}`,
    lineMinutes: lines.length > 0
      ? `de minuten van ${lines.map((line) => `L${line}`).join(" + ")}${scope}${dutyScope}`
      : `de minuten van de gekozen lijnen${scope}${dutyScope}`,
    fullDutyMaterial: `het aantal ${consecutive ? "opeenvolgende " : ""}volledige diensten op ${materialLabel}${scope}`,
    fullDutyLines: `het aantal ${consecutive ? "opeenvolgende " : ""}volledige diensten met alleen ${lines.map((line) => `L${line}`).join(" + ")}${scope}`,
  }[metric];
  return `${subject} ${comparisonText} ${value}`;
}

function achievementConditionPreview(
  condition: AchievementCondition,
  divisions: Division[],
  concessions: Concession[],
): string {
  if (condition.kind === "group") {
    const separator = condition.operator === "all" ? " EN " : " OF ";
    return condition.conditions
      .map((child) => `(${achievementConditionPreview(child, divisions, concessions)})`)
      .join(separator);
  }

  const scopeLabel = [achievementScopeLabel(condition.divisionId, divisions, concessions) ?? "over alle divisies", condition.depot?.trim() ? `van stalling ${condition.depot.trim()}` : ""].filter(Boolean).join(" ");
  if (condition.comparison === "between") {
    const subject = achievementRulePreview(
      condition.metric,
      condition.lines,
      condition.materialTypes ?? [],
      scopeLabel,
      condition.withinSingleDuty ?? false,
      condition.consecutive ?? false,
      "eq",
      condition.value,
    ).replace(/ gelijk is aan .+$/, "");
    return `${subject} tussen ${condition.value} en ${condition.maxValue ?? condition.value} ligt`;
  }

  return achievementRulePreview(
    condition.metric,
    condition.lines,
    condition.materialTypes ?? [],
    scopeLabel,
    condition.withinSingleDuty ?? false,
    condition.consecutive ?? false,
    condition.comparison,
    condition.value,
  );
}

function achievementScopeLabel(
  scopeId: string | undefined,
  divisions: Division[],
  concessions: Concession[],
): string | undefined {
  if (!scopeId) return undefined;

  const division = divisions.find((candidate) => candidate.id === scopeId);
  if (division) {
    const concession = concessions.find((candidate) => candidate.id === division.concessionId);
    return concession
      ? `binnen divisie ${division.name} (concessie ${concession.name})`
      : `binnen divisie ${division.name}`;
  }

  const concession = concessions.find((candidate) => candidate.id === scopeId);
  if (concession) return `binnen concessie ${concession.name}`;

  return `binnen opgeslagen scope ${scopeId}`;
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
    row.depot ?? "",
  ]);
  return [[...headers, "stalling"], ...values].map((row) => row.map(csvValue).join(";")).join("\r\n");
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
