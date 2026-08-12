export function getImageFilesFromClipboardItems(
  items: DataTransferItemList,
): File[] {
  return Array.from(items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}
