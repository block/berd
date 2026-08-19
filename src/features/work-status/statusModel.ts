import type { WorkStatusState } from "./types";

export const WORK_STATUS_LABEL_KEYS = {
  draft: "workStatus.status.draft",
  awaitingApproval: "workStatus.status.awaitingApproval",
  changesRequested: "workStatus.status.changesRequested",
  checksFailing: "workStatus.status.checksFailing",
  checksPending: "workStatus.status.checksPending",
  readyToMerge: "workStatus.status.readyToMerge",
  mergeBlocked: "workStatus.status.mergeBlocked",
  error: "workStatus.status.error",
} satisfies Record<WorkStatusState, string>;
