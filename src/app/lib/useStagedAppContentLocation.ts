import { startTransition, useEffect, useRef, useState } from "react";
import type { AppNavigationLocation } from "../types/appNavigation";
import { areAppNavigationLocationsEqual } from "./appNavigationLocation";
import { scheduleAfterNextPaint } from "./scheduleAfterNextPaint";

export type StagedAppContentLocation = {
  targetLocation: AppNavigationLocation;
  renderedLocation: AppNavigationLocation;
  isPreparingContent: boolean;
};

export function useStagedAppContentLocation(
  targetLocation: AppNavigationLocation,
): StagedAppContentLocation {
  const [renderedLocation, setRenderedLocation] =
    useState<AppNavigationLocation>(targetLocation);
  const pendingUpdateIdRef = useRef(0);
  const isSettingsSectionChange =
    renderedLocation.view === "settings" &&
    targetLocation.view === "settings" &&
    !areAppNavigationLocationsEqual(renderedLocation, targetLocation);
  const stageRouteContent =
    targetLocation.view !== "chat" &&
    targetLocation.view !== "home" &&
    !isSettingsSectionChange;
  const visibleRenderedLocation = stageRouteContent
    ? renderedLocation
    : targetLocation;
  const isPreparingContent =
    stageRouteContent &&
    !areAppNavigationLocationsEqual(renderedLocation, targetLocation);

  useEffect(() => {
    if (!stageRouteContent) {
      pendingUpdateIdRef.current += 1;
      setRenderedLocation((currentLocation) =>
        areAppNavigationLocationsEqual(currentLocation, targetLocation)
          ? currentLocation
          : targetLocation,
      );
      return;
    }

    if (!isPreparingContent) {
      return;
    }

    const updateId = pendingUpdateIdRef.current + 1;
    pendingUpdateIdRef.current = updateId;
    const cancelScheduledUpdate = scheduleAfterNextPaint(() => {
      if (pendingUpdateIdRef.current !== updateId) {
        return;
      }

      startTransition(() => {
        setRenderedLocation((currentLocation) => {
          if (pendingUpdateIdRef.current !== updateId) {
            return currentLocation;
          }
          if (areAppNavigationLocationsEqual(currentLocation, targetLocation)) {
            return currentLocation;
          }
          return targetLocation;
        });
      });
    });

    return () => {
      pendingUpdateIdRef.current += 1;
      cancelScheduledUpdate();
    };
  }, [isPreparingContent, stageRouteContent, targetLocation]);

  return {
    targetLocation,
    renderedLocation: visibleRenderedLocation,
    isPreparingContent,
  };
}
