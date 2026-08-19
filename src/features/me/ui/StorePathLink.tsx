import { revealInFileManager } from "@/shared/lib/fileManager";

/**
 * A store path that opens where it points.
 *
 * The path *is* the link: naming a location and then offering a separate
 * "Go to file" said the same thing twice, and the path is the part a person
 * recognizes. Best-effort — if the file manager can't open it, the text still
 * answers the question on its own.
 */
export function StorePathLink({
  path,
  label,
}: {
  /** The real path to reveal. */
  path: string;
  /** How it reads on screen, usually ~-relative. */
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        void revealInFileManager(path).catch(() => {});
      }}
      className="underline underline-offset-2 hover:text-foreground"
    >
      {label}
    </button>
  );
}
