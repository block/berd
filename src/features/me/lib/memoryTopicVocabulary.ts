/**
 * The broad areas a *new* memory topic may be named after.
 *
 * Kept deliberately small and life-shaped. The risk isn't list length —
 * unused names are invisible until earned — it's overlap: two plausible
 * homes for one fact means the same fact routes differently across passes
 * and piles up as near-duplicates. So every pair has a boundary:
 * household vs. outside it (Home/Social), people vs. tastes
 * (Social/Interests), tastes vs. logistics (Interests/Travel), personal
 * vs. professional (Social/Work).
 *
 * Both proposal doors are bound by this list: the noticer picks from it,
 * and approvals only create a topic file when a novel name matches it —
 * otherwise a drifting model ("Soccer", "Jazz") could sprawl memory into
 * narrow topics the noticer would never produce.
 *
 * A user's existing topics always win over this list, and users can name
 * their own topics however they like in Settings → Memory.
 */
export const MEMORY_TOPIC_VOCABULARY = [
  "Home",
  "Social",
  "Interests",
  "Travel",
  "Shopping",
  "Work",
  "Tools",
] as const;

/**
 * The vocabulary name matching `topic`, or null when it isn't one of the
 * broad areas. Case-insensitive; existing topics are matched elsewhere.
 */
export function vocabularyTopicName(topic: string): string | null {
  const wanted = topic.trim().toLowerCase();
  return (
    MEMORY_TOPIC_VOCABULARY.find((name) => name.toLowerCase() === wanted) ??
    null
  );
}
