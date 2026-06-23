import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import {
  ArtifactPolicyProvider,
  useArtifactPolicyContext,
} from "../ArtifactPolicyContext";

const mockPathExists = vi.fn<(path: string) => Promise<boolean>>();

vi.mock("@/shared/api/system", () => ({
  pathExists: (path: string) => mockPathExists(path),
}));

function ArtifactsProbe() {
  const { getAllSessionArtifacts } = useArtifactPolicyContext();
  const artifacts = getAllSessionArtifacts();

  return (
    <div>
      <span data-testid="artifact-paths">
        {artifacts.map((artifact) => artifact.resolvedPath).join(",")}
      </span>
      <span data-testid="artifact-count">{String(artifacts.length)}</span>
    </div>
  );
}

function LinkProbe({ href }: { href: string }) {
  const { resolveMarkdownHref } = useArtifactPolicyContext();
  const candidate = resolveMarkdownHref(href);

  return (
    <div>
      <span data-testid="link-has-candidate">{String(candidate !== null)}</span>
      <span data-testid="link-path">{candidate?.resolvedPath ?? ""}</span>
      <span data-testid="link-within-cwd">
        {String(candidate?.isWithinSessionCwd ?? false)}
      </span>
    </div>
  );
}

describe("ArtifactPolicyContext", () => {
  it("uses reported ACP tool locations as session artifacts", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        role: "assistant",
        created: Date.now(),
        content: [
          {
            type: "toolRequest",
            id: "tool-1",
            name: "read_file",
            arguments: {},
            status: "completed",
            toolKind: "read",
            locations: [{ path: "/Users/test/project-a/notes.md" }],
          },
          {
            type: "toolResponse",
            id: "tool-1",
            name: "read_file",
            result: "Read notes",
            isError: false,
          },
        ],
      },
    ];

    render(
      <ArtifactPolicyProvider
        messages={messages}
        sessionCwd="/Users/test/project-a"
      >
        <ArtifactsProbe />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("artifact-count")).toHaveTextContent("1");
    expect(screen.getByTestId("artifact-paths")).toHaveTextContent(
      "/Users/test/project-a/notes.md",
    );
  });

  it("does not filter reported locations outside allowed roots", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        role: "assistant",
        created: Date.now(),
        content: [
          {
            type: "toolRequest",
            id: "tool-1",
            name: "write_file",
            arguments: {},
            status: "completed",
            toolKind: "edit",
            locations: [{ path: "/tmp/outside.md" }],
          },
        ],
      },
    ];

    render(
      <ArtifactPolicyProvider
        messages={messages}
        sessionCwd="/Users/test/project-a"
      >
        <ArtifactsProbe />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("artifact-paths")).toHaveTextContent(
      "/tmp/outside.md",
    );
  });

  it("resolves local markdown hrefs relative to the session cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="output/report.md" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/test/app/output/report.md",
    );
  });

  it("decodes percent-encoded spaces in an absolute markdown href", () => {
    // The default chat working dir is "~/goose artifacts" (has a space), so a
    // correctly-authored markdown image escapes the space as %20. The resolved
    // path must be decoded so path_exists/convertFileSrc see the real path.
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="/Users/test/goose%20artifacts/smiley.svg" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/test/goose artifacts/smiley.svg",
    );
  });

  it("decodes percent-encoded spaces in a relative markdown href", () => {
    render(
      <ArtifactPolicyProvider
        messages={[]}
        sessionCwd="/Users/test/goose artifacts"
      >
        <LinkProbe href="my%20image.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/test/goose artifacts/my image.png",
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<h1>hello</h1>",
    "vbscript:msgbox(1)",
    "https://example.com/report.md",
    "mailto:hello@example.com",
    "#anchor",
  ])("does not resolve blocked markdown href %s", (href) => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href={href} />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-has-candidate")).toHaveTextContent("false");
    expect(screen.getByTestId("link-path")).toHaveTextContent("");
  });

  it("marks a path inside the session cwd as within cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="output/report.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("true");
  });

  it("marks an absolute path outside the session cwd as not within cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="/Users/test/secrets/private.png" />
      </ArtifactPolicyProvider>,
    );

    // The path still resolves (click-to-open relies on it), but cwd-scoped
    // consumers like inline markdown images must see it as outside the cwd.
    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/test/secrets/private.png",
    );
    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("false");
  });

  it("marks a ..-escaping relative path as not within cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="../../secrets/private.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/secrets/private.png",
    );
    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("false");
  });

  it("does not treat a sibling directory with a shared prefix as within cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="/Users/test/app-secrets/private.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("false");
  });

  it("reports not within cwd when there is no session cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd={null}>
        <LinkProbe href="output/report.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("false");
  });

  it("resolves file markdown hrefs as local paths", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="file:///tmp/report.md" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-has-candidate")).toHaveTextContent("true");
    expect(screen.getByTestId("link-path")).toHaveTextContent("/tmp/report.md");
  });
});
