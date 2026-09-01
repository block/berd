import { expect, test } from "@playwright/test";

/**
 * Browser layout test for Streamdown table overflow behavior.
 *
 * Verifies that `overflow-wrap: anywhere` (not just `break-word`) constrains
 * long unbreakable strings within table cells, keeping the table within its
 * container width instead of expanding horizontally.
 */

const TABLE_CSS = `
  [data-streamdown="table-wrapper"] > div:has(> [data-streamdown="table"]) {
    overflow-y: auto;
    overflow-x: auto;
    max-height: 300px;
  }
  [data-streamdown="table"] {
    border-collapse: collapse;
    width: 100%;
  }
  [data-streamdown="table"] th {
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1rem;
    white-space: normal;
  }
  [data-streamdown="table"] td {
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }
`;

function tableHTML(cellContent: string): string {
  return `
    <div data-streamdown="table-wrapper">
      <div>
        <table data-streamdown="table">
          <thead>
            <tr><th>Column</th></tr>
          </thead>
          <tbody>
            <tr><td>${cellContent}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

test.describe("Streamdown table overflow", () => {
  test("long unbreakable string wraps within cell width", async ({ page }) => {
    const longToken = "a".repeat(200);
    const containerWidth = 300;

    await page.setContent(`
      <div style="width: ${containerWidth}px;">
        ${tableHTML(longToken)}
      </div>
    `);
    await page.addStyleTag({ content: TABLE_CSS });

    const wrapper = page.locator('[data-streamdown="table-wrapper"]');
    const scrollContainer = wrapper.locator("div").first();

    // The scroll container should not be wider than its 300px parent.
    const containerBox = await scrollContainer.boundingBox();
    expect(containerBox).not.toBeNull();
    expect(containerBox!.width).toBeLessThanOrEqual(containerWidth);

    // The table itself should also fit within the container (no horizontal overflow).
    const table = page.locator('[data-streamdown="table"]');
    const tableBox = await table.boundingBox();
    expect(tableBox).not.toBeNull();
    expect(tableBox!.width).toBeLessThanOrEqual(containerWidth);
  });

  test("tables taller than max-height scroll vertically", async ({ page }) => {
    const rows = Array.from(
      { length: 50 },
      (_, i) => `<tr><td>Row ${i + 1}</td></tr>`,
    ).join("");
    const containerWidth = 300;

    await page.setContent(`
      <div style="width: ${containerWidth}px;">
        <div data-streamdown="table-wrapper">
          <div>
            <table data-streamdown="table">
              <thead>
                <tr><th>Column</th></tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `);
    await page.addStyleTag({ content: TABLE_CSS });

    const scrollContainer = page.locator(
      '[data-streamdown="table-wrapper"] > div',
    );
    const scrollHeight = await scrollContainer.evaluate(
      (el) => el.scrollHeight,
    );
    const clientHeight = await scrollContainer.evaluate(
      (el) => el.clientHeight,
    );

    // Content is taller than the 300px max-height.
    expect(scrollHeight).toBeGreaterThan(clientHeight);

    // The overflow-y should be auto (scrollable), not hidden.
    const overflowY = await scrollContainer.evaluate(
      (el) => getComputedStyle(el).overflowY,
    );
    expect(overflowY).toBe("auto");
  });
});
