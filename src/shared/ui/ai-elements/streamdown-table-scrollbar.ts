import { useLayoutEffect, type RefObject } from "react";

const STREAMDOWN_TABLE_SCROLLBAR_BLOCK_SIZE =
  "--streamdown-table-scrollbar-block-size";

function getStreamdownTableScrollContainers(root: ParentNode): HTMLElement[] {
  const scrollContainers = new Set<HTMLElement>();

  for (const table of root.querySelectorAll<HTMLElement>(
    '[data-streamdown="table-wrapper"] [data-streamdown="table"]',
  )) {
    if (table.parentElement) {
      scrollContainers.add(table.parentElement);
    }
  }

  return Array.from(scrollContainers);
}

function getStreamdownTableSizingElements(root: ParentNode): Element[] {
  const elements = new Set<Element>();

  for (const scrollContainer of getStreamdownTableScrollContainers(root)) {
    elements.add(scrollContainer);

    const table = scrollContainer.querySelector<HTMLElement>(
      ':scope > [data-streamdown="table"]',
    );
    if (table) {
      elements.add(table);
    }
  }

  return Array.from(elements);
}

export function measureStreamdownTableScrollbarBlockSize(
  scrollContainer: HTMLElement,
): number {
  if (scrollContainer.scrollWidth <= scrollContainer.clientWidth) {
    return 0;
  }

  const computedStyle = window.getComputedStyle(scrollContainer);
  const borderBlockSize =
    Number.parseFloat(computedStyle.borderTopWidth) +
    Number.parseFloat(computedStyle.borderBottomWidth);

  return Math.max(
    0,
    scrollContainer.offsetHeight -
      scrollContainer.clientHeight -
      borderBlockSize,
  );
}

export function syncStreamdownTableScrollbarSizing(root: ParentNode): void {
  for (const scrollContainer of getStreamdownTableScrollContainers(root)) {
    const scrollbarBlockSize =
      measureStreamdownTableScrollbarBlockSize(scrollContainer);

    scrollContainer.style.setProperty(
      STREAMDOWN_TABLE_SCROLLBAR_BLOCK_SIZE,
      `${scrollbarBlockSize}px`,
    );
  }
}

export function useStreamdownTableScrollbarSizing(
  rootRef: RefObject<HTMLElement | null>,
  contentKey: unknown,
): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    let measureFrame: number | null = null;
    const scheduleMeasure = () => {
      if (measureFrame !== null) {
        return;
      }

      measureFrame = window.requestAnimationFrame(() => {
        measureFrame = null;
        syncStreamdownTableScrollbarSizing(root);
      });
    };

    const cancelScheduledMeasure = () => {
      if (measureFrame === null) {
        return;
      }

      window.cancelAnimationFrame(measureFrame);
      measureFrame = null;
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleMeasure);
    const observedElements = new Set<Element>();
    const observeElement = (element: Element) => {
      if (!resizeObserver || observedElements.has(element)) {
        return;
      }

      resizeObserver.observe(element);
      observedElements.add(element);
    };
    const observeCurrentTableElements = () => {
      observeElement(root);
      for (const element of getStreamdownTableSizingElements(root)) {
        observeElement(element);
      }
    };

    observeCurrentTableElements();
    syncStreamdownTableScrollbarSizing(root);

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            observeCurrentTableElements();
            scheduleMeasure();
          });

    mutationObserver?.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => {
      cancelScheduledMeasure();
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [contentKey, rootRef]);
}
