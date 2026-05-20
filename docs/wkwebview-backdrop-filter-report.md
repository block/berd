# WKWebView `backdrop-filter` Blur Investigation

Date: 2026-05-19

## Summary

The composer blur issue is real, but it does not appear to be documented by
Apple or WebKit as a small, named `backdrop-filter` radius cap. Public WebKit
material documents `backdrop-filter` as a dynamic, hardware-accelerated effect
and explicitly warns that it requires extra rendering passes, but it does not
publish a low maximum blur radius. Current WebKit source does contain a generic
Gaussian blur kernel clamp, but that clamp is far above the radius where the
Goose composer stops changing visually. That means the app behavior is most
likely coming from the WKWebView/WebKit compositor path used for backdrop
sampling, not from the CSS parser accepting the wrong value.

Recommended path: do not build the production composer around blur radii above
the visually reliable WebKit range. Keep a modest literal
`-webkit-backdrop-filter` blur, increase the surface tint/opacity enough to
protect readability, and add a purpose-built non-shadow occlusion layer behind
the composer when chat content can pass underneath it. This gives the intended
frosted-glass feel while avoiding a duplicated virtualized timeline, experimental
browser APIs, or a webview-engine swap.

## Verified Findings

### WebKit supports backdrop filters, but warns about render cost

WebKit introduced `backdrop-filter` for iOS/macOS-style frosted surfaces. The
implementation samples content behind the styled element, applies the filter,
then composites the result back into the page. WebKit also notes that the effect
requires extra rendering passes and should be used only where necessary.

Source: [WebKit, Introducing Backdrop Filters](https://webkit.org/blog/3632/introducing-backdrop-filters/)

The original WebKit post also says Safari/WebKit required the prefixed property
at the time: `-webkit-backdrop-filter`. In modern CSS, keeping both declarations
is still the safest cross-engine authoring pattern, with the prefixed declaration
needed for Safari/WKWebView cases.

### There is no public Apple/WebKit doc for a small blur ceiling

I did not find an Apple, WebKit, or Tauri document that says WKWebView clamps
`backdrop-filter: blur(...)` to a specific low radius such as `20px`. The
closest hard implementation limit I found is in current WebKit source:
`FEGaussianBlur.cpp` limits Gaussian kernel size to `500`, with a comment saying
larger radii do not materially improve the result and inflate paint rects.

Source: [WebKit `FEGaussianBlur.cpp`](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/graphics/filters/FEGaussianBlur.cpp)

That source-level clamp corresponds to roughly `266px` of CSS `blur()` standard
deviation before the kernel reaches `500`:

```text
gaussianKernelFactor = 3 / 4 * sqrt(2 * pi) ~= 1.88
500 / 1.88 ~= 266
```

This does not explain the Goose observation that `20px`, `60px`, and `120px`
look identical. The important conclusion is narrower: WebKit has performance
motivated blur limits, but the low effective plateau in the Tauri app is not
documented as the generic CSS Gaussian blur limit.

### The Goose manual test shows an effective WKWebView plateau

The manual devtools test in the brief is still the best app-specific evidence:

```js
document.documentElement.style.setProperty(
  "--backdrop-composer-glass",
  "blur(20px) saturate(180%) brightness(1.05)",
);
document.documentElement.style.setProperty(
  "--backdrop-composer-glass",
  "blur(60px) saturate(180%) brightness(1.05)",
);
document.documentElement.style.setProperty(
  "--backdrop-composer-glass",
  "blur(120px) saturate(180%) brightness(1.05)",
);
```

All three rendered identically while `getComputedStyle` returned the declared
value. That establishes a practical ceiling at or below `20px` in the tested
Tauri/WKWebView paint path. It does not establish the exact lower threshold; a
follow-up visual run should compare `0`, `4`, `8`, `12`, `16`, `20`, and `24`
inside the actual Tauri window, using screenshots rather than
`WKWebView.takeSnapshot`.

Local environment note: this machine reports macOS `26.4.1` and WebKit
`21624.1.16.11.4`.

### CSS variables have a recent Safari/WebKit backdrop-filter regression

The brief's current CSS stores the whole filter in a variable:

```css
--backdrop-composer-glass: blur(24px) saturate(180%) brightness(1.05);
```

WebKit bug 297620 reports a Safari 18.x/macOS Sonoma regression where
`backdrop-filter` fails when the value references `var(...)`. The report says
later macOS versions work, and a later comment says Safari 26.1 on macOS 26 no
longer reproduces, while Safari 26.1 on macOS 14.8.2 still does.

Source: [WebKit bug 297620](https://bugs.webkit.org/show_bug.cgi?id=297620)

This is not the same as the blur-radius plateau, because the Goose test showed
the property applying. It is still a production risk if Goose supports Sonoma
users with newer Safari/WebKit updates. Prefer a literal class/value for the
composer's `-webkit-backdrop-filter`, or feature-test this specific case.

### `backdrop-filter` creates backdrop roots, so stacking is not a clean multiplier

MDN documents that `backdrop-filter` applies up to the nearest backdrop root,
and that an element with `backdrop-filter` itself becomes a backdrop root. Nested
backdrop-filter elements therefore do not reliably keep re-blurring the original
page behind the parent. They can blur only the content between backdrop roots.

Source: [MDN `backdrop-filter`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter)

Sibling/layer stacking may produce some extra apparent softness in some engines,
but it is not a production-grade way to multiply blur in WKWebView: it increases
render passes, risks seams, and is sensitive to stacking context changes.

### SVG filter syntax is valid, but it is not a magic backdrop escape hatch

The formal `backdrop-filter` syntax allows a `<url>` filter as part of the filter
value list. That means `backdrop-filter: url(#heavy-blur)` is syntactically part
of the platform.

Source: [MDN `backdrop-filter` values/syntax](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter)

For this case, an SVG `feGaussianBlur` referenced from `backdrop-filter` still
uses the browser's backdrop-filter pipeline. It should not be assumed to bypass
WKWebView compositor constraints. SVG filters are more useful if applied with
regular `filter: url(#...)` to an explicitly duplicated layer, but that becomes a
pre-blurred-content implementation, not true backdrop sampling.

### Houdini/custom paint is not viable for this production WKWebView feature

The CSS Painting API is still marked by MDN as experimental and not Baseline
because it does not work in some widely used browsers.

Source: [MDN CSS Painting API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Painting_API)

Even if available, custom paint generates images for backgrounds/borders; it
does not get direct access to live pixels behind an element. It cannot implement
a true live backdrop blur for chat content.

### Tauri 2 on macOS uses system WKWebView

Tauri documents that macOS uses WebKit through `WKWebView`, and that this webview
comes preinstalled with macOS and is updated through OS updates. Tauri does not
bundle a Chromium-like engine on macOS by default.

Source: [Tauri Webview Versions](https://v2.tauri.app/reference/webview-versions/)

Tauri has an experimental Verso integration. Verso is a browser based on Servo,
and Tauri describes the integration as experimental with future work still
needed.

Source: [Tauri Experimental Verso Integration](https://tauri.app/blog/tauri-verso-integration/)

For Goose, swapping the runtime would be an architectural decision with bundle,
feature parity, signing, QA, and platform behavior implications. It should be
treated as a last resort, not as a composer styling fix.

## Alternatives Evaluated

### 1. Modest native backdrop blur plus stronger tint

This is the lowest-risk path. Use a blur value in the range WKWebView visibly
honors, keep saturation/brightness if they help the visual system, and make the
surface less transparent so text behind the composer is not readable. Elevation
can come from tint, border, ring, and outline; no drop shadow is required.

Pros: simple, accessible, cheap, works with virtualization, no duplicated DOM,
no custom renderer. Cons: less physically glassy than a true `60px` blur.

### 2. Composer occlusion/scrim layer behind the pill

Add a decorative layer behind the composer, above the timeline, that softly
reduces contrast in the composer footprint. It can be a translucent band or
radial/linear tint clipped to the same shape as the composer. It does not need
to blur; its job is to make text behind the composer unreadable.

Pros: deterministic, cheap, respects no-shadows rule, works over virtualized
messages. Cons: it is an art-directed approximation rather than a true backdrop
sample.

### 3. Duplicated/pre-blurred timeline layer

Render a second copy of the chat content behind the composer and apply regular
`filter: blur(40px)` to that duplicate. Regular `filter` can produce heavier
blur than the observed backdrop path.

This is not recommended for the first implementation. The chat timeline is
virtualized, so a duplicate needs exact scroll synchronization, matching item
measurement, clipping, and transform handling. It can double expensive message
rendering, complicate streaming updates, and create accessibility hazards unless
the duplicate subtree is hidden from assistive tech and inert. It also risks
disagreeing with the real timeline whenever virtualization changes what is
mounted.

### 4. SVG `feGaussianBlur`

As a `backdrop-filter` URL, this likely remains bounded by the same backdrop
pipeline. As a regular `filter` on duplicated content, it works but inherits the
same complexity as the duplicated timeline approach.

Not recommended as the primary path.

### 5. Stacked backdrop-filter layers

Nested layers are blocked by backdrop-root semantics; sibling layers are
implementation-sensitive and expensive. This is worth a quick experiment only if
the team wants a CSS-only prototype, but it should not be the production plan.

### 6. Tauri/engine escape hatch

Verso/Servo is worth tracking, but the Tauri integration is experimental and
does not remove the need to QA every frontend surface against a different engine.
Do not swap webviews for this issue.

## Recommended Path

Implement a production glass approximation: keep native WebKit backdrop blur at a
literal, dependable value around `16px` to `20px`; increase composer surface
opacity/tint until text behind it fails a readability check; add a clipped
non-shadow occlusion layer behind the composer when the timeline can overlap it;
and avoid `var(...)` inside `-webkit-backdrop-filter` for the shipped composer
rule until the supported macOS/Safari matrix is known. This preserves the design
language without depending on undocumented compositor behavior.

## Implementation Sketch

Move the filter value to a small dedicated composer shell so the filter element
itself is not transformed. If the visual placement currently depends on
`translate-y-1/2`, use layout spacing or wrapper positioning instead of a
transform on the backdrop-filter layer.

```tsx
const composerBackdropFilter = "blur(18px) saturate(180%) brightness(1.04)";

<div className="pointer-events-none absolute inset-x-0 bottom-20 flex justify-center px-4">
  <div
    aria-hidden="true"
    className="absolute inset-x-4 bottom-0 mx-auto h-36 max-w-3xl rounded-composer bg-background/70"
  />
  <div
    className={cn(
      "pointer-events-auto relative w-full max-w-3xl rounded-composer",
      "bg-background/82 ring-1 ring-inset ring-white/60 outline outline-1 outline-black/5",
    )}
    style={{
      WebkitBackdropFilter: composerBackdropFilter,
      backdropFilter: composerBackdropFilter,
    }}
  >
    <ChatInput {...props} />
  </div>
</div>
```

Notes for the real patch:

- Tune the tint using actual chat content behind the composer, not a blank
  background. The acceptance criterion should be "body text/code behind the
  composer is not readable at normal zoom."
- Keep the occlusion layer `aria-hidden`, with no focusable descendants.
- Prefer ring/outline/color for depth. Do not add shadows.
- Keep both prefixed and unprefixed declarations, but put the literal value in
  both declarations rather than relying on a CSS variable for the WebKit path.
- If the composer overlaps only in the MCP-app case, render the occlusion layer
  only for the same overlap condition.

## Follow-up Measurement Plan

To find the exact practical ceiling, measure inside the real Tauri window rather
than `WKWebView.takeSnapshot`; my offscreen snapshot probe returned identical
measurements for every radius, including `0px`, so it is not a valid rendering
oracle for this effect.

1. Add a temporary debug control or devtools snippet that sets literal inline
   filter values: `0`, `4`, `8`, `12`, `16`, `20`, `24`, `32`.
2. Capture compositor screenshots of the live app window at each value.
3. Compare a fixed region inside the composer for high-frequency contrast or run
   a side-by-side visual review.
4. Record the first value where screenshots stop changing materially. Treat that
   as the maximum dependable WebKit blur radius for this app and OS/WebKit
   combination.
