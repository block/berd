import { useEffect, useState, type RefObject } from "react";

function countGridColumns(element: HTMLElement | null): number {
  if (!element || typeof window === "undefined") {
    return 1;
  }

  const templateColumns = window
    .getComputedStyle(element)
    .gridTemplateColumns.trim();
  if (!templateColumns || templateColumns === "none") {
    return 1;
  }

  return Math.max(1, templateColumns.split(/\s+/).length);
}

export function useGridColumnCount(
  gridRef: RefObject<HTMLElement | null>,
): number {
  const [columns, setColumns] = useState(() =>
    countGridColumns(gridRef.current),
  );

  useEffect(() => {
    const updateColumns = () => setColumns(countGridColumns(gridRef.current));
    updateColumns();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateColumns);
      return () => window.removeEventListener("resize", updateColumns);
    }

    const observer = new ResizeObserver(updateColumns);
    if (gridRef.current) {
      observer.observe(gridRef.current);
    }
    window.addEventListener("resize", updateColumns);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateColumns);
    };
  }, [gridRef]);

  return columns;
}
