import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  AlertTriangle,
  BusFront,
  Clock3,
  Download,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Loader2,
  Navigation,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Table2,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import AccountPage, { AccountManagement } from "./AccountPage";
import { AchievementManagement } from "./PersonalDataPanel";
import DutyConfirmation from "./DutyConfirmation";
import { accountsAvailable, getSetupStatus, logout, restoreSession, type AuthSession } from "./auth";
import WageSettingsPanel from "./wage/WageSettingsPanel";
import { calculateDutyWage } from "./wage/calculate";
import { deleteWageSettings, readWageSettings, writeWageSettings } from "./wage/storage";
import { DEFAULT_WAGE_SETTINGS, type WageSettings } from "./wage/types";
import { getCachedQbuzzLiveStatuses, getQbuzzLiveStatuses, plannedMarkerMinute } from "./live";
import { hasInterveningDriver, toOperationalMinute, type DutyVehicleInterval } from "./guidanceLogic";
import { calculateTakeoverStatus, resolveTakeoverArrivalMinute, resolveTakeoverPlannedMinute } from "./takeoverStatus";
import { isBuslessDriverRow, withoutLegacyOvChipNumber } from "./pdfColumns";
import { DEFAULT_BUSLESS_ACTIONS, normaliseBuslessActions } from "./buslessActions";
import {
  createPdfContentHash,
  createStoredFileId,
  deleteStoredPdfFile,
  findExistingPdfHashes,
  getCachedStoredData,
  getStoredPdfCatalog,
  getStoredSchedule,
  reparseStoredPdfFiles,
  saveAdminSettings,
  saveStoredPdfFile,
  saveOrganizationConfig,
  updateStoredPdfFileDaySegment,
  updateStoredPdfFileDivision,
  updateStoredPdfFileEnabled,
} from "./storage";
import {
  DEFAULT_DIVISION_ID,
  DEFAULT_ORGANIZATION,
  normalizeOrganization,
  organizationItemId,
  scheduleSelectionKey,
} from "./organization";
import type {
  Concession,
  DaySegment,
  Dienst,
  Division,
  LiveMovementRequest,
  LiveMovementStatus,
  LiveStatusResponse,
  LiveSyncState,
  Movement,
  OrganizationConfig,
  ParseResult,
  StoredPdfFile,
  StoredPdfFileSummary,
} from "./types";

const EMPTY_RESULTS: ParseResult[] = [];
const DESKTOP_LOOP_COLUMN_WIDTH = 170;
const MOBILE_LOOP_COLUMN_WIDTH = 84;
const GUIDANCE_LOCK_KEY = "dienstenlezer-locked-guidance-service";
const SELECTED_DIVISIONS_KEY = "dienstenlezer-selected-divisions-v1";
type Page = "loops" | "services" | "guidance" | "settings" | "account";

const DAY_SEGMENTS: { id: DaySegment; label: string; description: string }[] = [
  { id: "weekday", label: "Ma-vr", description: "Werkdagen" },
  { id: "saturday", label: "Za", description: "Zaterdag" },
  { id: "sunday", label: "Zo", description: "Zondag" },
  { id: "unassigned", label: "Nog niet ingedeeld", description: "Nieuw geuploade bestanden" },
];

function readLockedGuidanceService(): string | undefined {
  try {
    return window.localStorage.getItem(GUIDANCE_LOCK_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function writeLockedGuidanceService(serviceNumber?: string) {
  try {
    if (serviceNumber) {
      window.localStorage.setItem(GUIDANCE_LOCK_KEY, serviceNumber);
    } else {
      window.localStorage.removeItem(GUIDANCE_LOCK_KEY);
    }
  } catch {
    // De vergrendeling blijft voor deze sessie werken als browseropslag niet beschikbaar is.
  }
}

function readSelectedDivisions(): string[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SELECTED_DIVISIONS_KEY) ?? "[]") as unknown;
    return Array.isArray(stored) && stored.every((item) => typeof item === "string")
      ? stored.filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function writeSelectedDivisions(divisionIds: string[]) {
  try {
    window.localStorage.setItem(SELECTED_DIVISIONS_KEY, JSON.stringify(divisionIds));
  } catch {
    // De selectie blijft voor deze sessie werken als browseropslag niet beschikbaar is.
  }
}

function cachedLiveResponse(date: string, divisionIds: string[] = []): LiveStatusResponse | undefined {
  const cached = getCachedQbuzzLiveStatuses(date, divisionIds);
  if (!cached) {
    return undefined;
  }

  return {
    ...cached.response,
    sync: {
      ...cached.response.sync,
      state: "syncing",
      fetchedAt: cached.response.sync.fetchedAt ?? Math.floor(cached.savedAt / 1000),
      message: "Opgeslagen livegegevens geladen; actuele gegevens worden opgehaald...",
    },
  };
}

function initialLiveResponse(): LiveStatusResponse {
  return cachedLiveResponse(todayInputValue(), readSelectedDivisions()) ?? {
    statuses: [],
    sync: { state: "unavailable", message: "Live status wordt gestart." },
  };
}

function App() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const storageRequestIdRef = useRef(0);
  const previousScheduleScopeRef = useRef<string | undefined>(undefined);
  const [storedFiles, setStoredFiles] = useState<StoredPdfFileSummary[]>([]);
  const [organization, setOrganization] = useState<OrganizationConfig>(() => structuredClone(DEFAULT_ORGANIZATION));
  const [selectedDivisionIds, setSelectedDivisionIds] = useState(readSelectedDivisions);
  const [uploadDivisionId, setUploadDivisionId] = useState(DEFAULT_DIVISION_ID);
  const [results, setResults] = useState<ParseResult[]>(EMPTY_RESULTS);
  const [page, setPage] = useState<Page>(() => readLockedGuidanceService() ? "guidance" : "loops");
  const [selectedDate, setSelectedDate] = useState(() => todayInputValue());
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);
  const [isParsing, setIsParsing] = useState(false);
  const [includeNoLoop, setIncludeNoLoop] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [frameHours, setFrameHours] = useState(6);
  const [query, setQuery] = useState("");
  const [storageError, setStorageError] = useState<string | undefined>();
  const [guidanceServiceNumber, setGuidanceServiceNumber] = useState(() => readLockedGuidanceService() ?? "");
  const [guidanceLocked, setGuidanceLocked] = useState(() => Boolean(readLockedGuidanceService()));
  const [guidanceTimeOverride, setGuidanceTimeOverride] = useState("");
  const [liveResponse, setLiveResponse] = useState<LiveStatusResponse>(initialLiveResponse);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [isPageVisible, setIsPageVisible] = useState(() => document.visibilityState !== "hidden");
  const [buslessActions, setBuslessActions] = useState<string[]>([...DEFAULT_BUSLESS_ACTIONS]);
  const [authSession, setAuthSession] = useState<AuthSession>();
  const [authLoading, setAuthLoading] = useState(accountsAvailable);
  const [authSetupRequired, setAuthSetupRequired] = useState(false);
  const [authError, setAuthError] = useState<string>();
  const [wageSettings, setWageSettings] = useState<WageSettings>();

  const selectedDaySegment = useMemo(() => daySegmentForDate(selectedDate), [selectedDate]);
  const selectedScheduleScope = useMemo(
    () => scheduleSelectionKey(selectedDaySegment, selectedDivisionIds),
    [selectedDaySegment, selectedDivisionIds],
  );
  const allMovements = useMemo(
    () => results
      .flatMap((result) => result.movements)
      .map(normaliseStoredMovement),
    [results],
  );
  const allDiensten = useMemo(() => results.flatMap((result) => result.diensten), [results]);
  const warnings = useMemo(() => results.flatMap((result) => result.warnings), [results]);
  const liveVehicleQueryLoops = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const loops = new Set<string>();
    if (!needle) {
      return loops;
    }

    const movementById = new Map(allMovements.map((movement) => [movement.id, movement]));
    for (const status of liveResponse.statuses) {
      if (!status.vehicleId?.toLowerCase().includes(needle)) {
        continue;
      }
      const movement = movementById.get(status.movementId);
      if (movement?.omloopnummer) {
        loops.add(loopKey(movement));
      }
    }
    return loops;
  }, [allMovements, liveResponse.statuses, query]);

  const filteredMovements = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return allMovements.filter((movement) => {
      if (!includeNoLoop && !movement.omloopnummer) {
        return false;
      }

      if (!needle) {
        return true;
      }

      if (movement.omloopnummer && liveVehicleQueryLoops.has(loopKey(movement))) {
        return true;
      }

      return [
        movement.dienstnummer,
        movement.omloopnummer,
        movement.lijnnummer,
        movement.ritnummer,
        movement.van,
        movement.naar,
        movement.vertrek,
        movement.aankomst,
        movement.sourceFile,
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle));
    });
  }, [allMovements, includeNoLoop, liveVehicleQueryLoops, query]);

  const allServices = useMemo(() => orderedDiensten(allDiensten, allMovements), [allDiensten, allMovements]);
  const services = useMemo(() => orderedDiensten(allDiensten, filteredMovements), [allDiensten, filteredMovements]);
  const timelineMovements = useMemo(
    () => filteredMovements.filter((movement) => isVehicleTimelineMovement(movement, buslessActions)),
    [buslessActions, filteredMovements],
  );
  const liveTimelineMovements = useMemo(
    () => allMovements.filter((movement) => isVehicleTimelineMovement(movement, buslessActions)),
    [allMovements, buslessActions],
  );
  const timelineLoops = useMemo(() => orderedLoops(timelineMovements), [timelineMovements]);
  const isToday = selectedDate === todayInputValue();
  const liveRequested = page === "loops" || page === "guidance";
  const guidanceCurrentTime = useMemo(
    () => withTimeOverride(currentTime, guidanceTimeOverride),
    [currentTime, guidanceTimeOverride],
  );

  useEffect(() => {
    void reloadStoredFiles();
  }, []);

  useEffect(() => {
    if (!authSession) {
      setWageSettings(undefined);
      return;
    }
    let cancelled = false;
    void readWageSettings(authSession.account.id)
      .then((settings) => {
        if (!cancelled) setWageSettings(settings);
      })
      .catch((error) => {
        if (!cancelled) setStorageError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [authSession?.account.id]);

  useEffect(() => {
    if (!accountsAvailable()) {
      setAuthLoading(false);
      return;
    }
    let cancelled = false;
    void Promise.all([restoreSession(), getSetupStatus()])
      .then(([session, setupRequired]) => {
        if (!cancelled) {
          setAuthSession(session);
          setAuthSetupRequired(setupRequired);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAuthError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAuthLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authLoading) {
      void reloadStoredFiles();
    }
  }, [authLoading, authSession?.account.role]);

  useEffect(() => {
    function updateVisibility() {
      setIsPageVisible(document.visibilityState !== "hidden");
    }

    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    if (previousScheduleScopeRef.current === undefined) {
      previousScheduleScopeRef.current = selectedScheduleScope;
      return;
    }

    if (previousScheduleScopeRef.current !== selectedScheduleScope) {
      previousScheduleScopeRef.current = selectedScheduleScope;
      void reloadStoredFiles();
    }
  }, [selectedScheduleScope]);

  useEffect(() => {
    if (!liveRequested) {
      return;
    }

    const timer = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [liveRequested]);

  useEffect(() => {
    if (!liveRequested) {
      return;
    }

    if (!isToday) {
      setLiveResponse({
        statuses: [],
        sync: {
          state: "unavailable",
          message: "Live status is alleen beschikbaar voor vandaag.",
        },
      });
      return;
    }

    setLiveResponse((current) => current.statuses.length > 0
      ? current
      : cachedLiveResponse(selectedDate, selectedDivisionIds) ?? current);

    if (!isPageVisible) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    async function refreshLiveStatuses() {
      if (cancelled) {
        return;
      }

      try {
        const requestMovements = liveMovementRequests(liveTimelineMovements, new Date());
        if (requestMovements.length === 0) {
          setLiveResponse({
            statuses: [],
            sync: {
              state: "unavailable",
              message: "Geen ritten binnen twee uur voor of na nu beschikbaar voor Qbuzz-live.",
            },
          });
          timer = window.setTimeout(() => void refreshLiveStatuses(), 30_000);
          return;
        }

        setLiveResponse((current) => ({
          ...current,
          sync: {
            ...current.sync,
            state: "syncing",
            message: current.statuses.length > 0
              ? "Nieuwe Qbuzz-livegegevens ophalen..."
              : "Eerste Qbuzz-livegegevens ophalen...",
          },
        }));
        const response = await getQbuzzLiveStatuses(selectedDate, requestMovements, selectedDivisionIds);
        if (!cancelled) {
          setLiveResponse(response);
          timer = window.setTimeout(() => void refreshLiveStatuses(), 30_000);
        }
      } catch (error) {
        if (!cancelled) {
          setLiveResponse((current) => ({
            ...current,
            sync: {
              ...current.sync,
              state: "error",
              message: liveErrorMessage(error),
            },
          }));
          timer = window.setTimeout(() => void refreshLiveStatuses(), 30_000);
        }
      }
    }

    void refreshLiveStatuses();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [isPageVisible, isToday, liveRequested, liveTimelineMovements, selectedDate, selectedScheduleScope]);

  async function reloadStoredFiles(requestedDivisionIds = selectedDivisionIds) {
    const requestId = ++storageRequestIdRef.current;
    setIsLoadingFiles(true);
    setStorageError(undefined);
    try {
      const cached = await getCachedStoredData(selectedDaySegment, requestedDivisionIds);
      if (cached && requestId === storageRequestIdRef.current) {
        setOrganization(normalizeOrganization(cached.catalog.organization));
        setBuslessActions(normaliseBuslessActions(
          cached.catalog.adminSettings?.buslessActions ?? [...DEFAULT_BUSLESS_ACTIONS],
        ));
        setStoredFiles(cached.catalog.files);
        setResults(cached.schedule.results);
        setIsLoadingFiles(false);
      }
      const catalog = await getStoredPdfCatalog();
      const normalizedOrganization = normalizeOrganization(catalog.organization);
      const effectiveDivisionIds = resolveSelectedDivisionIds(requestedDivisionIds, normalizedOrganization);
      const schedule = await getStoredSchedule(selectedDaySegment, effectiveDivisionIds, catalog.revision);
      if (requestId !== storageRequestIdRef.current) {
        return;
      }
      setStoredFiles(catalog.files);
      setOrganization(normalizedOrganization);
      setBuslessActions(normaliseBuslessActions(
        catalog.adminSettings?.buslessActions ?? [...DEFAULT_BUSLESS_ACTIONS],
      ));
      if (!sameStringSet(selectedDivisionIds, effectiveDivisionIds)) {
        setSelectedDivisionIds(effectiveDivisionIds);
        writeSelectedDivisions(effectiveDivisionIds);
      }
      if (uploadDivisionId && !normalizedOrganization.divisions.some((division) => division.id === uploadDivisionId)) {
        setUploadDivisionId(DEFAULT_DIVISION_ID);
      }
      setResults(schedule.results);
    } catch (error) {
      if (requestId === storageRequestIdRef.current) {
        setStorageError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === storageRequestIdRef.current) {
        setIsLoadingFiles(false);
      }
    }
  }

  async function handleFiles(fileList: FileList | null) {
    const files = [...(fileList ?? [])].filter((file) => file.type === "application/pdf" || file.name.endsWith(".pdf"));

    if (files.length === 0) {
      return;
    }

    setIsParsing(true);
    setStorageError(undefined);
    try {
      const hashedFiles = await Promise.all(files.map(async (file) => ({ file, contentHash: await createPdfContentHash(file) })));
      const existingHashes = await findExistingPdfHashes(
        hashedFiles.map(({ contentHash }) => contentHash).filter((value): value is string => Boolean(value)),
      );
      const pendingFiles = hashedFiles.filter(({ contentHash }) => !contentHash || !existingHashes.has(contentHash));
      if (pendingFiles.length > 0) {
        const { parsePdfFiles } = await import("./pdfParser");
        const parsedResults = await parsePdfFiles(pendingFiles.map(({ file }) => file));
        const stored: StoredPdfFile[] = pendingFiles.map(({ file, contentHash }, index) => ({
          id: createStoredFileId(file),
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          uploadedAt: Date.now(),
          enabled: true,
          daySegment: "unassigned" as const,
          divisionId: uploadDivisionId,
          contentHash,
          file,
          parseResult: parsedResults[index],
        }));

        await Promise.all(stored.map((file) => saveStoredPdfFile(file)));
      }
      await reloadStoredFiles();
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsParsing(false);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }

  function exportCsv() {
    downloadText("dienstenlezer-omlopen.csv", movementsToCsv(filteredMovements));
  }

  async function updateBuslessActions(actions: string[]) {
    setStorageError(undefined);
    try {
      const saved = await saveAdminSettings({ buslessActions: actions });
      setBuslessActions(saved.buslessActions);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  }

  function resetView() {
    setQuery("");
    setIncludeNoLoop(true);
  }

  function updateGuidanceLock(locked: boolean) {
    const serviceNumber = guidanceServiceNumber.trim();
    if (locked && serviceNumber) {
      writeLockedGuidanceService(serviceNumber);
      setGuidanceLocked(true);
      return;
    }

    writeLockedGuidanceService();
    setGuidanceLocked(false);
  }

  async function toggleStoredFile(file: StoredPdfFileSummary) {
    await updateStoredPdfFileEnabled(file.id, !file.enabled);
    await reloadStoredFiles();
  }

  async function moveStoredFile(file: StoredPdfFileSummary, daySegment: DaySegment) {
    await updateStoredPdfFileDaySegment(file.id, daySegment);
    await reloadStoredFiles();
  }

  async function moveStoredFileToDivision(file: StoredPdfFileSummary, divisionId: string) {
    await updateStoredPdfFileDivision(file.id, divisionId);
    await reloadStoredFiles();
  }

  async function reparseStoredFiles() {
    if (storedFiles.length === 0 || !window.confirm(
      `Alle ${storedFiles.length} opgeslagen pdf-bestanden opnieuw uitlezen? Dit kan even duren.`,
    )) {
      return;
    }
    setIsParsing(true);
    setStorageError(undefined);
    try {
      await reparseStoredPdfFiles(storedFiles);
      await reloadStoredFiles();
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsParsing(false);
    }
  }

  async function updateOrganization(organizationConfig: OrganizationConfig) {
    setStorageError(undefined);
    try {
      const saved = await saveOrganizationConfig(organizationConfig);
      const effectiveDivisionIds = resolveSelectedDivisionIds(selectedDivisionIds, saved);
      setOrganization(saved);
      setSelectedDivisionIds(effectiveDivisionIds);
      writeSelectedDivisions(effectiveDivisionIds);
      if (uploadDivisionId && !saved.divisions.some((division) => division.id === uploadDivisionId)) {
        setUploadDivisionId(DEFAULT_DIVISION_ID);
      }
      await reloadStoredFiles(effectiveDivisionIds);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  }

  function updateSelectedDivisions(divisionIds: string[]) {
    const resolved = resolveSelectedDivisionIds(divisionIds, organization);
    setSelectedDivisionIds(resolved);
    writeSelectedDivisions(resolved);
  }

  async function removeStoredFile(file: StoredPdfFileSummary) {
    if (!window.confirm(`Bestand "${file.name}" verwijderen?`)) {
      return;
    }

    await deleteStoredPdfFile(file.id);
    await reloadStoredFiles();
  }

  async function handleLogout() {
    await logout();
    setAuthSession(undefined);
    setPage("loops");
  }

  function handleAuthSession(session: AuthSession) {
    setAuthSession(session);
    setAuthSetupRequired(false);
    setAuthError(undefined);
  }

  async function saveLocalWageSettings(settings: WageSettings) {
    if (!authSession) return;
    await writeWageSettings(authSession.account.id, settings);
    setWageSettings(settings);
  }

  async function removeLocalWageSettings() {
    if (!authSession) return;
    await deleteWageSettings(authSession.account.id);
    setWageSettings({ ...DEFAULT_WAGE_SETTINGS });
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">DienstenLezer</p>
          <h1>Omlopen uit diensten-pdf's</h1>
        </div>
        <div className="topbar-actions">
          <label className="top-date">
            <span>Datum</span>
            <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            <strong>{segmentLabel(selectedDaySegment)}</strong>
          </label>
          <button
            className={page === "settings" ? "icon-button active" : "icon-button"}
            type="button"
            onClick={() => setPage((value) => (value === "settings" ? "loops" : "settings"))}
            title={page === "settings" ? "Omloop overzicht tonen" : "Instellingen"}
          >
            {page === "settings" ? <Table2 size={19} /> : <Settings size={19} />}
          </button>
          {accountsAvailable() && (
            <button
              className={page === "account" ? "icon-button active" : "icon-button"}
              type="button"
              onClick={() => setPage((value) => (value === "account" ? "loops" : "account"))}
              title={authSession ? `Account ${authSession.account.username}` : "Account"}
            >
              <UserRound size={19} />
            </button>
          )}
          <button className="icon-button danger" type="button" onClick={resetView} disabled={!query && includeNoLoop} title="Filters leegmaken">
            <X size={19} />
          </button>
        </div>
      </section>

      {page !== "settings" && page !== "account" && (
        <nav className="overview-tabs" aria-label="Overzichten">
          <button className={page === "loops" ? "active" : ""} type="button" onClick={() => setPage("loops")}>
            <span className="tab-long">Omloop overzicht</span><span className="tab-short">Omlopen</span>
          </button>
          <button className={page === "services" ? "active" : ""} type="button" onClick={() => setPage("services")}>
            <span className="tab-long">Diensten overzicht</span><span className="tab-short">Diensten</span>
          </button>
          <button className={page === "guidance" ? "active" : ""} type="button" onClick={() => setPage("guidance")}>
            <span className="tab-long">Dienstbegeleiding</span><span className="tab-short">Begeleiding</span>
          </button>
        </nav>
      )}

      {(page === "loops" || page === "services") && (
        <section className="metrics">
          <Metric icon={<Table2 size={18} />} label="Diensten" value={services.length} />
          <Metric icon={<Search size={18} />} label="Ritregels" value={filteredMovements.length} />
        </section>
      )}

      {(warnings.length > 0 || storageError) && (
        <section className="warnings">
          <AlertTriangle size={18} />
          <div>
            {storageError && <p>Bestanden konden niet worden geladen of verwerkt: {storageError}</p>}
            {warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        </section>
      )}

      {page === "account" ? (
        <AccountPage
          session={authSession}
          setupRequired={authSetupRequired}
          loading={authLoading}
          error={authError}
          onSession={handleAuthSession}
          onLogout={handleLogout}
        />
      ) : page === "settings" ? (
        <SettingsPage
          organization={organization}
          files={storedFiles}
          onOrganizationChange={updateOrganization}
          buslessActions={buslessActions}
          onBuslessActionsChange={updateBuslessActions}
          selectedDivisionIds={selectedDivisionIds}
          onSelectedDivisionsChange={updateSelectedDivisions}
          onExportCsv={exportCsv}
          canExportCsv={filteredMovements.length > 0}
          isLoadingFiles={isLoadingFiles}
          isParsing={isParsing}
          uploadDivisionId={uploadDivisionId}
          onUploadDivisionChange={setUploadDivisionId}
          fileInputRef={inputRef}
          onUploadFiles={handleFiles}
          onToggleFile={toggleStoredFile}
          onMoveFile={moveStoredFile}
          onMoveFileDivision={moveStoredFileToDivision}
          onReparseFiles={reparseStoredFiles}
          onDeleteFile={removeStoredFile}
          canManageServer={!accountsAvailable() || authSession?.account.role === "admin"}
          isAdmin={authSession?.account.role === "admin"}
          wageSettings={authSession ? wageSettings : undefined}
          onWageSettingsChange={saveLocalWageSettings}
          onWageSettingsDelete={removeLocalWageSettings}
        />
      ) : page === "guidance" ? (
        <DutyGuidance
          services={allServices}
          movements={allMovements}
          selectedServiceNumber={guidanceServiceNumber}
          onSelectService={setGuidanceServiceNumber}
          liveStatuses={liveResponse.statuses}
          liveSync={liveResponse.sync}
          currentTime={guidanceCurrentTime}
          liveCurrentTime={currentTime}
          timeOverride={guidanceTimeOverride}
          onTimeOverride={setGuidanceTimeOverride}
          isLocked={guidanceLocked}
          onLockedChange={updateGuidanceLock}
          isDemo={false}
          isToday={isToday}
          selectedDate={selectedDate}
          wageSettings={authSession ? wageSettings : undefined}
          personalEnabled={Boolean(authSession)}
        />
      ) : (
        <>
          <section className="controls">
            <label className="search-box">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={page === "loops" ? "Zoek op dienst, omloop, busnummer, lijn, rit of halte" : "Zoek op dienst, omloop, lijn, rit of halte"}
              />
            </label>
            <div className="control-switches">
              <label className="switch">
                <input type="checkbox" checked={includeNoLoop} onChange={(event) => setIncludeNoLoop(event.target.checked)} />
                <span>regels zonder omloop tonen</span>
              </label>
            </div>
          </section>

          {page === "loops" && isToday && (
            <div className="live-status-wrap">
              <LiveDataStatus sync={liveResponse.sync} currentTime={currentTime} />
              {liveResponse.diagnostics && (
                <details className="live-diagnostics">
                  <summary>Live-diagnostiek</summary>
                  <dl>
                    <div><dt>Aangeboden ritten</dt><dd>{liveResponse.diagnostics.requested}</dd></div>
                    <div><dt>Uniek gekoppeld</dt><dd>{liveResponse.diagnostics.matched}</dd></div>
                    <div><dt>Geen lijn/rit-match</dt><dd>{liveResponse.diagnostics.noLineOrTrip}</dd></div>
                    <div><dt>Geen passende tijd</dt><dd>{liveResponse.diagnostics.noMatchingTime}</dd></div>
                    <div><dt>Dubbelzinnig</dt><dd>{liveResponse.diagnostics.ambiguous}</dd></div>
                    <div><dt>Realtime-updates</dt><dd>{liveResponse.diagnostics.realtimeUpdates}</dd></div>
                    <div><dt>Met vertraging</dt><dd>{liveResponse.diagnostics.delayUpdates}</dd></div>
                    <div><dt>Voertuigupdates</dt><dd>{liveResponse.diagnostics.vehicleUpdates}</dd></div>
                  </dl>
                </details>
              )}
            </div>
          )}

          {isLoadingFiles ? (
            <LoadingState />
          ) : filteredMovements.length > 0 && page === "loops" ? (
            <>
              <TimelineChart
                loops={timelineLoops}
                movements={timelineMovements}
                frameHours={frameHours}
                onFrameHoursChange={setFrameHours}
                liveStatuses={liveResponse.statuses}
                currentTime={isToday ? currentTime : undefined}
              />
              <MovementTable movements={filteredMovements} isOpen={showDetails} onToggle={() => setShowDetails((value) => !value)} />
            </>
          ) : filteredMovements.length > 0 && page === "services" ? (
            <>
              <ServicesOverview services={services} movements={filteredMovements} />
              <MovementTable movements={filteredMovements} isOpen={showDetails} onToggle={() => setShowDetails((value) => !value)} />
            </>
          ) : (
            <section className="empty-state">
              <Table2 size={32} />
              <strong>Nog geen tabel</strong>
              <span>
                {selectedDivisionIds.length === 0
                  ? organization.divisions.length === 0
                    ? "Maak in Instellingen een divisie aan en deel daarna bestanden in."
                    : "Vink in Instellingen minimaal een divisie aan om een rooster te tonen."
                  : "Kies een datum met ingedeelde pdf's of sleep bestanden naar het juiste segment."}
              </span>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function DivisionSelectionPanel({
  organization,
  selectedDivisionIds,
  onChange,
}: {
  organization: OrganizationConfig;
  selectedDivisionIds: string[];
  onChange: (divisionIds: string[]) => void;
}) {
  function toggleDivision(divisionId: string) {
    const next = selectedDivisionIds.includes(divisionId)
      ? selectedDivisionIds.filter((id) => id !== divisionId)
      : [...selectedDivisionIds, divisionId];
    onChange(next);
  }

  return (
    <div className="division-selection-grid">
      {organization.divisions.length === 0 && (
        <p className="division-selection-empty">Maak hieronder eerst divisies aan.</p>
      )}
      {organization.concessions.map((concession) => {
        const divisions = organization.divisions.filter((division) => division.concessionId === concession.id);
        if (divisions.length === 0) {
          return null;
        }
        return (
          <fieldset className="division-selection-group" key={concession.id}>
            <legend>{concession.name}</legend>
            {divisions.map((division) => (
              <label key={division.id}>
                <input
                  type="checkbox"
                  checked={selectedDivisionIds.includes(division.id)}
                  onChange={() => toggleDivision(division.id)}
                />
                <span>{division.name}</span>
              </label>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function VehicleLink({
  vehicleId,
  className = "",
  children,
  title,
}: {
  vehicleId: string;
  className?: string;
  children?: React.ReactNode;
  title?: string;
}) {
  const compactId = vehicleId.trim();
  const vehicleSlug = compactId.toLowerCase().startsWith("qbz_") ? compactId : `qbz_${compactId}`;

  return (
    <a
      className={`vehicle-link ${className}`.trim()}
      href={`https://busposities.nl/voertuig/${encodeURIComponent(vehicleSlug)}`}
      target="_blank"
      rel="noreferrer"
      title={title ?? `Open Bus ${compactId} op Busposities.nl`}
      onClick={(event) => event.stopPropagation()}
    >
      {children ?? <><BusFront size={16} /> Bus {compactId}</>}
    </a>
  );
}

function LoadingState() {
  return (
    <section className="empty-state">
      <Loader2 className="spin" size={32} />
      <strong>Bestandendatabase laden</strong>
      <span>Opgeslagen pdf's worden opgehaald.</span>
    </section>
  );
}

function SettingsPage({
  organization,
  files,
  onOrganizationChange,
  buslessActions,
  onBuslessActionsChange,
  selectedDivisionIds,
  onSelectedDivisionsChange,
  onExportCsv,
  canExportCsv,
  isLoadingFiles,
  isParsing,
  uploadDivisionId,
  onUploadDivisionChange,
  fileInputRef,
  onUploadFiles,
  onToggleFile,
  onMoveFile,
  onMoveFileDivision,
  onReparseFiles,
  onDeleteFile,
  canManageServer,
  isAdmin,
  wageSettings,
  onWageSettingsChange,
  onWageSettingsDelete,
}: {
  organization: OrganizationConfig;
  files: StoredPdfFileSummary[];
  onOrganizationChange: (organization: OrganizationConfig) => Promise<void>;
  buslessActions: string[];
  onBuslessActionsChange: (actions: string[]) => Promise<void>;
  selectedDivisionIds: string[];
  onSelectedDivisionsChange: (divisionIds: string[]) => void;
  onExportCsv: () => void;
  canExportCsv: boolean;
  isLoadingFiles: boolean;
  isParsing: boolean;
  uploadDivisionId: string;
  onUploadDivisionChange: (divisionId: string) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onUploadFiles: (files: FileList | null) => Promise<void>;
  onToggleFile: (file: StoredPdfFileSummary) => Promise<void>;
  onMoveFile: (file: StoredPdfFileSummary, daySegment: DaySegment) => Promise<void>;
  onMoveFileDivision: (file: StoredPdfFileSummary, divisionId: string) => Promise<void>;
  onReparseFiles: () => Promise<void>;
  onDeleteFile: (file: StoredPdfFileSummary) => Promise<void>;
  canManageServer: boolean;
  isAdmin: boolean;
  wageSettings?: WageSettings;
  onWageSettingsChange: (settings: WageSettings) => Promise<void>;
  onWageSettingsDelete: () => Promise<void>;
}) {
  const [settingsTab, setSettingsTab] = useState<"general" | "files" | "client" | "server" | "accounts" | "achievements">("client");
  const [newAction, setNewAction] = useState("");
  const [newConcessionName, setNewConcessionName] = useState("");
  const [newDivisionName, setNewDivisionName] = useState("");
  const [newDivisionConcessionId, setNewDivisionConcessionId] = useState(
    () => organization.concessions[0]?.id ?? "",
  );

  useEffect(() => {
    if (!organization.concessions.some((concession) => concession.id === newDivisionConcessionId)) {
      setNewDivisionConcessionId(organization.concessions[0]?.id ?? "");
    }
  }, [newDivisionConcessionId, organization.concessions]);

  useEffect(() => {
    if (!isAdmin && (settingsTab === "accounts" || settingsTab === "achievements")) {
      setSettingsTab("client");
    }
  }, [isAdmin, settingsTab]);

  function addAction(event: React.FormEvent) {
    event.preventDefault();
    const action = newAction.trim();
    if (!action) {
      return;
    }
    onBuslessActionsChange([...buslessActions, action]);
    setNewAction("");
  }

  function addConcession(event: React.FormEvent) {
    event.preventDefault();
    const name = newConcessionName.trim();
    if (!name) {
      return;
    }
    const id = organizationItemId(name, organization.concessions.map((concession) => concession.id));
    void onOrganizationChange({
      ...organization,
      concessions: [...organization.concessions, { id, name }],
    });
    setNewConcessionName("");
  }

  function addDivision(event: React.FormEvent) {
    event.preventDefault();
    const name = newDivisionName.trim();
    if (!name || !newDivisionConcessionId) {
      return;
    }
    const id = organizationItemId(name, organization.divisions.map((division) => division.id));
    void onOrganizationChange({
      ...organization,
      divisions: [...organization.divisions, { id, name, concessionId: newDivisionConcessionId }],
    });
    setNewDivisionName("");
  }

  function moveDivision(division: Division, concessionId: string) {
    void onOrganizationChange({
      ...organization,
      divisions: organization.divisions.map((candidate) => (
        candidate.id === division.id ? { ...candidate, concessionId } : candidate
      )),
    });
  }

  function removeDivision(division: Division) {
    if (files.some((file) => file.divisionId === division.id)) {
      return;
    }
    void onOrganizationChange({
      ...organization,
      divisions: organization.divisions.filter((candidate) => candidate.id !== division.id),
    });
  }

  function removeConcession(concession: Concession) {
    if (organization.divisions.some((division) => division.concessionId === concession.id)) {
      return;
    }
    void onOrganizationChange({
      ...organization,
      concessions: organization.concessions.filter((candidate) => candidate.id !== concession.id),
    });
  }

  return (
    <section className="settings-page">
      <div className="settings-heading">
        <div className="settings-heading-title">
          <div>
            <h2>Instellingen</h2>
            <span>
              {settingsTab === "accounts"
                ? "Gebruikers en toegang beheren"
                : settingsTab === "achievements"
                  ? "Badges, voorwaarden en correcties beheren"
                  : settingsTab === "server"
                ? "Serverinstellingen voor alle clients"
                : settingsTab === "client"
                  ? "Alleen op dit apparaat"
                  : settingsTab === "files" ? "Pdf-bestanden en dagindeling" : "Algemene opties"}
            </span>
          </div>
        </div>
        <nav className="settings-tabs" aria-label="Instellingencategorieen" role="tablist">
          <button
            className={settingsTab === "general" ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={settingsTab === "general"}
            onClick={() => setSettingsTab("general")}
          >
            Algemeen
          </button>
          {canManageServer && (
            <button
              className={settingsTab === "files" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={settingsTab === "files"}
              onClick={() => setSettingsTab("files")}
            >
              Bestanden
            </button>
          )}
          <button
            className={settingsTab === "client" ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={settingsTab === "client"}
            onClick={() => setSettingsTab("client")}
          >
            Clientinstellingen
          </button>
          {canManageServer && (
            <button
              className={settingsTab === "server" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={settingsTab === "server"}
              onClick={() => setSettingsTab("server")}
            >
              Serverinstellingen
            </button>
          )}
          {isAdmin && (
            <button
              className={settingsTab === "accounts" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={settingsTab === "accounts"}
              onClick={() => setSettingsTab("accounts")}
            >
              Accounts
            </button>
          )}
          {isAdmin && (
            <button
              className={settingsTab === "achievements" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={settingsTab === "achievements"}
              onClick={() => setSettingsTab("achievements")}
            >
              Achievements
            </button>
          )}
        </nav>
      </div>

      <div className={["files", "accounts", "achievements"].includes(settingsTab) ? "settings-content settings-content-wide" : "settings-content"}>
        {settingsTab === "general" && (
          <section className="settings-group">
            <div className="settings-group-heading">
              <div>
                <h3>Export</h3>
                <span>Download de huidige selectie als CSV-bestand.</span>
              </div>
              <button className="secondary-button" type="button" onClick={onExportCsv} disabled={!canExportCsv}>
                <Download size={17} />
                CSV downloaden
              </button>
            </div>
          </section>
        )}

        {canManageServer && settingsTab === "files" && (
          <FileManagementTab
            files={files}
            organization={organization}
            isLoading={isLoadingFiles}
            isParsing={isParsing}
            uploadDivisionId={uploadDivisionId}
            onUploadDivisionChange={onUploadDivisionChange}
            fileInputRef={fileInputRef}
            onUploadFiles={onUploadFiles}
            onToggle={onToggleFile}
            onMove={onMoveFile}
            onMoveDivision={onMoveFileDivision}
            onReparseFiles={onReparseFiles}
            onDelete={onDeleteFile}
          />
        )}

        {settingsTab === "client" && (
          <>
            <section className="settings-group">
              <div className="settings-group-heading">
                <div>
                  <h3>Getoonde divisies</h3>
                  <span>Kies welke divisies in de overzichten en dienstbegeleiding worden geladen.</span>
                </div>
              </div>
              <DivisionSelectionPanel
                organization={organization}
                selectedDivisionIds={selectedDivisionIds}
                onChange={onSelectedDivisionsChange}
              />
            </section>
            {wageSettings && (
              <WageSettingsPanel
                settings={wageSettings}
                onSave={onWageSettingsChange}
                onDelete={onWageSettingsDelete}
              />
            )}
          </>
        )}

        {canManageServer && settingsTab === "server" && (
          <>
        <section className="settings-group">
          <div className="settings-group-heading">
            <div>
              <h3>Divisies en concessies</h3>
              <span>Bestanden horen bij een divisie; concessies groeperen alleen de divisies.</span>
            </div>
          </div>

          <div className="organization-tree">
            {organization.concessions.map((concession) => {
              const divisions = organization.divisions.filter((division) => division.concessionId === concession.id);
              return (
                <section className="concession-group" key={concession.id}>
                  <header>
                    <strong>{concession.name}</strong>
                    <span>{divisions.length} divisies</span>
                    <button
                      className="icon-button danger"
                      type="button"
                      disabled={divisions.length > 0}
                      onClick={() => removeConcession(concession)}
                      title={divisions.length > 0 ? "Verplaats of verwijder eerst de divisies" : `${concession.name} verwijderen`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </header>
                  <ul>
                    {divisions.length === 0 ? (
                      <li className="organization-empty">Nog geen divisies</li>
                    ) : divisions.map((division) => {
                      const fileCount = files.filter((file) => file.divisionId === division.id).length;
                      return (
                        <li key={division.id}>
                          <div>
                            <strong>{division.name}</strong>
                            <span>{fileCount} bestanden</span>
                          </div>
                          <label>
                            <span>Concessie</span>
                            <select
                              value={division.concessionId}
                              onChange={(event) => moveDivision(division, event.target.value)}
                            >
                              {organization.concessions.map((candidate) => (
                                <option value={candidate.id} key={candidate.id}>{candidate.name}</option>
                              ))}
                            </select>
                          </label>
                          <button
                            className="icon-button danger"
                            type="button"
                            disabled={fileCount > 0}
                            onClick={() => removeDivision(division)}
                            title={fileCount > 0 ? "Verplaats eerst de gekoppelde bestanden" : `${division.name} verwijderen`}
                          >
                            <Trash2 size={16} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>

          <div className="organization-add-grid">
            <form className="settings-add-action" onSubmit={addConcession}>
              <label htmlFor="new-concession">Nieuwe concessie</label>
              <div>
                <input
                  id="new-concession"
                  value={newConcessionName}
                  onChange={(event) => setNewConcessionName(event.target.value)}
                  placeholder="Bijvoorbeeld Zuid-Holland Noord"
                />
                <button className="secondary-button" type="submit" disabled={!newConcessionName.trim()}>
                  <Plus size={17} />
                  Toevoegen
                </button>
              </div>
            </form>
            <form className="settings-add-action" onSubmit={addDivision}>
              <label htmlFor="new-division">Nieuwe divisie</label>
              <div>
                <input
                  id="new-division"
                  value={newDivisionName}
                  onChange={(event) => setNewDivisionName(event.target.value)}
                  placeholder="Bijvoorbeeld GD"
                />
                <select
                  aria-label="Concessie voor nieuwe divisie"
                  value={newDivisionConcessionId}
                  onChange={(event) => setNewDivisionConcessionId(event.target.value)}
                >
                  {organization.concessions.map((concession) => (
                    <option value={concession.id} key={concession.id}>{concession.name}</option>
                  ))}
                </select>
                <button
                  className="secondary-button"
                  type="submit"
                  disabled={!newDivisionName.trim() || !newDivisionConcessionId}
                >
                  <Plus size={17} />
                  Toevoegen
                </button>
              </div>
            </form>
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group-heading">
            <div>
              <h3>Busloze acties</h3>
              <span>{buslessActions.length} acties</span>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onBuslessActionsChange([...DEFAULT_BUSLESS_ACTIONS])}
            >
              <RotateCcw size={16} />
              Standaard
            </button>
          </div>

          <ul className="settings-action-list">
            {buslessActions.map((action) => (
              <li key={action.toLocaleLowerCase("nl")}>
                <span>{action}</span>
                <button
                  className="icon-button danger"
                  type="button"
                  onClick={() => onBuslessActionsChange(buslessActions.filter((candidate) => candidate !== action))}
                  title={`${action} verwijderen`}
                >
                  <Trash2 size={17} />
                </button>
              </li>
            ))}
          </ul>

          <form className="settings-add-action" onSubmit={addAction}>
            <label htmlFor="new-busless-action">Nieuwe actie</label>
            <div>
              <input
                id="new-busless-action"
                value={newAction}
                onChange={(event) => setNewAction(event.target.value)}
                placeholder="Naam op het dienstblad"
              />
              <button className="secondary-button" type="submit" disabled={!newAction.trim()}>
                <Plus size={17} />
                Toevoegen
              </button>
            </div>
          </form>
        </section>
          </>
        )}

        {isAdmin && settingsTab === "accounts" && <AccountManagement />}
        {isAdmin && settingsTab === "achievements" && <AchievementManagement divisions={organization.divisions} />}
      </div>
    </section>
  );
}

function FileManagementTab({
  files,
  organization,
  isLoading,
  isParsing,
  uploadDivisionId,
  onUploadDivisionChange,
  fileInputRef,
  onUploadFiles,
  onToggle,
  onMove,
  onMoveDivision,
  onReparseFiles,
  onDelete,
}: {
  files: StoredPdfFileSummary[];
  organization: OrganizationConfig;
  isLoading: boolean;
  isParsing: boolean;
  uploadDivisionId: string;
  onUploadDivisionChange: (divisionId: string) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onUploadFiles: (files: FileList | null) => Promise<void>;
  onToggle: (file: StoredPdfFileSummary) => Promise<void>;
  onMove: (file: StoredPdfFileSummary, daySegment: DaySegment) => Promise<void>;
  onMoveDivision: (file: StoredPdfFileSummary, divisionId: string) => Promise<void>;
  onReparseFiles: () => Promise<void>;
  onDelete: (file: StoredPdfFileSummary) => Promise<void>;
}) {
  return (
    <div className="settings-files-tab">
      <label className="upload-division">
        <span>Nieuwe bestanden horen bij</span>
        <select value={uploadDivisionId} onChange={(event) => onUploadDivisionChange(event.target.value)}>
          <option value="">Nog niet ingedeeld</option>
          {organization.concessions.map((concession) => (
            <optgroup label={concession.name} key={concession.id}>
              {organization.divisions
                .filter((division) => division.concessionId === concession.id)
                .map((division) => <option value={division.id} key={division.id}>{division.name}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      <section
        role="button"
        tabIndex={0}
        aria-disabled={isParsing}
        className="dropzone"
        onClick={() => {
          if (!isParsing) {
            fileInputRef.current?.click();
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (!isParsing) {
            void onUploadFiles(event.dataTransfer.files);
          }
        }}
        onKeyDown={(event) => {
          if (!isParsing && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          onChange={(event) => void onUploadFiles(event.target.files)}
        />
        <div className="dropzone-icon">
          {isParsing ? <Loader2 className="spin" size={28} /> : <Upload size={28} />}
        </div>
        <div>
          <strong>{isParsing ? "Pdf's worden gelezen" : "Sleep 1 of meerdere diensten-pdf's hierheen"}</strong>
          <span>Alle verwerking gebeurt lokaal in deze app.</span>
        </div>
      </section>

      <div className="settings-group-heading file-reparse-heading">
        <div>
          <h3>Opgeslagen pdf's opnieuw uitlezen</h3>
          <span>Vult nieuwe velden, zoals materieelsoort, aan zonder bestanden opnieuw te uploaden.</span>
        </div>
        <button className="secondary-button" type="button" onClick={() => void onReparseFiles()} disabled={isParsing || files.length === 0}>
          {isParsing ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
          {isParsing ? "Pdf's opnieuw lezen..." : "Opnieuw uitlezen"}
        </button>
      </div>

      <FilesPage
        files={files}
        organization={organization}
        isLoading={isLoading}
        onToggle={onToggle}
        onMove={onMove}
        onMoveDivision={onMoveDivision}
        onDelete={onDelete}
      />
    </div>
  );
}

function FilesPage({
  files,
  organization,
  isLoading,
  onToggle,
  onMove,
  onMoveDivision,
  onDelete,
}: {
  files: StoredPdfFileSummary[];
  organization: OrganizationConfig;
  isLoading: boolean;
  onToggle: (file: StoredPdfFileSummary) => Promise<void>;
  onMove: (file: StoredPdfFileSummary, daySegment: DaySegment) => Promise<void>;
  onMoveDivision: (file: StoredPdfFileSummary, divisionId: string) => Promise<void>;
  onDelete: (file: StoredPdfFileSummary) => Promise<void>;
}) {
  if (isLoading) {
    return <LoadingState />;
  }

  const visibleSegments = DAY_SEGMENTS.filter((segment) => {
    return segment.id !== "unassigned" || files.some((file) => file.daySegment === "unassigned");
  });

  return (
    <section className="files-section">
      <div className="section-heading">
        <div>
          <h2>Geuploade bestanden</h2>
          <span>{files.length} opgeslagen pdf-bestanden</span>
        </div>
      </div>

      <div className="segment-grid" style={{ gridTemplateColumns: `repeat(${visibleSegments.length}, minmax(230px, 1fr))` }}>
        {visibleSegments.map((segment) => {
          const segmentFiles = files.filter((file) => file.daySegment === segment.id);

          return (
            <section
              className="segment-column"
              key={segment.id}
              onDragEnter={(event) => event.currentTarget.classList.add("drag-over")}
              onDragLeave={(event) => event.currentTarget.classList.remove("drag-over")}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.currentTarget.classList.remove("drag-over");
                const fileId = event.dataTransfer.getData("text/plain");
                const file = files.find((item) => item.id === fileId);

                if (file && file.daySegment !== segment.id) {
                  void onMove(file, segment.id);
                }
              }}
            >
              <header>
                <div>
                  <strong>{segment.label}</strong>
                  <span>{segment.description}</span>
                </div>
                <em>{segmentFiles.length}</em>
              </header>

              <div className="file-list">
                {segmentFiles.length === 0 ? (
                  <p className="segment-empty">Sleep bestanden hierheen.</p>
                ) : (
                  segmentFiles.map((file) => (
                    <article
                      className={!file.enabled ? "file-card disabled" : "file-card"}
                      draggable
                      key={file.id}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", file.id);
                        event.currentTarget.classList.add("dragging");
                      }}
                      onDragEnd={(event) => {
                        event.currentTarget.classList.remove("dragging");
                      }}
                    >
                      <div>
                        <strong>{file.name}</strong>
                        <span>
                          {formatFileSize(file.size)} - {file.serviceCount} diensten - {file.movementCount} regels
                        </span>
                        <small>Toegevoegd {formatDateTime(file.uploadedAt)}</small>
                        <label className="file-division">
                          <span>Divisie</span>
                          <select
                            value={file.divisionId}
                            onChange={(event) => void onMoveDivision(file, event.target.value)}
                          >
                            <option value="">Nog niet ingedeeld</option>
                            {organization.concessions.map((concession) => (
                              <optgroup label={concession.name} key={concession.id}>
                                {organization.divisions
                                  .filter((division) => division.concessionId === concession.id)
                                  .map((division) => (
                                    <option value={division.id} key={division.id}>{division.name}</option>
                                  ))}
                              </optgroup>
                            ))}
                          </select>
                        </label>
                        <div className="segment-actions" aria-label="Bestand verplaatsen">
                          {DAY_SEGMENTS.map((targetSegment) => (
                            <button
                              className={file.daySegment === targetSegment.id ? "active" : ""}
                              disabled={file.daySegment === targetSegment.id}
                              key={targetSegment.id}
                              type="button"
                              onClick={() => void onMove(file, targetSegment.id)}
                            >
                              {targetSegment.id === "unassigned" ? "Niet ingedeeld" : targetSegment.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="file-actions">
                        <button className="secondary-button" type="button" onClick={() => void onToggle(file)}>
                          {file.enabled ? <EyeOff size={16} /> : <Eye size={16} />}
                          {file.enabled ? "Uitzetten" : "Aanzetten"}
                        </button>
                        <button className="secondary-button danger" type="button" onClick={() => void onDelete(file)}>
                          <Trash2 size={16} />
                          Verwijderen
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function ServicesOverview({ services, movements }: { services: Dienst[]; movements: Movement[] }) {
  return (
    <section className="services-section">
      <div className="section-heading">
        <div>
          <h2>Diensten overzicht</h2>
          <span>{services.length} diensten met rit- en dienstregels</span>
        </div>
      </div>

      <div className="service-list">
        {services.map((dienst) => {
          const serviceMovements = movements
            .filter((movement) => movement.dienstnummer === dienst.serviceNumber)
            .sort((a, b) => (parseTime(a.vertrek) ?? 0) - (parseTime(b.vertrek) ?? 0));
          const vehicleMovements = serviceMovements.filter((movement) => isVehicleTimelineMovement(movement));
          const loops = [...new Set(vehicleMovements.map((movement) => displayLoopNumber(loopKey(movement))))];

          return (
            <article className="service-card" key={dienst.id}>
              <header>
                <div>
                  <strong>{dienst.serviceNumber}</strong>
                  <span>
                    {dienst.start ?? "--:--"} - {dienst.end ?? "--:--"}
                  </span>
                </div>
                <em>{loops.length > 0 ? loops.join(", ") : "geen omloop"}</em>
              </header>

              <div className="service-movements">
                {serviceMovements.map((movement) => (
                  <div className="service-movement" key={movement.id}>
                    <strong className="service-movement-times">
                      <span>{movement.vertrek}</span>
                      <span>{movement.aankomst}</span>
                    </strong>
                    <strong className="service-movement-line-number">
                      {movement.lijnnummer ? formatLineLabel(movement.lijnnummer, movement.type) : ""}
                    </strong>
                    <div className="service-movement-details">
                      <span>{formatServiceRoute(movement)}</span>
                      {isVehicleTimelineMovement(movement) && compactLoopNumber(movement.omloopnummer) && (
                        <em>{displayLoopNumber(compactLoopNumber(movement.omloopnummer))}</em>
                      )}
                      <small>{formatServiceMovementLabel(movement)}</small>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

type GuidanceEntry = {
  movement: Movement;
  timing: TimelineTiming;
};

type GuidanceLiveInfo = {
  vehicleId?: string;
  delaySeconds?: number;
  handoverDelaySeconds?: number;
  handoverExpectedAt?: number;
  handoverDepartureExpectedAt?: number;
  handoverArrived?: boolean;
  handoverDeparted?: boolean;
  handoverStopSpecific?: boolean;
  handoverPlannedTime?: string;
  arrivalDelaySeconds?: number;
  arrivalExpectedAt?: number;
  arrivalStopSpecific?: boolean;
};

type GuidanceTakeover = {
  entry: GuidanceEntry;
};

type TakeoverArrivalInfo = {
  plannedArrival: string;
  expectedAt?: number;
  delaySeconds?: number;
  stopSpecific?: boolean;
  vehicleId?: string;
};

type GuidanceTakeoverDisplay = ReturnType<typeof calculateTakeoverStatus> & {
  hasLiveData: boolean;
  delaySeconds: number;
  expectedArrival: string;
  plannedArrival: string;
  timingLabel: string;
  vehicleId?: string;
};

const LIVE_STALE_AFTER_SECONDS = 90;

function LiveDataStatus({
  sync,
  currentTime,
  className = "",
  label = "Qbuzz live",
}: {
  sync: LiveSyncState;
  currentTime: Date;
  className?: string;
  label?: string;
}) {
  const ageSeconds = sync.fetchedAt === undefined
    ? undefined
    : Math.max(0, Math.floor(currentTime.getTime() / 1000) - sync.fetchedAt);
  const stale = ageSeconds !== undefined && ageSeconds > LIVE_STALE_AFTER_SECONDS;
  const stateClass = stale ? "state-stale" : `state-${sync.state}`;
  const heading = stale
    ? `Pas op! Livegegevens al ${formatLiveAge(ageSeconds)} niet ververst`
    : sync.state === "syncing"
      ? "Livegegevens verversen..."
      : sync.state === "error"
        ? "Livegegevens konden niet worden ververst"
        : sync.state === "ready"
          ? `${label} bijgewerkt`
          : label;
  const detail = sync.fetchedAt === undefined
    ? sync.message
    : `Laatste feed ${formatEpochClock(sync.fetchedAt)} - ${formatLiveAge(ageSeconds ?? 0)} geleden`;

  return (
    <div className={`live-data-status ${stateClass} ${className}`.trim()} role={stale || sync.state === "error" ? "alert" : "status"} title={sync.message}>
      {stale || sync.state === "error"
        ? <AlertTriangle size={17} aria-hidden="true" />
        : <Clock3 size={17} aria-hidden="true" />}
      <div>
        <strong className="live-data-status-heading">
          {heading}
          {sync.state === "syncing" && (
            <Loader2 className="live-data-status-spinner spin" size={14} aria-label="Livegegevens worden opgehaald" />
          )}
        </strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function formatLiveAge(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} sec`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours} uur` : `${hours} uur ${remainingMinutes} min`;
}

function DutyGuidance({
  services,
  movements,
  selectedServiceNumber,
  onSelectService,
  liveStatuses,
  liveSync,
  currentTime,
  liveCurrentTime,
  timeOverride,
  onTimeOverride,
  isLocked,
  onLockedChange,
  isDemo,
  isToday,
  selectedDate,
  wageSettings,
  personalEnabled,
}: {
  services: Dienst[];
  movements: Movement[];
  selectedServiceNumber: string;
  onSelectService: (value: string) => void;
  liveStatuses: LiveMovementStatus[];
  liveSync: LiveSyncState;
  currentTime: Date;
  liveCurrentTime: Date;
  timeOverride: string;
  onTimeOverride: (value: string) => void;
  isLocked: boolean;
  onLockedChange: (locked: boolean) => void;
  isDemo: boolean;
  isToday: boolean;
  selectedDate: string;
  wageSettings?: WageSettings;
  personalEnabled: boolean;
}) {
  const serviceNumbers = [...new Set(services.map((service) => service.serviceNumber))].sort((a, b) => serviceSortKey(a) - serviceSortKey(b));
  const selectedService = services.find((service) => service.serviceNumber.toLowerCase() === selectedServiceNumber.trim().toLowerCase());
  const serviceMovements = selectedService
    ? movements.filter((movement) => movement.dienstnummer === selectedService.serviceNumber)
    : [];
  const entries = buildGuidanceEntries(serviceMovements);
  const statusByMovementId = new Map(liveStatuses.map((status) => [status.movementId, status]));
  const loopSnapshots = buildLoopLiveSnapshots(movements, statusByMovementId, currentTime);
  const currentMinute = alignMinuteToEntries(currentTime);
  const currentIndex = entries.findIndex((entry) => entry.timing.start <= currentMinute && entry.timing.end > currentMinute);
  const nextIndex = currentIndex >= 0
    ? currentIndex + 1
    : entries.findIndex((entry) => entry.timing.start > currentMinute);
  const currentEntry = currentIndex >= 0 ? entries[currentIndex] : undefined;
  const nextEntry = nextIndex >= 0 && nextIndex < entries.length ? entries[nextIndex] : undefined;
  const takeoversByMovementId = buildGuidanceTakeovers(entries, movements);
  const currentLive = currentEntry ? guidanceLiveInfo(currentEntry, statusByMovementId, loopSnapshots, currentMinute, true) : {};
  const nextLive = nextEntry ? guidanceLiveInfo(nextEntry, statusByMovementId, loopSnapshots, currentMinute, true) : {};
  const currentTakeover = currentEntry ? takeoversByMovementId.get(currentEntry.movement.id) : undefined;
  const nextTakeover = nextEntry ? takeoversByMovementId.get(nextEntry.movement.id) : undefined;
  const currentTakeoverArrival = currentTakeover ? findTakeoverArrival(currentTakeover, movements, statusByMovementId) : undefined;
  const nextTakeoverArrival = nextTakeover ? findTakeoverArrival(nextTakeover, movements, statusByMovementId) : undefined;
  const currentFallback = entries.length === 0
    ? "Geen dienstregels beschikbaar"
    : currentMinute < entries[0].timing.start
      ? "Dienst nog niet gestart"
      : currentMinute >= entries.at(-1)!.timing.end
        ? "Dienst afgerond"
        : "Tussen twee acties";
  const wageEstimate = selectedService && wageSettings
    ? calculateDutyWage(selectedService, serviceMovements, selectedDate, currentTime, wageSettings)
    : undefined;

  return (
    <div className="guidance-page">
      <div className="guidance-debug-row">
        {isToday ? (
          <LiveDataStatus sync={liveSync} currentTime={liveCurrentTime} className="guidance-live-status" label={isDemo ? "Demo-live" : "OVapi live"} />
        ) : (
          <div className="guidance-live-state">
            <span>Planning</span>
            <small>Live informatie is alleen beschikbaar voor vandaag.</small>
          </div>
        )}
      </div>

      <section className={isLocked ? "guidance-selector is-locked" : "guidance-selector"}>
        <div className="guidance-selector-title">
          <p className="eyebrow">Dienstbegeleiding</p>
          <h2>Mijn dienst</h2>
        </div>
        {isLocked ? (
          <div className="guidance-locked-service">
            <span>Dienst</span>
            <strong>{selectedService?.serviceNumber ?? selectedServiceNumber}</strong>
          </div>
        ) : (
          <>
            <label className="guidance-service-input">
              <span>Dienstnummer</span>
              <input
                list="guidance-services"
                value={selectedServiceNumber}
                onChange={(event) => onSelectService(event.target.value)}
                placeholder={serviceNumbers[0] ?? "V5001"}
              />
              <datalist id="guidance-services">
                {serviceNumbers.map((serviceNumber) => <option key={serviceNumber} value={serviceNumber} />)}
              </datalist>
            </label>
            <label className="guidance-time-input" title="Verandert alleen de weergave van dienstbegeleiding.">
              <span>Testtijd</span>
              <input type="time" value={timeOverride} onChange={(event) => onTimeOverride(event.target.value)} />
            </label>
          </>
        )}
        <label className="guidance-lock-toggle">
          <input
            type="checkbox"
            checked={isLocked}
            disabled={!selectedService && !isLocked}
            onChange={(event) => onLockedChange(event.target.checked)}
          />
          <span>{isLocked ? <Lock size={17} /> : <LockOpen size={17} />}</span>
          <strong>{isLocked ? "Vastgezet" : "Vastzetten"}</strong>
        </label>
      </section>

      {!selectedService ? (
        <section className="empty-state guidance-empty">
          <Navigation size={34} />
          <strong>{selectedServiceNumber ? "Dienst niet gevonden" : "Kies een dienstnummer"}</strong>
          <span>{serviceNumbers.length} diensten beschikbaar voor {segmentLabel(daySegmentForDate(todayInputValue()))}.</span>
        </section>
      ) : (
        <>
          <section className="guidance-focus">
            <header className="guidance-duty-heading">
              <div>
                <strong>{selectedService.serviceNumber}</strong>
                <span>{selectedService.start ?? entries[0]?.movement.vertrek ?? "--:--"} - {selectedService.end ?? entries.at(-1)?.movement.aankomst ?? "--:--"}</span>
              </div>
              <div className="guidance-duty-status">
                {wageEstimate && (
                  <span className="guidance-wage" title="Schatting van basisloon plus ORT, exclusief vakantietoeslagen.">
                    <small>Geschat bruto</small>
                    <strong>{formatEuroCents(wageEstimate.earnedCents)} / {formatEuroCents(wageEstimate.totalCents)}</strong>
                  </span>
                )}
                <time>{formatClock(currentTime)}</time>
              </div>
            </header>

            <div className={`guidance-actions${!currentEntry && nextEntry ? " next-only" : ""}`}>
              {currentEntry || !nextEntry ? (
                <GuidanceAction label="Huidige actie" entry={currentEntry} live={currentLive} fallback={currentFallback} takeover={currentTakeover} takeoverArrival={currentTakeoverArrival} currentMinute={currentMinute} active />
              ) : null}
              <GuidanceAction label="Volgende actie" entry={nextEntry} live={nextLive} fallback="Geen volgende actie" takeover={nextTakeover} takeoverArrival={nextTakeoverArrival} currentMinute={currentMinute} active={!currentEntry && Boolean(nextEntry)} />
            </div>
          </section>

          {personalEnabled && (
            <DutyConfirmation
              service={selectedService}
              operationalDate={selectedDate}
              dutyFinished={currentMinute >= (entries.at(-1)?.timing.end ?? Number.POSITIVE_INFINITY)}
            />
          )}

          <section className="guidance-sequence">
            <div className="section-heading">
              <div>
                <h2>Volledige dienst</h2>
                <span>{entries.length} acties</span>
              </div>
            </div>
            <ol className="guidance-list">
              {entries.map((entry, index) => {
                const state = index === currentIndex ? "current" : index === nextIndex ? "next" : entry.timing.end <= currentMinute ? "past" : "future";
                const useLoopFallback = entry.timing.end >= currentMinute - 120 && entry.timing.start <= currentMinute + 120;
                const live = guidanceLiveInfo(entry, statusByMovementId, loopSnapshots, currentMinute, useLoopFallback);
                const takeover = takeoversByMovementId.get(entry.movement.id);

                return (
                  <Fragment key={entry.movement.id}>
                    {takeover && <GuidanceTakeover takeover={takeover} live={live} arrival={findTakeoverArrival(takeover, movements, statusByMovementId)} currentMinute={currentMinute} />}
                    <li className={`guidance-row ${state}`}>
                      <time>
                        <span>{entry.movement.vertrek}</span>
                        <span>{entry.movement.aankomst}</span>
                      </time>
                      <span className="guidance-marker" aria-hidden="true" />
                      <div className="guidance-row-main">
                        <GuidanceMovementIdentity movement={entry.movement} variant="row" />
                        <div className="guidance-row-copy">
                          <strong>{guidanceActionTitle(entry.movement)}</strong>
                          <span>{guidanceActionSubtitle(entry.movement)}</span>
                          <div className="guidance-badges">
                            {entry.movement.omloopnummer && <em>Omloop {displayLoopNumber(entry.movement.omloopnummer)}</em>}
                            {live.vehicleId && <VehicleLink vehicleId={live.vehicleId} className="bus-badge" />}
                          </div>
                        </div>
                      </div>
                      {(state === "current" || state === "next") && <b>{state === "current" ? "NU" : "HIERNA"}</b>}
                    </li>
                  </Fragment>
                );
              })}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}

function GuidanceAction({
  label,
  entry,
  live,
  fallback,
  takeover,
  takeoverArrival,
  currentMinute,
  active = false,
}: {
  label: string;
  entry?: GuidanceEntry;
  live: GuidanceLiveInfo;
  fallback: string;
  takeover?: GuidanceTakeover;
  takeoverArrival?: TakeoverArrivalInfo;
  currentMinute: number;
  active?: boolean;
}) {
  return (
    <article className={active ? "guidance-action active" : "guidance-action"}>
      <header>
        <span>{label}</span>
        {entry && (
          <time>
            <strong>{entry.movement.vertrek}</strong>
            <span> - {entry.movement.aankomst}</span>
          </time>
        )}
      </header>
      {entry ? (
        <div className="guidance-action-identity">
          <GuidanceMovementIdentity movement={entry.movement} variant="panel" />
          <div>
            <strong>{guidanceActionTitle(entry.movement)}</strong>
            <p>{guidanceActionSubtitle(entry.movement)}</p>
          </div>
        </div>
      ) : <strong>{fallback}</strong>}
      {entry && (
        <div className="guidance-action-meta">
          {entry.movement.omloopnummer && <span>Omloop {displayLoopNumber(entry.movement.omloopnummer)}</span>}
          {live.vehicleId && <VehicleLink vehicleId={live.vehicleId} className="bus-badge" />}
        </div>
      )}
      {takeover && <GuidanceTakeoverAlert takeover={takeover} arrival={takeoverArrival} live={live} currentMinute={currentMinute} />}
    </article>
  );
}

function GuidanceMovementIdentity({ movement, variant }: { movement: Movement; variant: "panel" | "row" }) {
  return <span className={`guidance-identity ${variant}${movement.lijnnummer ? " line" : " type"}`}>{guidanceIdentityLabel(movement)}</span>;
}

function GuidanceTakeoverAlert({ takeover, arrival, live, currentMinute }: { takeover: GuidanceTakeover; arrival?: TakeoverArrivalInfo; live: GuidanceLiveInfo; currentMinute: number }) {
  const display = guidanceTakeoverDisplay(takeover, arrival, live, currentMinute);
  if (!display.shouldShowTopAlert) {
    return null;
  }

  const showDifference = Math.abs(display.delaySeconds) > 60;
  const arrivalVerb = display.phase === "arrived" ? "aangekomen om" : "aankomst";

  return (
    <div className={`guidance-action-takeover ${display.tone}`}>
      <strong>Overname bij {takeover.entry.movement.van || "halte"}</strong>
      <span>
        {display.vehicleId ? <><VehicleLink vehicleId={display.vehicleId} className="vehicle-inline-link">Bus {display.vehicleId}</VehicleLink>{" "}</> : "Bus "}
        {`${arrivalVerb} ${display.expectedArrival}${showDifference ? ` (${formatHandoverDifference(display.delaySeconds)})` : ""}, ${formatDepartureWindow(display.minutesToDeparture, takeover.entry.movement.vertrek)}`}
      </span>
    </div>
  );
}

function GuidanceTakeover({ takeover, live, arrival, currentMinute }: { takeover: GuidanceTakeover; live: GuidanceLiveInfo; arrival?: TakeoverArrivalInfo; currentMinute: number }) {
  const { movement } = takeover.entry;
  const display = guidanceTakeoverDisplay(takeover, arrival, live, currentMinute);
  const location = movement.van || "de overnamehalte";
  const showDifference = Math.abs(display.delaySeconds) > 60;
  const statusDetail = display.phase === "arrived"
    ? `Aangekomen om ${display.expectedArrival}`
    : display.phase === "departed"
      ? `${display.timingLabel} ${display.expectedArrival}`
      : `${display.timingLabel} ${display.expectedArrival}${showDifference ? ` (${formatHandoverDifference(display.delaySeconds)})` : ""}`;

  return (
    <li className={`guidance-takeover${display.hasLiveData ? ` ${display.tone}` : ""}${display.phase === "departed" ? " past" : ""}${display.vehicleId ? " has-bus" : ""}${movement.omloopnummer ? " has-loop" : ""}`}>
      <span className="guidance-takeover-rail" aria-hidden="true" />
      <div className="guidance-takeover-info">
        <strong>Overname</strong>
        <span>{location} - gepland: aankomst {display.plannedArrival}, vertrek {movement.vertrek}</span>
      </div>
      {display.vehicleId && (
        <VehicleLink vehicleId={display.vehicleId} className="guidance-takeover-bus">
          <BusFront size={20} />
          <span>Bus</span>
          <strong>{display.vehicleId}</strong>
        </VehicleLink>
      )}
      {movement.omloopnummer && (
        <div className="guidance-takeover-loop" title={`Omloop ${displayLoopNumber(movement.omloopnummer)}`}>
          <span>Omloop</span>
          <strong>{displayLoopNumber(movement.omloopnummer)}</strong>
        </div>
      )}
      {display.hasLiveData && (
        <div className="guidance-takeover-status">
          <span>{display.statusLabel}</span>
          <strong>{statusDetail}</strong>
        </div>
      )}
    </li>
  );
}

function TimelineChart({
  loops,
  movements,
  frameHours,
  onFrameHoursChange,
  liveStatuses,
  currentTime,
}: {
  loops: string[];
  movements: Movement[];
  frameHours: number;
  onFrameHoursChange: (value: number) => void;
  liveStatuses: LiveMovementStatus[];
  currentTime?: Date;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialScrollKeyRef = useRef("");
  const pinchRef = useRef<{ startDistance: number; startHours: number; lastHours: number } | undefined>(undefined);
  const pinchAnchorRef = useRef<{ minute: number; viewportX: number } | undefined>(undefined);
  const [frameWidth, setFrameWidth] = useState(0);
  const [selectedMovement, setSelectedMovement] = useState<Movement | undefined>();
  const range = getTimelineRange(movements, frameHours);
  const totalMinutes = Math.max(frameHours * 60, range.end - range.start);
  const loopColumnWidth = frameWidth > 0 && frameWidth <= 760 ? MOBILE_LOOP_COLUMN_WIDTH : DESKTOP_LOOP_COLUMN_WIDTH;
  const visibleTrackWidth = Math.max(frameWidth > 0 && frameWidth <= 760 ? 220 : 360, (frameWidth || 1250) - loopColumnWidth);
  const hourWidth = visibleTrackWidth / frameHours;
  const minuteWidth = hourWidth / 60;
  const contentWidth = totalMinutes * minuteWidth;
  const ticks = buildHourTicks(range.start, range.start + totalMinutes);
  const labelInterval = Math.max(1, Math.ceil(60 / hourWidth));
  const liveStatusByMovementId = useMemo(() => new Map(liveStatuses.map((status) => [status.movementId, status])), [liveStatuses]);
  const currentMinute = currentTime ? currentTime.getHours() * 60 + currentTime.getMinutes() + currentTime.getSeconds() / 60 : undefined;
  const currentTimelineMinute = currentMinute === undefined ? undefined : alignCurrentMinute(currentMinute, range);
  const selectedLoopVehicleId = useMemo(() => {
    if (!selectedMovement?.omloopnummer) {
      return undefined;
    }
    const selectedLoop = loopKey(selectedMovement);
    const timedLoopMovements = movements
      .filter((movement) => loopKey(movement) === selectedLoop)
      .map((movement) => ({ movement, timing: getMovementTiming(movement) }))
      .filter((item): item is { movement: Movement; timing: TimelineTiming } => item.timing !== undefined)
      .sort((first, second) => first.timing.start - second.timing.start);

    return liveInfoForLoop(timedLoopMovements, liveStatusByMovementId, currentTimelineMinute).vehicleId;
  }, [currentTimelineMinute, liveStatusByMovementId, movements, selectedMovement]);

  useEffect(() => {
    const frame = frameRef.current;

    if (!frame) {
      return;
    }

    const updateWidth = () => setFrameWidth(frame.clientWidth);
    const observer = new ResizeObserver(updateWidth);
    updateWidth();
    observer.observe(frame);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }

    const touchDistance = (touches: TouchList) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
    const touchCenterX = (touches: TouchList) => (touches[0].clientX + touches[1].clientX) / 2;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        return;
      }
      const rect = scroll.getBoundingClientRect();
      const viewportX = touchCenterX(event.touches) - rect.left;
      const contentX = scroll.scrollLeft + viewportX - loopColumnWidth;
      pinchRef.current = {
        startDistance: touchDistance(event.touches),
        startHours: frameHours,
        lastHours: frameHours,
      };
      pinchAnchorRef.current = {
        minute: range.start + Math.max(0, contentX) / minuteWidth,
        viewportX,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const pinch = pinchRef.current;
      if (!pinch || event.touches.length !== 2) {
        return;
      }
      event.preventDefault();
      const distance = touchDistance(event.touches);
      if (distance <= 0) {
        return;
      }
      const nextHours = clampFrameHours(pinch.startHours * pinch.startDistance / distance);
      if (nextHours !== pinch.lastHours) {
        pinch.lastHours = nextHours;
        onFrameHoursChange(nextHours);
      }
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        pinchRef.current = undefined;
      }
    };

    scroll.addEventListener("touchstart", handleTouchStart, { passive: true });
    scroll.addEventListener("touchmove", handleTouchMove, { passive: false });
    scroll.addEventListener("touchend", handleTouchEnd, { passive: true });
    scroll.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    return () => {
      scroll.removeEventListener("touchstart", handleTouchStart);
      scroll.removeEventListener("touchmove", handleTouchMove);
      scroll.removeEventListener("touchend", handleTouchEnd);
      scroll.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [frameHours, loopColumnWidth, minuteWidth, onFrameHoursChange, range.start]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const anchor = pinchAnchorRef.current;
    if (!scroll || !anchor || !pinchRef.current) {
      return;
    }
    scroll.scrollLeft = Math.max(
      0,
      loopColumnWidth + (anchor.minute - range.start) * minuteWidth - anchor.viewportX,
    );
  }, [frameHours, loopColumnWidth, minuteWidth, range.start]);

  useEffect(() => {
    if (!selectedMovement) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedMovement(undefined);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [selectedMovement]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || currentTimelineMinute === undefined || frameWidth === 0) {
      return;
    }

    const scrollKey = `${range.start}-${range.end}`;
    if (initialScrollKeyRef.current === scrollKey) {
      return;
    }
    initialScrollKeyRef.current = scrollKey;
    const currentPosition = loopColumnWidth + (currentTimelineMinute - range.start) * minuteWidth;
    scroll.scrollLeft = Math.max(0, currentPosition - scroll.clientWidth * 0.42);
  }, [currentTimelineMinute, frameHours, frameWidth, loopColumnWidth, minuteWidth, range.end, range.start]);

  return (
    <section className="timeline-section">
      <div className="section-heading">
        <h2>Tijdlijn per omloop</h2>
        <label className="hours-field">
          <span>{loops.length} omlooprijen, toon</span>
          <input
            type="number"
            min={1}
            max={24}
            step={1}
            value={frameHours}
            onChange={(event) => onFrameHoursChange(clampFrameHours(Number(event.target.value)))}
          />
          <span>uur</span>
        </label>
      </div>

      <div
        ref={frameRef}
        className="timeline-frame"
        style={{ width: "100%" }}
      >
        <div className="timeline-scroll" ref={scrollRef}>
          <div
            className="timeline-grid"
            style={{
              width: `${contentWidth + loopColumnWidth}px`,
              gridTemplateColumns: `${loopColumnWidth}px ${contentWidth}px`,
            }}
          >
            <div className="timeline-corner"><span>Omloopnummer</span></div>
            <div className="time-axis" style={{ width: `${contentWidth}px`, backgroundSize: `${hourWidth}px 100%` }}>
              {ticks.map((tick, index) => (
                <div className="time-tick" key={tick.minute} style={{ left: `${(tick.minute - range.start) * minuteWidth}px` }}>
                  {index % labelInterval === 0 && <span>{formatMinute(tick.minute)}</span>}
                </div>
              ))}
              {isMinuteInRange(currentTimelineMinute, range) && (
                <div className="live-now-marker axis-marker" style={{ left: `${(currentTimelineMinute - range.start) * minuteWidth}px` }} />
              )}
            </div>

            {loops.map((loop) => (
              <TimelineRow
                key={loop}
                loop={loop}
                movements={movements.filter((movement) => loopKey(movement) === loop)}
                rangeStart={range.start}
                width={contentWidth}
                minuteWidth={minuteWidth}
                hourWidth={hourWidth}
                currentTimelineMinute={currentTimelineMinute}
                liveStatusByMovementId={liveStatusByMovementId}
                onSelectMovement={setSelectedMovement}
              />
            ))}
          </div>
        </div>
      </div>
      {selectedMovement && (
        <MovementDialog
          movement={selectedMovement}
          liveStatus={liveStatusByMovementId.get(selectedMovement.id)}
          fallbackVehicleId={selectedLoopVehicleId}
          onClose={() => setSelectedMovement(undefined)}
        />
      )}
    </section>
  );
}

function TimelineRow({
  loop,
  movements,
  rangeStart,
  width,
  minuteWidth,
  hourWidth,
  currentTimelineMinute,
  liveStatusByMovementId,
  onSelectMovement,
}: {
  loop: string;
  movements: Movement[];
  rangeStart: number;
  width: number;
  minuteWidth: number;
  hourWidth: number;
  currentTimelineMinute?: number;
  liveStatusByMovementId: Map<string, LiveMovementStatus>;
  onSelectMovement: (movement: Movement) => void;
}) {
  const timedMovements = movements
    .map((movement) => ({ movement, timing: getMovementTiming(movement) }))
    .filter((item): item is { movement: Movement; timing: TimelineTiming } => item.timing !== undefined)
    .sort((a, b) => a.timing.start - b.timing.start);
  const serviceSpans = buildServiceSpans(timedMovements);
  const splitTripConnections = buildSplitTripConnections(timedMovements);
  const continuesFromPrevious = new Set(splitTripConnections.map((connection) => connection.toMovementId));
  const continuesToNext = new Set(splitTripConnections.map((connection) => connection.fromMovementId));
  const splitTripSizingWidths = buildSplitTripSizingWidths(timedMovements, splitTripConnections, minuteWidth);
  const currentLive = liveInfoForLoop(timedMovements, liveStatusByMovementId, currentTimelineMinute);
  const delayMarkers = timedMovements.flatMap(({ movement, timing }) => {
    const status = liveStatusByMovementId.get(movement.id);
    if (!status?.matched || status.delaySeconds === undefined || Math.abs(status.delaySeconds) <= 60 || currentTimelineMinute === undefined) {
      return [];
    }

    const scheduledPosition = plannedMarkerMinute(currentTimelineMinute, status.delaySeconds, timing.start, timing.end);
    if (scheduledPosition === undefined) {
      return [];
    }

    return [{ movementId: movement.id, minute: scheduledPosition, delaySeconds: status.delaySeconds }];
  });

  return (
    <>
      <div className="timeline-loop">
        <span>{displayLoopNumber(loop)}</span>
        {currentLive.vehicleId && (
          <VehicleLink vehicleId={currentLive.vehicleId} className="timeline-loop-vehicle">
            Bus {currentLive.vehicleId}
          </VehicleLink>
        )}
        {currentLive.delaySeconds !== undefined && Math.abs(currentLive.delaySeconds) > 60 && (
          <em className={currentLive.delaySeconds > 0 ? "timeline-loop-delay late" : "timeline-loop-delay early"}>
            {currentLive.delaySeconds > 0 ? "+" : ""}{Math.round(currentLive.delaySeconds / 60)}
          </em>
        )}
      </div>
      <div
        className="timeline-track"
        style={{ width: `${width}px`, backgroundSize: `${hourWidth}px 100%, ${hourWidth / 4}px 100%` }}
      >
        {isMinuteWithinTrack(currentTimelineMinute, rangeStart, width, minuteWidth) && (
          <div className="live-now-marker track-marker" style={{ left: `${(currentTimelineMinute - rangeStart) * minuteWidth}px` }} />
        )}
        {serviceSpans.map((span) => (
          <div
            className="service-span"
            key={`${loop}-${span.dienstnummer}-${span.start}-${span.end}`}
            style={{
              left: `${(span.start - rangeStart) * minuteWidth}px`,
              width: `${Math.max(1, (span.end - span.start) * minuteWidth)}px`,
            }}
          >
            {span.dienstnummer}
          </div>
        ))}

        {timedMovements.map(({ movement, timing }) => (
          <MovementBlock
            key={movement.id}
            movement={movement}
            left={(timing.start - rangeStart) * minuteWidth}
            width={(timing.end - timing.start) * minuteWidth}
            continuesFromPrevious={continuesFromPrevious.has(movement.id)}
            continuesToNext={continuesToNext.has(movement.id)}
            splitTripSizingWidth={splitTripSizingWidths.get(movement.id)}
            onSelect={onSelectMovement}
          />
        ))}
        {delayMarkers.map((marker) => (
          <div
            className="live-delay-marker"
            key={marker.movementId}
            style={{ left: `${(marker.minute - rangeStart) * minuteWidth}px` }}
            title={`${marker.delaySeconds > 0 ? "+" : ""}${Math.round(marker.delaySeconds / 60)} min`}
          />
        ))}
      </div>
    </>
  );
}

function liveInfoForLoop(
  movements: { movement: Movement; timing: TimelineTiming }[],
  liveStatusByMovementId: Map<string, LiveMovementStatus>,
  currentMinute: number | undefined,
): { vehicleId?: string; delaySeconds?: number } {
  if (currentMinute === undefined) {
    return {};
  }

  const updates = movements
    .map(({ movement, timing }) => ({ timing, status: liveStatusByMovementId.get(movement.id) }))
    .filter((item): item is { timing: TimelineTiming; status: LiveMovementStatus } => Boolean(item.status));
  const active = updates.find(({ timing, status }) => {
    const plannedPosition = currentMinute - (status.delaySeconds ?? 0) / 60;
    return timing.start <= plannedPosition && timing.end >= plannedPosition;
  }) ?? updates.find(({ timing }) => timing.start <= currentMinute && timing.end >= currentMinute);
  const latestVehicle = updates
    .filter(({ timing, status }) => timing.start <= currentMinute && Boolean(status.vehicleId))
    .sort((first, second) => second.timing.start - first.timing.start)
    .at(0)?.status.vehicleId;

  return {
    vehicleId: active?.status.vehicleId ?? latestVehicle,
    delaySeconds: active?.status.delaySeconds,
  };
}

function MovementBlock({
  movement,
  left,
  width,
  continuesFromPrevious,
  continuesToNext,
  splitTripSizingWidth,
  onSelect,
}: {
  movement: Movement;
  left: number;
  width: number;
  continuesFromPrevious: boolean;
  continuesToNext: boolean;
  splitTripSizingWidth?: number;
  onSelect: (movement: Movement) => void;
}) {
  const hoverTimer = useRef<number | undefined>(undefined);
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState<number | undefined>();
  const displayWidth = Math.max(0, width);

  useEffect(
    () => () => {
      if (hoverTimer.current !== undefined) {
        window.clearTimeout(hoverTimer.current);
      }
    },
    [],
  );

  function handleMouseEnter() {
    hoverTimer.current = window.setTimeout(() => setIsExpanded(true), 1000);
  }

  function handleMouseLeave() {
    if (hoverTimer.current !== undefined) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
    setIsExpanded(false);
  }

  useLayoutEffect(() => {
    if (!isExpanded || !detailsRef.current) {
      setExpandedWidth(undefined);
      return;
    }

    const textWidths = [...detailsRef.current.querySelectorAll("span, small")].map((element) => element.scrollWidth);
    const widestText = Math.max(0, ...textWidths);
    setExpandedWidth(Math.max(displayWidth, 54 + 5 + widestText + 16));
  }, [displayWidth, isExpanded]);

  return (
    <article
      className={[
        "movement-block",
        `type-${movement.type}`,
        continuesFromPrevious ? "continues-previous" : "",
        continuesToNext ? "continues-next" : "",
        isExpanded ? "is-expanded" : "",
      ].filter(Boolean).join(" ")}
      style={{
        left: `${left}px`,
        width: `${expandedWidth ?? displayWidth}px`,
        borderColor: colorFor(movement.lijnnummer ?? movement.type),
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={() => onSelect(movement)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(movement);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${movement.dienstnummer} ${movement.vertrek}-${movement.aankomst} ${movement.van} naar ${movement.naar}`}
    >
      <time className="movement-times">
        {movement.vertrek}
        <br />
        {movement.aankomst}
      </time>
      <strong
        className="movement-line-number"
        style={splitTripSizingWidth === undefined ? undefined : {
          fontSize: `clamp(0.6rem, ${splitTripSizingWidth * 0.17}px, 1.2rem)`,
        }}
      >
        {formatLineLabel(movement.lijnnummer, movement.type)}
      </strong>
      <div className="movement-details" ref={detailsRef}>
        <span>{movement.ritnummer ? `rit ${movement.ritnummer}` : labelForType(movement.type)}</span>
        <small>{movement.van} -&gt; {movement.naar}</small>
      </div>
    </article>
  );
}

function MovementDialog({
  movement,
  liveStatus,
  fallbackVehicleId,
  onClose,
}: {
  movement: Movement;
  liveStatus?: LiveMovementStatus;
  fallbackVehicleId?: string;
  onClose: () => void;
}) {
  const delay = liveStatus?.delaySeconds;
  const vehicleId = liveStatus?.vehicleId ?? fallbackVehicleId;
  const hasDirectVehicleId = Boolean(liveStatus?.vehicleId);
  const hasDelay = delay !== undefined && Math.abs(delay) > 60;

  return (
    <div
      className="movement-dialog-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <article className="movement-dialog" role="dialog" aria-modal="true" aria-label="Ritdetails">
        <button className="movement-dialog-close" type="button" onClick={onClose} title="Sluiten" aria-label="Sluiten">
          <X size={20} />
        </button>
        <time className="movement-dialog-times">
          <strong>{movement.vertrek}</strong>
          <span>{movement.aankomst}</span>
        </time>
        <strong className="movement-dialog-line">{formatLineLabel(movement.lijnnummer, movement.type)}</strong>
        <div className="movement-dialog-main">
          <strong>{movement.van} -&gt; {movement.naar}</strong>
          <span>{movement.ritnummer ? `rit ${movement.ritnummer}` : labelForType(movement.type)}</span>
          <div className="movement-dialog-meta">
            <span>Dienst {movement.dienstnummer}</span>
            {movement.omloopnummer && <span>Omloop {displayLoopNumber(movement.omloopnummer)}</span>}
            {vehicleId && (
              <VehicleLink
                vehicleId={vehicleId}
                className={`movement-dialog-vehicle ${hasDirectVehicleId ? "is-live" : "is-derived"}`}
                title={hasDirectVehicleId
                  ? `Bus ${vehicleId} is live aan deze rit gekoppeld. Open op Busposities.nl`
                  : `Bus ${vehicleId} is afgeleid van de actuele omloop. Open op Busposities.nl`}
              />
            )}
            {hasDelay && <span className="delay">{delay! > 0 ? "+" : ""}{Math.round(delay! / 60)} min</span>}
          </div>
        </div>
      </article>
    </div>
  );
}

function MovementTable({
  movements,
  isOpen,
  onToggle,
}: {
  movements: Movement[];
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="details-section">
      <div className="section-heading">
        <div>
          <h2>Detailtabel</h2>
          <span>Alle gevonden rit- en dienstregels</span>
        </div>
        <button className="secondary-button" type="button" onClick={onToggle}>
          {isOpen ? "Inklappen" : `Uitklappen (${movements.length})`}
        </button>
      </div>

      {isOpen && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Dienst</th>
                <th>Omloop</th>
                <th>Lijn</th>
                <th>Rit</th>
                <th>Vertrek</th>
                <th>Van</th>
                <th>Naar</th>
                <th>Aankomst</th>
                <th>Type</th>
                <th>Materieelsoort</th>
                <th>Bestand</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{movement.dienstnummer}</td>
                  <td>{displayLoopNumber(compactLoopNumber(movement.omloopnummer)) ?? "-"}</td>
                  <td>{movement.lijnnummer ?? "-"}</td>
                  <td>{movement.ritnummer ?? "-"}</td>
                  <td>{movement.vertrek}</td>
                  <td>{movement.van}</td>
                  <td>{movement.naar}</td>
                  <td>{movement.aankomst}</td>
                  <td>{labelForType(movement.type)}</td>
                  <td>{movement.materieelsoort ?? "-"}</td>
                  <td>{movement.sourceFile}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function orderedDiensten(diensten: Dienst[], movements: Movement[]): Dienst[] {
  const keysInUse = new Set(movements.map((movement) => movement.dienstnummer));
  return [...diensten]
    .filter((dienst, index, all) => keysInUse.has(dienst.serviceNumber) && all.findIndex((item) => item.id === dienst.id) === index)
    .sort((a, b) => serviceSortKey(a.serviceNumber) - serviceSortKey(b.serviceNumber));
}

function orderedLoops(movements: Movement[]): string[] {
  return [...new Set(movements.map(loopKey))].sort((a, b) => {
    if (a === "zonder omloop") return 1;
    if (b === "zonder omloop") return -1;
    return a.localeCompare(b, "nl", { numeric: true });
  });
}

function loopKey(movement: Movement): string {
  return compactLoopNumber(movement.omloopnummer) ?? "zonder omloop";
}

function compactLoopNumber(value: string | undefined): string | undefined {
  const compacted = value?.replace(/\s+/g, "");
  return compacted || undefined;
}

function displayLoopNumber(value: string | undefined): string | undefined {
  const compacted = compactLoopNumber(value);
  return compacted ?? value;
}

function serviceSortKey(serviceNumber: string): number {
  const digits = serviceNumber.match(/\d+/)?.[0];
  return digits ? Number(digits) : Number.MAX_SAFE_INTEGER;
}

function todayInputValue(now = new Date()): string {
  const today = new Date(now);
  // Diensten die na middernacht doorlopen behoren operationeel nog bij de vorige dag.
  if (today.getHours() < 4) {
    today.setDate(today.getDate() - 1);
  }
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function daySegmentForDate(value: string): DaySegment {
  const date = new Date(`${value}T12:00:00`);
  const day = date.getDay();

  if (day === 6) {
    return "saturday";
  }

  if (day === 0) {
    return "sunday";
  }

  return "weekday";
}

function segmentLabel(segment: DaySegment): string {
  return DAY_SEGMENTS.find((item) => item.id === segment)?.label ?? segment;
}

function resolveSelectedDivisionIds(
  requestedDivisionIds: string[],
  organization: OrganizationConfig,
): string[] {
  const available = new Set(organization.divisions.map((division) => division.id));
  const selected = [...new Set(requestedDivisionIds)].filter((divisionId) => available.has(divisionId));
  return selected.sort();
}

function sameStringSet(first: string[], second: string[]): boolean {
  const orderedFirst = [...first].sort();
  const orderedSecond = [...second].sort();
  return orderedFirst.length === orderedSecond.length
    && orderedFirst.every((value, index) => value === orderedSecond[index]);
}

type TimelineTiming = {
  start: number;
  end: number;
};

type ServiceSpan = {
  dienstnummer: string;
  start: number;
  end: number;
};

type SplitTripConnection = {
  fromMovementId: string;
  toMovementId: string;
};

function buildSplitTripConnections(
  timedMovements: { movement: Movement; timing: TimelineTiming }[],
): SplitTripConnection[] {
  return timedMovements.slice(0, -1).flatMap((current, index) => {
    const next = timedMovements[index + 1];
    const gapMinutes = next.timing.start - current.timing.end;
    const currentLine = normaliseTimelineLine(current.movement.lijnnummer);
    const nextLine = normaliseTimelineLine(next.movement.lijnnummer);
    const currentTrip = normaliseTimelineIdentifier(current.movement.ritnummer);
    const nextTrip = normaliseTimelineIdentifier(next.movement.ritnummer);

    if (
      current.movement.type !== "rit"
      || next.movement.type !== "rit"
      || gapMinutes < 0
      || gapMinutes > 10
      || !currentLine
      || currentLine !== nextLine
      || !currentTrip
      || currentTrip !== nextTrip
      || !sameGuidanceStop(current.movement.naar, next.movement.van)
    ) {
      return [];
    }

    return [{
      fromMovementId: current.movement.id,
      toMovementId: next.movement.id,
    }];
  });
}

function buildSplitTripSizingWidths(
  timedMovements: { movement: Movement; timing: TimelineTiming }[],
  connections: SplitTripConnection[],
  minuteWidth: number,
): Map<string, number> {
  const timingById = new Map(timedMovements.map(({ movement, timing }) => [movement.id, timing]));
  const previousById = new Map(connections.map((connection) => [connection.toMovementId, connection.fromMovementId]));
  const nextById = new Map(connections.map((connection) => [connection.fromMovementId, connection.toMovementId]));
  const widths = new Map<string, number>();

  for (const connection of connections) {
    let firstId = connection.fromMovementId;
    while (previousById.has(firstId)) firstId = previousById.get(firstId)!;
    if (widths.has(firstId)) continue;

    const movementIds = [firstId];
    let lastId = firstId;
    while (nextById.has(lastId)) {
      lastId = nextById.get(lastId)!;
      movementIds.push(lastId);
    }

    const firstTiming = timingById.get(firstId);
    const lastTiming = timingById.get(lastId);
    if (!firstTiming || !lastTiming) continue;
    const combinedWidth = Math.max(0, (lastTiming.end - firstTiming.start) * minuteWidth);
    movementIds.forEach((movementId) => widths.set(movementId, combinedWidth));
  }

  return widths;
}

function normaliseTimelineIdentifier(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normaliseTimelineLine(value: string | undefined): string {
  const line = normaliseTimelineIdentifier(value);
  return /^l\d+$/.test(line) ? line.slice(1) : line;
}

function alignCurrentMinute(minute: number, range: TimelineTiming): number {
  if (range.end > 24 * 60 && minute < range.start % (24 * 60)) {
    return minute + 24 * 60;
  }

  return minute;
}

function isMinuteInRange(minute: number | undefined, range: TimelineTiming): minute is number {
  return minute !== undefined && minute >= range.start && minute <= range.end;
}

function isMinuteWithinTrack(minute: number | undefined, start: number, width: number, minuteWidth: number): minute is number {
  return minute !== undefined && minute >= start && minute <= start + width / minuteWidth;
}

function getTimelineRange(movements: Movement[], frameHours: number): TimelineTiming {
  const timings = movements.map(getMovementTiming).filter((timing): timing is TimelineTiming => timing !== undefined);

  if (timings.length === 0) {
    return { start: 0, end: frameHours * 60 };
  }

  const first = Math.min(...timings.map((timing) => timing.start));
  const last = Math.max(...timings.map((timing) => timing.end));
  const start = Math.floor(first / 60) * 60;
  const end = Math.ceil(last / 60) * 60;

  return {
    start,
    end: Math.max(end, start + frameHours * 60),
  };
}

function clampFrameHours(value: number): number {
  if (!Number.isFinite(value)) {
    return 6;
  }

  return Math.min(24, Math.max(1, Math.round(value)));
}

function getMovementTiming(movement: Movement): TimelineTiming | undefined {
  const start = parseTime(movement.vertrek);
  const rawEnd = parseTime(movement.aankomst);

  if (start === undefined || rawEnd === undefined) {
    return undefined;
  }

  return {
    start,
    end: rawEnd < start ? rawEnd + 24 * 60 : rawEnd,
  };
}

function buildGuidanceEntries(movements: Movement[]): GuidanceEntry[] {
  return movements
    .map((movement) => {
      let start = parseTime(movement.vertrek);
      let end = parseTime(movement.aankomst);
      if (start === undefined || end === undefined) {
        return undefined;
      }
      start = toOperationalMinute(start);
      end = toOperationalMinute(end);
      if (end < start) {
        end += 24 * 60;
      }

      return { movement, timing: { start, end } };
    })
    .filter((entry): entry is GuidanceEntry => entry !== undefined)
    .sort((first, second) => first.timing.start - second.timing.start || first.timing.end - second.timing.end);
}

function buildGuidanceTakeovers(entries: GuidanceEntry[], allMovements: Movement[]): Map<string, GuidanceTakeover> {
  const takeovers = new Map<string, GuidanceTakeover>();
  let previousVehicleEntry: GuidanceEntry | undefined;

  for (const entry of entries) {
    if (!isVehicleTimelineMovement(entry.movement)) {
      continue;
    }

    const loop = loopKey(entry.movement);
    const previousLoop = previousVehicleEntry ? loopKey(previousVehicleEntry.movement) : undefined;
    const returnedAfterOtherDriver = previousVehicleEntry !== undefined
      && loop === previousLoop
      && hasInterveningDriverOnLoop(previousVehicleEntry, entry, allMovements);

    if (loop !== previousLoop || returnedAfterOtherDriver) {
      takeovers.set(entry.movement.id, { entry });
    }

    previousVehicleEntry = entry;
  }

  return takeovers;
}

function hasInterveningDriverOnLoop(
  previousEntry: GuidanceEntry,
  currentEntry: GuidanceEntry,
  allMovements: Movement[],
): boolean {
  const loop = compactLoopNumber(currentEntry.movement.omloopnummer);
  const previousLoop = compactLoopNumber(previousEntry.movement.omloopnummer);
  if (!loop || !previousLoop) {
    return false;
  }

  const intervalFor = (entry: GuidanceEntry): DutyVehicleInterval => ({
    loop: compactLoopNumber(entry.movement.omloopnummer) ?? "",
    serviceNumber: entry.movement.dienstnummer,
    start: entry.timing.start,
    end: entry.timing.end,
  });
  const candidates = allMovements.flatMap((movement): DutyVehicleInterval[] => {
    if (!isVehicleTimelineMovement(movement)) {
      return [];
    }

    const candidateLoop = compactLoopNumber(movement.omloopnummer);
    const timing = alignTimingToTarget(getMovementTiming(movement), currentEntry.timing.start);
    if (!candidateLoop || !timing) {
      return [];
    }

    return [{
      loop: candidateLoop,
      serviceNumber: movement.dienstnummer,
      start: timing.start,
      end: timing.end,
    }];
  });

  return hasInterveningDriver(intervalFor(previousEntry), intervalFor(currentEntry), candidates);
}

function findTakeoverArrival(
  takeover: GuidanceTakeover,
  movements: Movement[],
  liveStatusByMovementId: Map<string, LiveMovementStatus>,
): TakeoverArrivalInfo | undefined {
  const target = takeover.entry;
  const targetLoop = compactLoopNumber(target.movement.omloopnummer);
  if (!targetLoop) {
    return undefined;
  }

  const candidates = movements
    .filter((movement) => compactLoopNumber(movement.omloopnummer) === targetLoop)
    .filter((movement) => isVehicleTimelineMovement(movement))
    .map((movement) => ({ movement, timing: alignTimingToTarget(getMovementTiming(movement), target.timing.start) }))
    .filter((candidate): candidate is { movement: Movement; timing: TimelineTiming } => candidate.timing !== undefined)
    .filter((candidate) => candidate.timing.end <= target.timing.start && target.timing.start - candidate.timing.end <= 180)
    .filter((candidate) => sameGuidanceStop(candidate.movement.naar, target.movement.van))
    .sort((first, second) => first.timing.end - second.timing.end);
  const latestArrival = candidates.at(-1);
  // Bij grote stations wordt dezelfde halte soms kort achter elkaar als
  // afzonderlijke aankomst- en vertrekpassage genoteerd. Voor de overname
  // is dan de eerste aankomst van die laatste haltepassage leidend.
  const incoming = latestArrival
    ? candidates.find((candidate) => latestArrival.timing.end - candidate.timing.end <= 8)
    : undefined;
  if (!incoming) {
    return undefined;
  }

  const status = liveStatusByMovementId.get(incoming.movement.id);
  return {
    plannedArrival: incoming.movement.aankomst,
    expectedAt: status?.arrivalExpectedAt,
    delaySeconds: status?.arrivalDelaySeconds ?? status?.delaySeconds,
    stopSpecific: status?.arrivalStopSpecific,
    vehicleId: status?.vehicleId,
  };
}

function guidanceTakeoverDisplay(
  takeover: GuidanceTakeover,
  arrival: TakeoverArrivalInfo | undefined,
  live: GuidanceLiveInfo,
  currentMinute: number,
): GuidanceTakeoverDisplay {
  const plannedArrival = arrival?.plannedArrival
    ?? live.handoverPlannedTime
    ?? takeover.entry.movement.vertrek;
  const expectedAt = arrival?.expectedAt ?? live.handoverExpectedAt;
  const delaySeconds = arrival?.delaySeconds ?? live.handoverDelaySeconds ?? 0;
  const hasLiveData = expectedAt !== undefined
    || live.handoverDelaySeconds !== undefined
    || arrival?.delaySeconds !== undefined
    || live.handoverArrived === true
    || live.handoverDeparted === true;
  const plannedArrivalMinute = alignMinuteNearTarget(
    parseTime(plannedArrival) ?? takeover.entry.timing.start,
    takeover.entry.timing.start,
  );
  const predictedArrivalMinute = expectedAt === undefined
    ? undefined
    : alignMinuteNearTarget(
      parseTime(formatEpochClock(expectedAt)) ?? plannedArrivalMinute,
      plannedArrivalMinute,
    );
  const expectedArrivalMinute = resolveTakeoverArrivalMinute({
    plannedArrivalMinute,
    delaySeconds,
    predictedArrivalMinute,
  });
  const displayedPlannedArrivalMinute = hasLiveData
    ? resolveTakeoverPlannedMinute({
      suppliedPlannedMinute: plannedArrivalMinute,
      expectedArrivalMinute,
      delaySeconds,
    })
    : plannedArrivalMinute;
  const expectedArrival = formatTimelineMinute(expectedArrivalMinute);
  const expectedDepartureMinute = live.handoverDepartureExpectedAt === undefined
    ? undefined
    : alignMinuteNearTarget(
      parseTime(formatEpochClock(live.handoverDepartureExpectedAt)) ?? takeover.entry.timing.start,
      takeover.entry.timing.start,
    );
  const departed = live.handoverDeparted === true
    || expectedDepartureMinute !== undefined && currentMinute > expectedDepartureMinute
    || !hasLiveData && currentMinute > takeover.entry.timing.start;

  return {
    ...calculateTakeoverStatus({
      currentMinute,
      plannedDepartureMinute: takeover.entry.timing.start,
      expectedArrivalMinute,
      delaySeconds,
      hasLiveData,
      arrived: live.handoverArrived === true,
      departed,
    }),
    hasLiveData,
    delaySeconds,
    expectedArrival,
    plannedArrival: formatTimelineMinute(displayedPlannedArrivalMinute),
    timingLabel: arrival?.stopSpecific || live.handoverStopSpecific ? "Aankomst bij halte" : "Geschatte aankomst",
    vehicleId: live.vehicleId ?? arrival?.vehicleId,
  };
}

function alignTimingToTarget(timing: TimelineTiming | undefined, targetStart: number): TimelineTiming | undefined {
  if (!timing) {
    return undefined;
  }

  let start = timing.start;
  let end = timing.end;
  while (end > targetStart + 12 * 60) {
    start -= 24 * 60;
    end -= 24 * 60;
  }
  while (end <= targetStart - 12 * 60) {
    start += 24 * 60;
    end += 24 * 60;
  }
  return { start, end };
}

function sameGuidanceStop(first: string, second: string): boolean {
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const firstStop = normalise(first);
  const secondStop = normalise(second);
  return Boolean(
    firstStop
      && secondStop
      && (firstStop === secondStop || firstStop.includes(secondStop) || secondStop.includes(firstStop)),
  );
}

function alignMinuteToEntries(currentTime: Date): number {
  const minute = currentTime.getHours() * 60 + currentTime.getMinutes() + currentTime.getSeconds() / 60;
  return toOperationalMinute(minute);
}

function buildLoopLiveSnapshots(
  movements: Movement[],
  liveStatusByMovementId: Map<string, LiveMovementStatus>,
  currentTime: Date,
): Map<string, GuidanceLiveInfo> {
  const currentMinute = currentTime.getHours() * 60 + currentTime.getMinutes() + currentTime.getSeconds() / 60;
  const candidates = new Map<string, { status: LiveMovementStatus; score: number }[]>();

  for (const movement of movements) {
    if (!movement.omloopnummer) {
      continue;
    }
    const status = liveStatusByMovementId.get(movement.id);
    const timing = getMovementTiming(movement);
    if ((!status?.vehicleId && status?.delaySeconds === undefined) || !timing) {
      continue;
    }
    const alignedMinute = timing.end > 24 * 60 && currentMinute < timing.start % (24 * 60) ? currentMinute + 24 * 60 : currentMinute;
    const score = timing.start <= alignedMinute && timing.end >= alignedMinute
      ? 0
      : timing.end < alignedMinute
        ? 100 + alignedMinute - timing.end
        : 1000 + timing.start - alignedMinute;
    const loop = loopKey(movement);
    const values = candidates.get(loop) ?? [];
    values.push({ status, score });
    candidates.set(loop, values);
  }

  const snapshots = new Map<string, GuidanceLiveInfo>();
  for (const [loop, values] of candidates) {
    values.sort((first, second) => first.score - second.score || (second.status.updatedAt ?? 0) - (first.status.updatedAt ?? 0));
    snapshots.set(loop, {
      vehicleId: values.find((value) => value.status.vehicleId)?.status.vehicleId,
      delaySeconds: values.find((value) => value.status.delaySeconds !== undefined)?.status.delaySeconds,
    });
  }
  return snapshots;
}

function guidanceLiveInfo(
  entry: GuidanceEntry,
  liveStatusByMovementId: Map<string, LiveMovementStatus>,
  loopSnapshots: Map<string, GuidanceLiveInfo>,
  currentMinute: number,
  useLoopFallback: boolean,
): GuidanceLiveInfo {
  const status = liveStatusByMovementId.get(entry.movement.id);
  const loop = entry.movement.omloopnummer ? loopKey(entry.movement) : undefined;
  const snapshot = useLoopFallback && loop ? loopSnapshots.get(loop) : undefined;
  const isNearNow = entry.timing.end >= currentMinute - 120 && entry.timing.start <= currentMinute + 120;

  return {
    vehicleId: status?.vehicleId ?? (isNearNow ? snapshot?.vehicleId : undefined),
    delaySeconds: status?.delaySeconds ?? (isNearNow ? snapshot?.delaySeconds : undefined),
    handoverDelaySeconds: status?.handoverDelaySeconds,
    handoverExpectedAt: status?.handoverExpectedAt,
    handoverDepartureExpectedAt: status?.handoverDepartureExpectedAt,
    handoverArrived: status?.handoverArrived,
    handoverDeparted: status?.handoverDeparted,
    handoverStopSpecific: status?.handoverStopSpecific,
    handoverPlannedTime: status?.handoverPlannedTime,
    arrivalDelaySeconds: status?.arrivalDelaySeconds,
    arrivalExpectedAt: status?.arrivalExpectedAt,
    arrivalStopSpecific: status?.arrivalStopSpecific,
  };
}

function guidanceActionTitle(movement: Movement): string {
  if (movement.type === "rit" || movement.type === "materiaal") {
    return formatServiceRoute(movement);
  }
  return formatServiceMovementLabel(movement);
}

function guidanceActionDetail(movement: Movement): string {
  if (movement.type === "rit" || movement.type === "materiaal") {
    return formatServiceMovementLabel(movement);
  }
  const route = formatServiceRoute(movement);
  return route === "- -> -" ? "" : route;
}

function guidanceIdentityLabel(movement: Movement): string {
  if (movement.lijnnummer) {
    return formatLineLabel(movement.lijnnummer, movement.type);
  }

  if (movement.type === "materiaal") {
    return "MAT";
  }

  if (movement.type === "pauze") {
    return "PAUZE";
  }

  if (movement.type === "dienst") {
    return "DIENST";
  }

  return "ACTIE";
}

function guidanceActionSubtitle(movement: Movement): string {
  if (movement.type === "rit" && movement.ritnummer) {
    return `rit ${movement.ritnummer}`;
  }

  if (movement.type === "materiaal") {
    return "Materieelrit";
  }

  return guidanceActionDetail(movement);
}

function formatHandoverDifference(seconds: number): string {
  if (seconds > 60) {
    return `+${Math.round(seconds / 60)} min later`;
  }
  if (seconds < -60) {
    return `${Math.round(seconds / 60)} min eerder`;
  }
  return "op tijd";
}

function formatClock(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function formatEpochClock(epochSeconds: number): string {
  return formatClock(new Date(epochSeconds * 1000));
}

function alignMinuteNearTarget(minute: number, targetMinute: number): number {
  let aligned = minute;
  while (aligned > targetMinute + 12 * 60) {
    aligned -= 24 * 60;
  }
  while (aligned < targetMinute - 12 * 60) {
    aligned += 24 * 60;
  }
  return aligned;
}

function formatDepartureWindow(minutes: number, departure: string): string {
  if (minutes > 1) {
    return `${minutes} minuten overstaptijd tot vertrek (${departure})`;
  }
  if (minutes === 1) {
    return `1 minuut overstaptijd tot vertrek (${departure})`;
  }
  if (minutes === 0) {
    return `aankomst op vertrekmoment (${departure})`;
  }
  return `${Math.abs(minutes)} min na vertrektijd (${departure})`;
}

function withTimeOverride(currentTime: Date, override: string): Date {
  const match = override.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return currentTime;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return currentTime;
  }

  const overridden = new Date(currentTime);
  overridden.setHours(hours, minutes, 0, 0);
  return overridden;
}

function formatTimelineMinute(minute: number): string {
  const normalized = ((Math.round(minute) % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function liveMovementRequests(movements: Movement[], now: Date): LiveMovementRequest[] {
  const currentMinute = now.getHours() * 60 + now.getMinutes();

  return movements
    .filter((movement) => movement.type === "rit")
    .filter((movement) => {
      const timing = getMovementTiming(movement);
      if (!timing) {
        return false;
      }

      const alignedCurrentMinute = timing.end > 24 * 60 && currentMinute < timing.start % (24 * 60) ? currentMinute + 24 * 60 : currentMinute;
      return timing.end >= alignedCurrentMinute - 120 && timing.start <= alignedCurrentMinute + 120;
    })
    .map((movement) => ({
      movementId: movement.id,
      loopNumber: compactLoopNumber(movement.omloopnummer),
      serviceNumber: movement.dienstnummer,
      lineNumber: movement.lijnnummer,
      tripNumber: movement.ritnummer,
      departure: movement.vertrek,
      arrival: movement.aankomst,
      from: movement.van,
      to: movement.naar,
      type: movement.type,
    }));
}

function buildServiceSpans(items: { movement: Movement; timing: TimelineTiming }[]): ServiceSpan[] {
  const vehicleItems = items.filter((item) => item.movement.type === "rit" || item.movement.type === "materiaal");
  const source = vehicleItems.length > 0 ? vehicleItems : items;
  const spans: ServiceSpan[] = [];

  for (const item of source) {
    const current = spans.at(-1);

    if (current?.dienstnummer === item.movement.dienstnummer) {
      current.end = Math.max(current.end, item.timing.end);
      continue;
    }

    spans.push({
      dienstnummer: item.movement.dienstnummer,
      start: item.timing.start,
      end: item.timing.end,
    });
  }

  return spans;
}

function buildHourTicks(start: number, end: number): { minute: number }[] {
  const ticks: { minute: number }[] = [];

  for (let minute = start; minute <= end; minute += 60) {
    ticks.push({ minute });
  }

  return ticks;
}

function parseTime(value: string): number | undefined {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return undefined;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinute(value: number): string {
  const normalized = ((value % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatEuroCents(cents: number): string {
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

function labelForType(type: Movement["type"]): string {
  const labels: Record<Movement["type"], string> = {
    rit: "Rit",
    materiaal: "Materiaal",
    pauze: "Pauze",
    dienst: "Dienst",
    overig: "Overig",
  };
  return labels[type];
}

function formatServiceMovementLabel(movement: Movement): string {
  const label = `${movement.van} ${movement.naar} ${movement.raw}`.toLowerCase();

  if (/\breis\b/.test(label) || /\brij\s+mee\b/.test(label)) {
    return "Reis";
  }

  if (/\bprep[\s-]*in\b/.test(label)) {
    return "Prep-in";
  }

  if (/\brijklaar\s*maken\b/.test(label)) {
    return "Rijklaarmaken";
  }

  if (label.includes("explo")) {
    return "Explo";
  }

  if (label.includes("bus van lader")) {
    return "Bus van lader";
  }

  if (label.includes("bus aan lader")) {
    return "Bus aan lader";
  }

  if (movement.lijnnummer) {
    const line = formatLineLabel(movement.lijnnummer, movement.type);
    return movement.ritnummer ? `${line} rit ${movement.ritnummer}` : line;
  }

  return labelForType(movement.type);
}

function formatServiceRoute(movement: Movement): string {
  if (movement.van || movement.naar) {
    return `${movement.van || "-"} -> ${movement.naar || "-"}`;
  }

  return movement.raw || "-";
}

function isVehicleTimelineMovement(movement: Movement, buslessActions?: string[]): boolean {
  if (!movement.omloopnummer) {
    return false;
  }

  if (isDriverOnlyMovement(movement, buslessActions)) {
    return false;
  }

  return movement.type === "rit" || movement.type === "materiaal";
}

function isDriverOnlyMovement(movement: Movement, buslessActions?: string[]): boolean {
  const label = `${movement.van} ${movement.naar} ${movement.raw}`.toLowerCase();

  if (isBuslessDriverRow(label, buslessActions)) {
    return true;
  }

  return [
    "explo",
    "opstap",
    "afstap",
    "netto pauze",
    "pauze",
    "bus van lader",
    "bus aan lader",
    "onbetaalde rust",
    "lopen",
  ].some((needle) => label.includes(needle));
}

function formatLineLabel(lijnnummer: string | undefined, type: Movement["type"]): string {
  if (!lijnnummer) {
    return labelForType(type);
  }

  return /^\d+$/.test(lijnnummer) ? `L${lijnnummer}` : lijnnummer;
}

function normaliseStoredMovement(movement: Movement): Movement {
  const lijnnummer = withoutLegacyOvChipNumber(
    movement.lijnnummer,
    movement.ritnummer,
    movement.raw,
  );
  return lijnnummer === movement.lijnnummer ? movement : { ...movement, lijnnummer };
}

function colorFor(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = char.charCodeAt(0) + ((hash << 5) - hash);
  }

  const palette = ["#0ea5a4", "#2563eb", "#c2410c", "#7c3aed", "#15803d", "#be123c", "#0369a1", "#a16207"];
  return palette[Math.abs(hash) % palette.length];
}

function movementsToCsv(movements: Movement[]): string {
  const headers = ["dienstnummer", "omloopnummer", "lijnnummer", "ritnummer", "vertrek", "van", "naar", "aankomst", "type", "datum", "bestand", "pagina"];
  const rows = movements.map((movement) => [
    movement.dienstnummer,
    compactLoopNumber(movement.omloopnummer) ?? "",
    movement.lijnnummer ?? "",
    movement.ritnummer ?? "",
    movement.vertrek,
    movement.van,
    movement.naar,
    movement.aankomst,
    labelForType(movement.type),
    movement.datum ?? "",
    movement.sourceFile,
    String(movement.pageNumber),
  ]);

  return [headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n");
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
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

function liveErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error) ?? "Live status kon niet worden opgehaald.";
  } catch {
    return "Live status kon niet worden opgehaald.";
  }
}


function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(value: number): string {
  return new Intl.DateTimeFormat("nl-NL", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

export default App;
