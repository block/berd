// Public entry for the berdctl feature. Keep this navigation-only so session
// windows cannot reach the bridge/lifecycle/command registry through AppShell.
export {
  type AppNavigationPrimitives,
  useRegisterAppNavigationController,
} from "@/features/berdctl/navigation";
export {
  type AppContext,
  type AppNavigationController,
  type ArchiveCleanupPolicy,
  type CommandFailureReason,
  type CommandOutcome,
  getAppNavigationController,
} from "@/features/berdctl/navigation";
