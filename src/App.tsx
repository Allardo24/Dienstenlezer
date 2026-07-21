import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BusFront,
  Clock3,
  Database,
  Download,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Loader2,
  Navigation,
  Search,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { getCachedQbuzzLiveStatuses, getQbuzzLiveStatuses, isDesktopLiveAvailable, listenToQbuzzSyncProgress, plannedMarkerMinute } from "./live";
import {
  createPdfContentHash,
  createStoredFileId,
  deleteStoredPdfFile,
  findExistingPdfHashes,
  getCachedStoredData,
  getStoredPdfCatalog,
  getStoredSchedule,
  saveStoredPdfFile,
  updateStoredPdfFileDaySegment,
  updateStoredPdfFileEnabled,
} from "./storage";
import type {
  DaySegment,
  Dienst,
  LiveMovementRequest,
  LiveMovementStatus,
  LiveStatusResponse,
  LiveSyncState,
  Movement,
  ParseResult,
  StoredPdfFile,
  StoredPdfFileSummary,
} from "./types";

const EMPTY_RESULTS: ParseResult[] = [];
const DESKTOP_LOOP_COLUMN_WIDTH = 170;
const MOBILE_LOOP_COLUMN_WIDTH = 84;
const GUIDANCE_LOCK_KEY = "dienstenlezer-locked-guidance-service";
type Page = "loops" | "services" | "guidance" | "files";

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

function cachedLiveResponse(date: string): LiveStatusResponse | undefined {
  const cached = getCachedQbuzzLiveStatuses(date);
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
  return cachedLiveResponse(todayInputValue()) ?? {
    statuses: [],
    sync: { state: "unavailable", message: "Live status wordt gestart." },
  };
}

function App() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const storageRequestIdRef = useRef(0);
  const previousDaySegmentRef = useRef<DaySegment | undefined>(undefined);
  const [storedFiles, setStoredFiles] = useState<StoredPdfFileSummary[]>([]);
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

  const selectedDaySegment = useMemo(() => daySegmentForDate(selectedDate), [selectedDate]);
  const allMovements = useMemo(() => results.flatMap((result) => result.movements), [results]);
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
  const timelineMovements = useMemo(() => filteredMovements.filter(isVehicleTimelineMovement), [filteredMovements]);
  const liveTimelineMovements = useMemo(() => allMovements.filter(isVehicleTimelineMovement), [allMovements]);
  const timelineLoops = useMemo(() => orderedLoops(timelineMovements), [timelineMovements]);
  const isToday = selectedDate === todayInputValue();
  const desktopLiveAvailable = isDesktopLiveAvailable();
  const liveRequested = page === "loops" || page === "guidance";
  const guidanceCurrentTime = useMemo(
    () => withTimeOverride(currentTime, guidanceTimeOverride),
    [currentTime, guidanceTimeOverride],
  );

  useEffect(() => {
    void reloadStoredFiles();
  }, []);

  useEffect(() => {
    function updateVisibility() {
      setIsPageVisible(document.visibilityState !== "hidden");
    }

    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    if (previousDaySegmentRef.current === undefined) {
      previousDaySegmentRef.current = selectedDaySegment;
      return;
    }

    if (previousDaySegmentRef.current !== selectedDaySegment) {
      previousDaySegmentRef.current = selectedDaySegment;
      void reloadStoredFiles();
    }
  }, [selectedDaySegment]);

  useEffect(() => {
    if (!desktopLiveAvailable) {
      return;
    }

    let unlisten: () => void = () => undefined;
    void listenToQbuzzSyncProgress((sync) => setLiveResponse((current) => ({ ...current, sync }))).then((dispose) => {
      unlisten = dispose;
    });

    return () => unlisten();
  }, [desktopLiveAvailable]);

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
      : cachedLiveResponse(selectedDate) ?? current);

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
        const response = await getQbuzzLiveStatuses(selectedDate, requestMovements);
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
  }, [desktopLiveAvailable, isPageVisible, isToday, liveRequested, liveTimelineMovements, selectedDate]);

  async function reloadStoredFiles() {
    const requestId = ++storageRequestIdRef.current;
    setIsLoadingFiles(true);
    setStorageError(undefined);
    try {
      const cached = await getCachedStoredData(selectedDaySegment);
      if (cached && requestId === storageRequestIdRef.current) {
        setStoredFiles(cached.catalog.files);
        setResults(cached.schedule.results);
        setIsLoadingFiles(false);
      }
      const catalog = await getStoredPdfCatalog();
      const schedule = await getStoredSchedule(selectedDaySegment, catalog.segmentRevisions[selectedDaySegment]);
      if (requestId !== storageRequestIdRef.current) {
        return;
      }
      setStoredFiles(catalog.files);
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

  async function removeStoredFile(file: StoredPdfFileSummary) {
    if (!window.confirm(`Bestand "${file.name}" verwijderen?`)) {
      return;
    }

    await deleteStoredPdfFile(file.id);
    await reloadStoredFiles();
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
            className={page === "files" ? "icon-button active" : "icon-button"}
            type="button"
            onClick={() => setPage((value) => (value === "files" ? "loops" : "files"))}
            title={page === "files" ? "Omloop overzicht tonen" : "Bestanden beheren"}
          >
            {page === "files" ? <Table2 size={19} /> : <Database size={19} />}
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={exportCsv}
            disabled={filteredMovements.length === 0}
            title="Exporteren als CSV"
          >
            <Download size={19} />
          </button>
          <button className="icon-button danger" type="button" onClick={resetView} disabled={!query && includeNoLoop} title="Filters leegmaken">
            <X size={19} />
          </button>
        </div>
      </section>

      {page !== "files" && (
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

      {page === "files" && (
        <section
          role="button"
          tabIndex={0}
          className="dropzone"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void handleFiles(event.dataTransfer.files);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
        >
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple onChange={(event) => void handleFiles(event.target.files)} />
          <div className="dropzone-icon">
            {isParsing ? <Loader2 className="spin" size={28} /> : <Upload size={28} />}
          </div>
          <div>
            <strong>{isParsing ? "Pdf's worden gelezen" : "Sleep 1 of meerdere diensten-pdf's hierheen"}</strong>
            <span>Alle verwerking gebeurt lokaal in deze app.</span>
          </div>
        </section>
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

      {page === "guidance" ? (
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
        />
      ) : page !== "files" ? (
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
              <span>Kies een datum met ingedeelde pdf's of sleep bestanden naar het juiste segment.</span>
            </section>
          )}
        </>
      ) : (
        <FilesPage files={storedFiles} isLoading={isLoadingFiles} onToggle={toggleStoredFile} onMove={moveStoredFile} onDelete={removeStoredFile} />
      )}
    </main>
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

function LoadingState() {
  return (
    <section className="empty-state">
      <Loader2 className="spin" size={32} />
      <strong>Bestandendatabase laden</strong>
      <span>Opgeslagen pdf's worden opgehaald.</span>
    </section>
  );
}

function FilesPage({
  files,
  isLoading,
  onToggle,
  onMove,
  onDelete,
}: {
  files: StoredPdfFileSummary[];
  isLoading: boolean;
  onToggle: (file: StoredPdfFileSummary) => Promise<void>;
  onMove: (file: StoredPdfFileSummary, daySegment: DaySegment) => Promise<void>;
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
          const vehicleMovements = serviceMovements.filter(isVehicleTimelineMovement);
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
}) {
  const serviceNumbers = [...new Set(services.map((service) => service.serviceNumber))].sort((a, b) => serviceSortKey(a) - serviceSortKey(b));
  const selectedService = services.find((service) => service.serviceNumber.toLowerCase() === selectedServiceNumber.trim().toLowerCase());
  const serviceMovements = selectedService
    ? movements.filter((movement) => movement.dienstnummer === selectedService.serviceNumber)
    : [];
  const entries = buildGuidanceEntries(serviceMovements, selectedService?.start);
  const statusByMovementId = new Map(liveStatuses.map((status) => [status.movementId, status]));
  const loopSnapshots = buildLoopLiveSnapshots(movements, statusByMovementId, currentTime);
  const currentMinute = alignMinuteToEntries(currentTime, entries);
  const currentIndex = entries.findIndex((entry) => entry.timing.start <= currentMinute && entry.timing.end > currentMinute);
  const nextIndex = currentIndex >= 0
    ? currentIndex + 1
    : entries.findIndex((entry) => entry.timing.start > currentMinute);
  const currentEntry = currentIndex >= 0 ? entries[currentIndex] : undefined;
  const nextEntry = nextIndex >= 0 && nextIndex < entries.length ? entries[nextIndex] : undefined;
  const takeoversByMovementId = buildGuidanceTakeovers(entries);
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

  return (
    <div className="guidance-page">
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
        {isToday ? (
          <LiveDataStatus sync={liveSync} currentTime={liveCurrentTime} className="guidance-live-status" label={isDemo ? "Demo-live" : "OVapi live"} />
        ) : (
          <div className="guidance-live-state">
            <span>Planning</span>
            <small>Live informatie is alleen beschikbaar voor vandaag.</small>
          </div>
        )}
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
              <time>{formatClock(currentTime)}</time>
            </header>

            <div className={`guidance-actions${!currentEntry && nextEntry ? " next-only" : ""}`}>
              {currentEntry || !nextEntry ? (
                <GuidanceAction label="Huidige actie" entry={currentEntry} live={currentLive} fallback={currentFallback} takeover={currentTakeover} takeoverArrival={currentTakeoverArrival} currentMinute={currentMinute} active />
              ) : null}
              <GuidanceAction label="Volgende actie" entry={nextEntry} live={nextLive} fallback="Geen volgende actie" takeover={nextTakeover} takeoverArrival={nextTakeoverArrival} currentMinute={currentMinute} active={!currentEntry && Boolean(nextEntry)} />
            </div>
          </section>

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
                    {takeover && <GuidanceTakeover takeover={takeover} live={live} arrival={findTakeoverArrival(takeover, movements, statusByMovementId)} past={takeover.entry.timing.start <= currentMinute} />}
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
                            {live.vehicleId && <em className="bus-badge"><BusFront size={14} /> Bus {live.vehicleId}</em>}
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
          {live.vehicleId && <span className="bus-badge"><BusFront size={16} /> Bus {live.vehicleId}</span>}
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
  const delaySeconds = arrival?.delaySeconds ?? live.handoverDelaySeconds ?? live.delaySeconds ?? 0;
  const rawDelayed = delaySeconds > 60;
  const early = delaySeconds < -60;
  const plannedArrival = arrival?.plannedArrival ?? live.handoverPlannedTime ?? takeover.entry.movement.vertrek;
  const predicted = arrival?.expectedAt
    ? formatEpochClock(arrival.expectedAt)
    : live.handoverExpectedAt
      ? formatEpochClock(live.handoverExpectedAt)
      : formatArrivalWithDelay(plannedArrival, delaySeconds);
  const vehicleId = arrival?.vehicleId ?? live.vehicleId;
  const expectedArrivalMinute = alignMinuteNearTarget(
    parseTime(predicted) ?? (parseTime(plannedArrival) ?? takeover.entry.timing.start) + delaySeconds / 60,
    takeover.entry.timing.start,
  );
  const minutesToDeparture = Math.ceil(takeover.entry.timing.start - expectedArrivalMinute);
  const delayed = rawDelayed && minutesToDeparture <= 7;
  const expectedDepartureMinute = live.handoverDepartureExpectedAt === undefined
    ? undefined
    : alignMinuteNearTarget(parseTime(formatEpochClock(live.handoverDepartureExpectedAt)) ?? takeover.entry.timing.start, takeover.entry.timing.start);

  if (
    live.handoverDeparted
    || expectedDepartureMinute !== undefined && currentMinute > expectedDepartureMinute
    || rawDelayed && minutesToDeparture > 7
  ) {
    return null;
  }

  return (
    <div className={`guidance-action-takeover ${delayed ? "late" : early ? "early" : "on-time"}`}>
      <strong>Overname bij {takeover.entry.movement.van || "halte"}</strong>
      <span>
        {vehicleId ? `Bus ${vehicleId} ` : "Bus "}
        {`aankomst ${predicted}${delayed || early ? ` (${formatHandoverDifference(delaySeconds)})` : ""}, ${formatDepartureWindow(minutesToDeparture, takeover.entry.movement.vertrek)}`}
      </span>
    </div>
  );
}

function GuidanceTakeover({ takeover, live, arrival, past }: { takeover: GuidanceTakeover; live: GuidanceLiveInfo; arrival?: TakeoverArrivalInfo; past: boolean }) {
  const { movement } = takeover.entry;
  const delaySeconds = arrival?.delaySeconds ?? live.handoverDelaySeconds ?? live.delaySeconds ?? 0;
  const rawDelayed = delaySeconds > 60;
  const early = delaySeconds < -60;
  const expectedArrival = arrival?.expectedAt
    ? formatEpochClock(arrival.expectedAt)
    : arrival
      ? formatArrivalWithDelay(arrival.plannedArrival, delaySeconds)
      : live.handoverExpectedAt
        ? formatEpochClock(live.handoverExpectedAt)
        : formatTimelineMinute(takeover.entry.timing.start + delaySeconds / 60);
  const location = movement.van || "de overnamehalte";
  const timingLabel = arrival?.stopSpecific || live.handoverStopSpecific ? "Aankomst bij halte" : "Geschatte aankomst";
  const vehicleId = arrival?.vehicleId ?? live.vehicleId;
  const plannedArrival = arrival?.plannedArrival ?? live.handoverPlannedTime ?? movement.vertrek;
  const expectedArrivalMinute = alignMinuteNearTarget(
    parseTime(expectedArrival) ?? (parseTime(plannedArrival) ?? takeover.entry.timing.start) + delaySeconds / 60,
    takeover.entry.timing.start,
  );
  const minutesToDeparture = Math.ceil(takeover.entry.timing.start - expectedArrivalMinute);
  const delayed = rawDelayed && minutesToDeparture <= 7;

  return (
    <li className={`guidance-takeover ${delayed ? "late" : early ? "early" : "on-time"}${past ? " past" : ""}${vehicleId ? " has-bus" : ""}${movement.omloopnummer ? " has-loop" : ""}`}>
      <span className="guidance-takeover-rail" aria-hidden="true" />
      <div className="guidance-takeover-info">
        <strong>Overname</strong>
        <span>{location} - gepland: aankomst {plannedArrival}, vertrek {movement.vertrek}</span>
      </div>
      {vehicleId && (
        <div className="guidance-takeover-bus" title={`Bus ${vehicleId}`}>
          <BusFront size={20} />
          <span>Bus</span>
          <strong>{vehicleId}</strong>
        </div>
      )}
      {movement.omloopnummer && (
        <div className="guidance-takeover-loop" title={`Omloop ${displayLoopNumber(movement.omloopnummer)}`}>
          <span>Omloop</span>
          <strong>{displayLoopNumber(movement.omloopnummer)}</strong>
        </div>
      )}
      <div className="guidance-takeover-status">
        <span>{delayed ? "Te laat" : early ? "Te vroeg" : "Op tijd"}</span>
        <strong>
          {delayed || early
            ? `${timingLabel} ${expectedArrival} (${formatHandoverDifference(delaySeconds)})`
            : `${timingLabel} ${expectedArrival}`}
        </strong>
      </div>
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
        {currentLive.vehicleId && <small title={`Live voertuignummer: ${currentLive.vehicleId}`}>Bus {currentLive.vehicleId}</small>}
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
  onSelect,
}: {
  movement: Movement;
  left: number;
  width: number;
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
      className={`movement-block type-${movement.type}${isExpanded ? " is-expanded" : ""}`}
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
      <strong className="movement-line-number">{formatLineLabel(movement.lijnnummer, movement.type)}</strong>
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
  onClose,
}: {
  movement: Movement;
  liveStatus?: LiveMovementStatus;
  onClose: () => void;
}) {
  const delay = liveStatus?.delaySeconds;
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
            {liveStatus?.vehicleId && <span><BusFront size={16} /> Bus {liveStatus.vehicleId}</span>}
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

type TimelineTiming = {
  start: number;
  end: number;
};

type ServiceSpan = {
  dienstnummer: string;
  start: number;
  end: number;
};

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

function buildGuidanceEntries(movements: Movement[], dutyStart: string | undefined): GuidanceEntry[] {
  const referenceStart = dutyStart ? parseTime(dutyStart) : undefined;

  return movements
    .map((movement) => {
      let start = parseTime(movement.vertrek);
      let end = parseTime(movement.aankomst);
      if (start === undefined || end === undefined) {
        return undefined;
      }
      if (referenceStart !== undefined && start < referenceStart - 12 * 60) {
        start += 24 * 60;
      }
      if (start >= 24 * 60 && end < 24 * 60) {
        end += 24 * 60;
      }
      if (end < start) {
        end += 24 * 60;
      }

      return { movement, timing: { start, end } };
    })
    .filter((entry): entry is GuidanceEntry => entry !== undefined)
    .sort((first, second) => first.timing.start - second.timing.start || first.timing.end - second.timing.end);
}

function buildGuidanceTakeovers(entries: GuidanceEntry[]): Map<string, GuidanceTakeover> {
  const takeovers = new Map<string, GuidanceTakeover>();
  let previousLoop: string | undefined;

  for (const entry of entries) {
    if (!isVehicleTimelineMovement(entry.movement)) {
      continue;
    }

    const loop = loopKey(entry.movement);
    if (loop !== previousLoop) {
      takeovers.set(entry.movement.id, { entry });
      previousLoop = loop;
    }
  }

  return takeovers;
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
    .filter(isVehicleTimelineMovement)
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

function alignMinuteToEntries(currentTime: Date, entries: GuidanceEntry[]): number {
  const minute = currentTime.getHours() * 60 + currentTime.getMinutes() + currentTime.getSeconds() / 60;
  if (entries.length === 0) {
    return minute;
  }
  return alignCurrentMinute(minute, { start: entries[0].timing.start, end: entries.at(-1)!.timing.end });
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

function formatDelay(seconds: number): string {
  if (seconds > 60) {
    return `+${Math.round(seconds / 60)} min vertraagd`;
  }
  if (seconds < -60) {
    return `${Math.round(seconds / 60)} min te vroeg`;
  }
  return "Op tijd";
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

function formatArrivalWithDelay(plannedArrival: string, delaySeconds: number): string {
  const minute = parseTime(plannedArrival);
  return minute === undefined ? plannedArrival : formatTimelineMinute(minute + delaySeconds / 60);
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

function isVehicleTimelineMovement(movement: Movement): boolean {
  if (!movement.omloopnummer) {
    return false;
  }

  if (isDriverOnlyMovement(movement)) {
    return false;
  }

  return movement.type === "rit" || movement.type === "materiaal";
}

function isDriverOnlyMovement(movement: Movement): boolean {
  const label = `${movement.van} ${movement.naar} ${movement.raw}`.toLowerCase();

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
