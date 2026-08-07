import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDesignSystemManifest } from "./design-system-manifest.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const coveredComponents = [
  "Button",
  "Button Group",
  "Top Bar Icon Button",
  "Composer Action Button",
  "Agent Tile Button",
  "Page Header Button",
  "Glass Button",
  "Jump To Latest Button",
  "Badge",
  "Alert",
  "Tabs",
  "Toggle Group",
  "Select",
  "Dropdown Menu",
];

const paletteUtilityPattern =
  /\b(?:bg|border|text|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d{1,3})?\b/g;

const rawColorPattern =
  /(?<![A-Za-z0-9_-])(?:#[0-9A-Fa-f]{3,8}|rgba?\(|hsla?\()/g;

function getLineNumber(sourceText, index) {
  return sourceText.slice(0, index).split("\n").length;
}

function findMatches({ sourceText, pattern, source, label }) {
  return Array.from(sourceText.matchAll(pattern)).map((match) => ({
    source,
    line: getLineNumber(sourceText, match.index ?? 0),
    label,
    value: match[0],
  }));
}

function runAudit() {
  const manifest = buildDesignSystemManifest();
  const findings = [];
  for (const componentName of coveredComponents) {
    const item = manifest.find((component) => component.name === componentName);
    if (!item) {
      findings.push({
        source: "design-system manifest",
        line: 1,
        label: "missing covered component",
        value: componentName,
      });
      continue;
    }

    const sourcePath = path.join(repoRoot, item.source);
    const sourceText = fs.readFileSync(sourcePath, "utf8");

    findings.push(
      ...findMatches({
        sourceText,
        pattern: paletteUtilityPattern,
        source: item.source,
        label: "tailwind palette utility",
      }),
      ...findMatches({
        sourceText,
        pattern: rawColorPattern,
        source: item.source,
        label: "raw color value",
      }),
    );
  }

  findings.push(...findButtonStylingFindings());

  if (findings.length > 0) {
    console.error("Design system audit failed:");
    for (const finding of findings) {
      console.error(
        `  - ${finding.source}:${finding.line} [${finding.label}] ${finding.value}`,
      );
    }
    process.exit(1);
  }

  console.log("Design system audit passed.");
}

// ---------------------------------------------------------------------------
// Button styling rule: feature code never styles a Button.
//
// Color and interactive-state classes on <Button> belong in the design
// system — a variant, a flag, or a named chrome wrapper in src/shared/ui.
// Layout-only classes (flex, sizing, margins, justify, truncation) are fine.
//
// Existing violations are ratcheted via the baseline below: the audit fails
// on NEW violations and on stale baseline entries (so the list only shrinks).
// Fix a violation by moving the styling into a variant/wrapper, then remove
// its entry here.
// ---------------------------------------------------------------------------

// Allowed despite looking style-ish:
// - `opacity-0` + group-hover reveal: visibility choreography, not restyling
// - `ring-N ring-ring`: the system focus ring used as an explicit state
const buttonStylingPattern =
  /(?:^|[\s"'`(])(?:bg-(?!transparent\b)[a-z[]|text-(?:foreground|muted|primary|secondary|destructive|accent|current|white|black|surface|app|sidebar)|border-(?:input|border|destructive|primary|accent|current|surface)|hover:(?!opacity-100\b)|active:(?:bg|text|border|opacity)|focus-visible:(?:bg|text|border)|data-\[state=open\]:(?:bg|text)|aria-expanded:(?:bg|text)|shadow-(?!none)|opacity-(?!0\b|100\b)\d|backdrop-|ring-(?!offset|ring\b|\d))/;

const buttonStylingBaseline = new Set([
  "src/features/agents/ui/AgentDetailPage.tsx",
  "src/features/agents/ui/PersonaGallery.tsx",
  "src/features/chat/ui/ChatInputToolbar.tsx",
  "src/features/chat/ui/MessageBubbleActions.tsx",
  "src/features/chat/ui/PersonaPicker.tsx",
  "src/features/chat/ui/widgets/WorkspaceActionsMenu.tsx",
  "src/features/design-system/ui/ConversationAnatomyPage.tsx",
  "src/features/extensions/ui/ExtensionModal.tsx",
  "src/features/home/widgets/ChecklistWidget.tsx",
  "src/features/home/widgets/StickyNoteWidget.tsx",
  "src/features/projects/ui/CreateProjectDialog.tsx",
  "src/features/projects/ui/ProjectsView.tsx",
  "src/features/sessions/ui/SessionCard.tsx",
  "src/features/sessions/ui/session-list/SidebarFlatChatsSection.tsx",
  "src/features/sessions/ui/session-list/SidebarProjectList.tsx",
  "src/features/sessions/ui/session-list/SidebarRecentsSection.tsx",
  "src/features/settings/ui/ProvidersSettings.tsx",
  "src/features/skills/ui/SkillCard.tsx",
  "src/features/skills/ui/SkillEditor.tsx",
]);

function findButtonStylingFindings() {
  const findings = [];
  const seenFiles = new Set();
  const roots = ["src/features", "src/app"];
  const files = [];
  for (const root of roots) {
    const stack = [path.join(repoRoot, root)];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (
          entry.name.endsWith(".tsx") &&
          !entry.name.endsWith(".test.tsx")
        ) {
          files.push(full);
        }
      }
    }
  }

  for (const file of files) {
    const sourceText = fs.readFileSync(file, "utf8");
    const relative = path.relative(repoRoot, file);
    for (const match of sourceText.matchAll(/<Button\b/g)) {
      // Walk to the real end of the opening tag: a `>` at brace depth 0.
      // A plain indexOf(">") stops early inside JSX-expression props like
      // onClick={() => ...} and misses a later className.
      let tagEnd = -1;
      let braceDepth = 0;
      for (let i = match.index; i < sourceText.length; i += 1) {
        const ch = sourceText[i];
        if (ch === "{") braceDepth += 1;
        else if (ch === "}") braceDepth -= 1;
        else if (ch === ">" && braceDepth === 0) {
          tagEnd = i;
          break;
        }
      }
      if (tagEnd === -1) continue;
      const tag = sourceText.slice(match.index, tagEnd + 1);
      const classMatch = tag.match(
        /className=(?:"([^"]*)"|\{((?:[^{}]|\{[^{}]*\})*)\})/,
      );
      if (!classMatch) continue;
      const content = classMatch[1] ?? classMatch[2] ?? "";
      if (buttonStylingPattern.test(content)) {
        seenFiles.add(relative);
        if (!buttonStylingBaseline.has(relative)) {
          findings.push({
            source: relative,
            line: getLineNumber(sourceText, match.index ?? 0),
            label: "button styled in feature code",
            value:
              "move color/state styling into a Button variant, flag, or a named chrome wrapper in src/shared/ui",
          });
        }
      }
    }
  }

  for (const baselined of buttonStylingBaseline) {
    if (!seenFiles.has(baselined)) {
      findings.push({
        source: "scripts/design-system-audit.mjs",
        line: 1,
        label: "stale button styling baseline entry",
        value: `${baselined} no longer styles Button — remove it from buttonStylingBaseline`,
      });
    }
  }

  return findings;
}

runAudit();
