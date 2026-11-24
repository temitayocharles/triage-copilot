export type Severity = "P1" | "P2" | "P3" | "P4";

export type Category =
  | "deploy"
  | "infrastructure"
  | "database"
  | "network"
  | "application"
  | "security"
  | "unknown";

export interface TriageResult {
  severity: Severity;
  category: Category;
  component: string;
  summary: string;
  confidence: number;
  signals: string[];
}

export type InferencePath = "on_device" | "in_cloud" | "unknown";

export interface RunMeta {
  path: InferencePath;
  modelLabel: string;
  latencyMs: number;
}

export interface HistoryEntry {
  id: string;
  time: number;
  input: string;
  triage: TriageResult;
  triageMeta: RunMeta;
  diagnosis: string | null;
  diagnosisMeta: RunMeta | null;
}

export type TriageMode = "prefer_on_device" | "only_on_device" | "only_in_cloud";

export type DeviceAvailability =
  | "checking"
  | "available"
  | "downloading"
  | "downloadable"
  | "unavailable"
  | "unsupported";
