import {
  dispatchOnboarding,
  useOnboardingState,
} from "../model/onboardingStore";
import { WelcomeStep } from "./WelcomeStep";

/** The first-run landing ceremony. Advancing enters Berd immediately. */
export function OnboardingFlow() {
  const state = useOnboardingState();

  return (
    <WelcomeStep
      recordedShareUsageData={state.shareUsageData}
      onRecordShareUsageData={(shareUsageData) =>
        dispatchOnboarding({ type: "set-share-usage-data", shareUsageData })
      }
      onStart={() => dispatchOnboarding({ type: "complete" })}
    />
  );
}
