// Recovered from popup/popup.js (L2-L4)
export const RECORDING_SCHEMA_VERSION = 1;

// [RECONSTRUCTED TYPE DECLARATIONS from runtime usage in db.ts, inject.ts, content.ts, popup.ts]
export interface SocketInfo {
  index: number;
  url: string;
  openedAt: number;
}

export interface Frame {
  t: number;
  dir: "in" | "out";
  kind: "text" | "binary";
  data: string;
  socket: number;
}

export type WsFrame = Frame;

export interface MapView {
  rot: number;
  flip: boolean;
}

export interface IconNumber {
  icon: string;
  value: number;
}

export interface PanelPlayerSnapshot {
  color: string;
  text: string;
  cards?: number;
  stats: IconNumber[];
}

export type PanelPlayer = PanelPlayerSnapshot;

export interface PanelSnapshot {
  after?: number;
  players: PanelPlayerSnapshot[];
}

export interface LogEntry {
  t: number;
  text: string;
  idx?: number;
  color?: string;
  panel?: PanelSnapshot;
}

export interface Shot {
  t: number;
  label: string;
  dataUrl: string;
}

export interface EndScreenRow {
  player: string;
  values: IconNumber[];
  text: string;
}

export interface EndScreenTabCapture {
  text: string;
  rows: EndScreenRow[];
  t: number;
}

export interface EndScreenCapture {
  header: string;
  tabs: Record<string, EndScreenTabCapture>;
}

export interface HintEntry {
  t: number;
  phase: "opening" | "midgame" | string;
  text: string;
  at?: string;
}

export interface RecordingMeta {
  me?: string;
  userAgent?: string;
  logGaps?: number;
  shotError?: string;
  endScreen?: EndScreenCapture;
  endScreenText?: string;
  hints?: HintEntry[];
  [key: string]: unknown;
}

export interface FlushMessage {
  kind: "flush";
  id: string;
  gameId: string;
  url: string;
  sockets: SocketInfo[];
  frames: WsFrame[];
  log: LogEntry[];
  meta: RecordingMeta;
}

export interface ShotMessage {
  kind: "shot";
  id: string;
  gameId: string;
  url: string;
  label: string;
  t: number;
}

export interface Recording {
  schemaVersion: number;
  id: string;
  gameId: string;
  url: string;
  startedAt: number;
  endedAt: number;
  sockets: SocketInfo[];
  meta: RecordingMeta;
  frames: Frame[];
  log: LogEntry[];
  shots: Shot[];
}

export interface RecordingSummary {
  id: string;
  gameId: string;
  url: string;
  startedAt: number;
  endedAt: number;
  frameCount: number;
  logCount: number;
  bytes: number;
}

export interface AppendBatchInput {
  id: string;
  gameId: string;
  url: string;
  sockets: SocketInfo[];
  frames: Frame[];
  log: LogEntry[];
  shots?: Shot[];
  meta?: RecordingMeta;
}
