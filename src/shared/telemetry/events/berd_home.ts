// Vendored typed telemetry event factories. Originally generated from
// squareup/message-schemas (cdp_events/berd_home/berd_home.yaml); the
// generator is not part of this repo, so this is ordinary source now — edit by
// hand and keep event/param names aligned with the schema repo.

import type { Event } from "./event";

export type BerdHomeHomeItemType =
  | "HOME_ITEM_TYPE_AGENT"
  | "HOME_ITEM_TYPE_CHAT"
  | "HOME_ITEM_TYPE_PROJECT"
  | "HOME_ITEM_TYPE_AUTOMATION"
  | "HOME_ITEM_TYPE_SKILL";

export interface BerdHomePinPinnedParams {
  /** Kind of entity pinned to the Home page. */
  item_type: BerdHomeHomeItemType;
}

/**
 * BerdHome · Pin · Pinned
 *
 * Tracks when the user pins an item to the Home page.
 *
 * Feature: Events related to pinning items on the Home page, a free-form widget canvas, in the Berd desktop app
 * Action: Events related to pinning items to the Home page
 */
export function berdHomePinPinned(params: BerdHomePinPinnedParams): Event {
  return {
    name: "berd_home_pin_pinned",
    parameters: {
      item_type: params.item_type,
    },
  };
}

export interface BerdHomeUnpinUnpinnedParams {
  /** Kind of entity unpinned from the Home page. */
  item_type: BerdHomeHomeItemType;
}

/**
 * BerdHome · Unpin · Unpinned
 *
 * Tracks when the user unpins an item from the Home page.
 *
 * Feature: Events related to pinning items on the Home page, a free-form widget canvas, in the Berd desktop app
 * Action: Events related to unpinning items from the Home page
 */
export function berdHomeUnpinUnpinned(
  params: BerdHomeUnpinUnpinnedParams,
): Event {
  return {
    name: "berd_home_unpin_unpinned",
    parameters: {
      item_type: params.item_type,
    },
  };
}
