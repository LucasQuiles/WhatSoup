"""Wave-4 adversarial visual QA — shared explicit test battery.
Single source of truth for all reviewer families (grok / gpt / claude / local).
"""

CONTEXT = """CONTEXT: You are an adversarial UI auditor examining screenshots of "SOUP", an agent-fleet console, rendered at 1440x900 desktop. Each surface appears in dark and light theme — BOTH themes are first-class citizens. These are static mockups: hover/focus/motion states cannot be evaluated, do not flag their absence. Assume defects exist; you are paid per confirmed defect.

SANCTIONED — do NOT flag these (they are locked design law):
- Mode-channel colors: teal (passive), cyan (chat), violet (agent) — these are NOT the action accent
- Status colors green/amber/red always paired with a shape marker
- The brand wordmark's blue "U" (SOUP) and the marketing headline accent word
- Masked identifiers with prefix+suffix (privacy-by-design)
- One radial glow during the hatch ceremony moment; flat low-opacity geometric watermark shapes on splash
- Dual dark/light themes with per-theme accent adjustment

MEASUREMENT RULE: NEVER estimate absolute pixel values — you are unreliable at it. Only report size/spacing RELATIONSHIPS visible between sibling elements in the same image ("the caption under card A is visibly smaller than the caption under card B", "the gap between sections 1-2 is clearly larger than between 2-3").

EVIDENCE RULES: Every finding must cite: surface + theme + element + screen region (top/left/center/right/bottom). Tag confidence HIGH (clearly visible) / MED (likely). Put mere suspicions in the UNCERTAIN list, never in findings. NO praise. NO summaries of what works. NO redesign suggestions beyond fixing the defect."""

BATTERY = """TEST BATTERY — run EVERY test on EVERY image. For each test: PASS or findings.

A. ALIGNMENT
A1. Shared edges: elements in the same row (cards, panels, stat blocks) share exact top/bottom edges. Flag ragged rows.
A2. Column tracking: in repeated rows/lists, avatars, titles, metadata, and trailing controls form straight vertical columns. Flag drift.
A3. Icon centering: icons/glyphs optically centered inside their chips, dots, buttons. Flag off-center glyphs.
A4. Baseline: text sharing one visual line shares a baseline — no label floating above/below its neighbor.
A5. Page gutters: left/right page margins equal; stacked sections share the same outer left edge. Flag drift between sections.
A6. Centered layouts (splash, ceremony, empty states) actually sit on the optical center — flag offset.

B. CONSISTENCY
B1. Spacing rhythm: the same component (card, list row, chip, section gap) uses identical padding/gap every time it appears. Flag the outlier.
B2. Radii: same component family, same corner radius. Flag a card/chip/button whose radius differs from siblings.
B3. Type roles: same role (page title, section header, card title, body, caption, metadata) = same size/weight/color across the image. Flag role drift.
B4. Icon sizing: icons in the same context are the same size. Flag the odd one.
B5. Cross-theme parity: same surface in dark vs light has IDENTICAL layout/spacing/structure — only colors change. Flag any structural difference.
B6. Label casing/terminology: consistent capitalization and terms for the same actions across the image set.

C. UI/UX
C1. Affordance: every interactive element reads as interactive (border, fill, or control shape). Flag bare-text or ambiguous actions.
C2. Truncation: text cut mid-word without ellipsis; identifiers truncated beyond recognition; content clipped by its container.
C3. Target size: interactive controls visibly smaller than siblings or cramped to the point of looking untappable.
C4. State legibility: selected/unselected, enabled/disabled, read/unread, expanded/collapsed distinguishable at a glance. Flag ambiguous states.
C5. Wayfinding: page identity and primary action obvious within 2 seconds. Flag surfaces where the eye can't find the point.
C6. Unfinished/degenerate areas: placeholder-looking regions, orphaned elements, accidental blanks, debug-looking artifacts.

D. CLUTTER
D1. Density hotspots: lines/cards carrying too many simultaneous elements (badges + icons + buttons + metadata competing). Flag worst offenders.
D2. Redundant chrome: duplicated labels, repeated icons, dividers on dividers, double headers saying the same thing.
D3. Competing emphasis: too many elements shouting (bold/colored/large items fighting with no clear winner).
D4. Metadata overload: secondary info at the same visual weight as primary info.

E. SPACE
E1. Dead zones: large empty areas serving no purpose — cite region.
E2. Cramped vs wasted: content squeezed in one region while another region sits underused.
E3. Measure: text running the full width of a wide canvas, or content compressed into a narrow strip wasting the canvas.
E4. Balance: layout visually leaning left/right/top; footer/margin rhythm inconsistent with the page.
E5. Viewport fit: content awkwardly cut at the fold with a dangling partial element, or page not filling the viewport sensibly."""

OUTPUT_SPEC = """OUTPUT per image, in the order given:
## <surface>-<theme>
A: PASS | findings (A1..A6, each: location + element + one-line defect + severity high/med/low + confidence)
B: PASS | findings ...
C: PASS | findings ...
D: PASS | findings ...
E: PASS | findings ...
UNCERTAIN: suspicions you could not confirm (kept separate)

End the ENTIRE response with a verdict table, one line per image:
VERDICT <surface>-<theme>: PASS | FAIL(<finding count>)"""

GLOBAL_PROMPT = CONTEXT + """

You are given the SAME product's 9 surfaces, dark theme, in one batch. Your ONLY job is CROSS-SURFACE consistency — defects visible when comparing surfaces to each other:

G1. Page chrome: nameplate/header identical across surfaces (position, size, composition, theme-toggle control same place everywhere).
G2. Buttons: same action type rendered in the same style across surfaces. Flag style drift.
G3. Cards/panels: same corner radius, padding scale, border/hairline treatment across surfaces.
G4. Type ramp: page titles same size/weight on every surface; section headers same on every surface.
G5. Spacing rhythm: page outer padding and section gaps consistent across surfaces.
G6. Component vocabulary: status markers, badges, avatars, chips, pills rendered identically wherever they appear.
G7. Register consistency: operator surfaces share the same density register; journey surfaces (hatch, splash) share theirs — flag a surface that breaks its register.

""" + OUTPUT_SPEC.replace("per image, in the order given:\n## <surface>-<theme>\nA: PASS | findings (A1..A6, each: location + element + one-line defect + severity high/med/low + confidence)\nB: PASS | findings ...\nC: PASS | findings ...\nD: PASS | findings ...\nE: PASS | findings ...\nUNCERTAIN: suspicions you could not confirm (kept separate)", "list ONLY cross-surface findings, each tagged G1-G7 with the surfaces involved")


def surface_prompt(image_names):
    return CONTEXT + "\n\n" + BATTERY + "\n\n" + OUTPUT_SPEC + "\n\nImages in order: " + ", ".join(image_names)


def global_prompt(image_names):
    return GLOBAL_PROMPT + "\n\nImages in order: " + ", ".join(image_names)
