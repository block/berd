import { beforeAll, beforeEach, afterAll, onTestFailed } from "vitest";
import {
  type TestDriver,
  createTestDriver,
  isTestDriverConnectionError,
  reconnectTestDriverUntilElement,
} from "./test-driver-client";

declare const __SCREENSHOT_DIR__: string;
declare const __SCREENSHOT_ON_FAILURE__: boolean;

export const useTestDriver = ({
  reconnectAfterHomeNavigation = false,
  homeReadySelector = '[data-testid="chat-composer"]',
  captureFailureScreenshot = true,
}: {
  reconnectAfterHomeNavigation?: boolean;
  homeReadySelector?: string;
  captureFailureScreenshot?: boolean;
} = {}): TestDriver => {
  let inner: TestDriver;

  const testDriver = new Proxy({} as TestDriver, {
    get(_target, prop) {
      if (!inner)
        throw new Error("Test driver not connected — is beforeAll running?");
      return inner[prop as keyof TestDriver];
    },
  });

  beforeAll(async () => {
    inner = await createTestDriver();
  });

  afterAll(() => {
    inner?.close();
  });

  beforeEach(
    async () => {
      // Navigate to home before each test for clean state
      try {
        await inner.click('[data-testid="nav-home"]');
      } catch (error) {
        if (
          !reconnectAfterHomeNavigation ||
          !isTestDriverConnectionError(error)
        ) {
          throw error;
        }
      }
      if (reconnectAfterHomeNavigation) {
        await reconnectTestDriverUntilElement(inner, homeReadySelector);
      }

      if (__SCREENSHOT_ON_FAILURE__ && captureFailureScreenshot) {
        onTestFailed(async ({ task }) => {
          const name = task.name.replace(/\s+/g, "-").toLowerCase();
          const path = `${__SCREENSHOT_DIR__}/fail-${name}-${Date.now()}.png`;
          try {
            await inner.screenshot(path);
            console.log(`Screenshot saved: ${path}`);
          } catch (error) {
            if (!isTestDriverConnectionError(error)) throw error;
            console.warn("Skipped failure screenshot after webview restart.");
          }
        });
      }
    },
    reconnectAfterHomeNavigation ? 60_000 : undefined,
  );

  return testDriver;
};
