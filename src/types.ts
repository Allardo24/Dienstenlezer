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
  sourceFileId?: string;
  divisionId?: string;
  sourceContentHash?: string;
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
  materieelsoort?: string;
  vertrek: string;
  aankomst: string;
  van: string;
  naar: string;
  type: MovementType;
  raw: string;
  sourceFileId?: string;
  divisionId?: string;
  sourceContentHash?: string;
};

export type ParseResult = {
  fileName: string;
  diensten: Dienst[];
  movements: Movement[];
  warnings: string[];
  sourceFileId?: string;
  divisionId?: string;
  sourceContentHash?: string;
};

export type DaySegment = "weekday" | "saturday" | "sunday" | "unassigned";

export type Concession = {
  id: string;
  name: string;
};

export type Division = {
  id: string;
  name: string;
  concessionId: string;
};

export type OrganizationConfig = {
  concessions: Concession[];
  divisions: Division[];
};

export type AdminSettings = {
  buslessActions: string[];
  ortRates: OrtRates;
};

export type OrtRates = {
  weekdayEarlyPercent: number;
  weekdayEveningPercent: number;
  saturdayPercent: number;
  nightPercent: number;
  sundayPercent: number;
  sundayNightPercent: number;
};

export type StoredPdfFile = {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  uploadedAt: number;
  enabled: boolean;
  expiresOn?: string;
  daySegment: DaySegment;
  divisionId: string;
  contentHash?: string;
  file?: Blob;
  parseResult: ParseResult;
};

export type StoredPdfFileSummary = Omit<StoredPdfFile, "file" | "parseResult"> & {
  active: boolean;
  serviceCount: number;
  movementCount: number;
};

export type StoredPdfCatalog = {
  schemaVersion: number;
  revision: string;
  segmentRevisions: Record<DaySegment, string>;
  organization: OrganizationConfig;
  adminSettings: AdminSettings;
  files: StoredPdfFileSummary[];
};

export type StoredSchedule = {
  schemaVersion: number;
  key: string;
  segment: DaySegment;
  divisionIds: string[];
  catalogRevision: string;
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
  handoverArrived?: boolean;
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
  fetchedAt?: number;
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
