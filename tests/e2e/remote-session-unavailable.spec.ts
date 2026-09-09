import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, open: false },
    plugins: [
      {
        name: "unavailable-session-fixture",
        configureServer(vite) {
          vite.middlewares.use("/unavailable-session", async (_req, res) => {
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                "/unavailable-session",
                `
            <!doctype html><html lang="en"><body><main id="root" style="max-width:640px;margin:80px auto;padding:16px"></main>
            <script type="module">
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { RemoteSessionUnavailableNotice } from '/src/features/chat/ui/RemoteSessionUnavailableNotice.tsx';
              import { i18n } from '/src/shared/i18n/index.ts';
              import '/src/shared/styles/globals.css';
              await i18n.changeLanguage(new URLSearchParams(location.search).get('lang') || 'en');
              await i18n.loadNamespaces('chat');
              createRoot(document.getElementById('root')).render(React.createElement(RemoteSessionUnavailableNotice));
            </script></body></html>`,
              ),
            );
          });
        },
      },
    ],
  });
  await server.listen();
  url = `${server.resolvedUrls?.local[0]}unavailable-session`;
});
test.afterAll(async () => {
  await server?.close();
});

test("unavailable notice stays readable without recovery actions", async ({
  page,
}, testInfo) => {
  for (const lang of ["en", "es"]) {
    await page.goto(`${url}?lang=${lang}`);
    const notice = page.getByRole("status");
    await expect(notice).toContainText(
      lang === "en"
        ? "This session is no longer available"
        : "Esta sesión ya no está disponible",
    );
    await expect(notice.getByRole("button")).toHaveCount(0);
    await expect(notice).toContainText(
      lang === "en" ? "shown above" : "se muestran arriba",
    );
    await expect(notice).toContainText(
      lang === "en"
        ? "may disappear when you restart Berd"
        : "pueden desaparecer al reiniciar Berd",
    );
    for (const width of [360, 800]) {
      await page.setViewportSize({ width, height: 400 });
      expect(
        await notice.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
    if (lang === "en")
      await notice.screenshot({
        path: testInfo.outputPath("remote-session-unavailable-en.png"),
      });
  }
});
