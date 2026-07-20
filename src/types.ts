export type TextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
};

export type Dienst = {
  id: string;
  serviceNumber: string;
  sourceFile: string;
  pageNumber: number;
  date?: string;
  location?: string;
  start?: string;
  end?: string;
  length?: string;
};

export type MovementType = "rit" | "materiaal" | "pauze" | "dienst" | "overig";

export type Movement = {
  id: string;
  sourceFile: string;
  pageNumber: number;
  dienstnummer: string;
  datum?: string;
  omloopnummer?: string;
  lijnnummer?: string;
  ritnummer?: string;
  vertrek: string;
  aankomst: string;
  van: string;
  naar: string;
  type: MovementType;
  raw: string;
};

export type ParseResult = {
  fileName: string;
  diensten: Dienst[];
  movements: Movement[];
  warnings: string[];
};

export type DaySegment = "weekday" | "saturday" | "sunday" | "unassigned";

export type StoredPdfFile = {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  uploadedAt: number;
  enabled: boolean;
  daySegment: DaySegment;
  contentHash?: string;
  file?: Blob;
  parseResult: ParseResult;
};

export type StoredPdfFileSummary = Omit<StoredPdfFile, "file" | "parseResult"> & {
  serviceCount: number;
  movementCount: number;
};

export type StoredPdfCatalog = {
  schemaVersion: number;
  revision: string;
  segmentRevisions: Record<DaySegment, string>;
  files: StoredPdfFileSummary[];
};

export type StoredSchedule = {
  schemaVersion: number;
  segment: DaySegment;
  revision: string;
  results: ParseResult[];
};

export type LiveMovementRequest = {
  movementId: string;
  loopNumber?: string;
  serviceNumber?: string;
  lineNumber?: string;
  tripNumber?: string;
  departure: string;
  arrival: string;
  from: string;
  to: string;
  type: MovementType;
};

export type LiveMovementStatus = {
  movementId: string;
  matched: boolean;
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
  tripId?: string;
  vehicleId?: string;
  updatedAt?: number;
};

export type LiveSyncState = {
  state: "ready" | "syncing" | "unavailable" | "error";
  message: string;
  indexedAt?: number;
};

export type LiveDiagnostics = {
  requested: number;
  matched: number;
  noLineOrTrip: number;
  noMatchingTime: number;
  ambiguous: number;
  realtimeUpdates: number;
  delayUpdates: number;
  vehicleUpdates: number;
};

export type LiveStatusResponse = {
  statuses: LiveMovementStatus[];
  sync: LiveSyncState;
  diagnostics?: LiveDiagnostics;
};
