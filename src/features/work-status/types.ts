export type WorkStatusState =
  | "draft"
  | "awaitingApproval"
  | "changesRequested"
  | "checksFailing"
  | "checksPending"
  | "readyToMerge"
  | "mergeBlocked"
  | "error";

export type WorkStatusSource = "github";

export interface WorkStatusItem {
  id: string;
  title: string;
  subtitle?: string;
  groupName: string;
  projectId?: string | null;
  source: WorkStatusSource;
  status: WorkStatusState;
  updatedAt: string;
  destination: {
    type: "url";
    url: string;
  };
}

export interface WorkStatusSnapshot {
  chats: WorkStatusItem[];
  pullRequests: WorkStatusItem[];
  errors: WorkStatusError[];
  isFresh: boolean;
  isTruncated: boolean;
}

export type WorkStatusErrorCode =
  | "authentication"
  | "cliMissing"
  | "timeout"
  | "database"
  | "network"
  | "rateLimited"
  | "unknown";

export interface WorkStatusError {
  id: string;
  source: WorkStatusSource;
  code: WorkStatusErrorCode;
  message: string;
}
