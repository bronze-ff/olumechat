---
version: 1.0
name: Olume Chat Product System
description: A precise multi-tenant operations workspace with deep-forest navigation, near-white work surfaces, operational-green actions, visible hairline borders, and signature mint reserved for the Olume identity. The interface favors familiar product patterns, compact data, clear task hierarchy, and explanatory empty states.
colors:
  ink: "#071A15"
  ink-strong: "#0B100E"
  ink-muted: "#4D625C"
  neutral-soft: "#778F87"
  canvas: "#F3F8F6"
  surface: "#FFFFFF"
  surface-subtle: "#E9EFEA"
  border: "#D3E0DB"
  border-strong: "#BFD0CA"
  primary: "#1F7A60"
  primary-hover: "#17664F"
  primary-soft: "#EAFBF5"
  signal: "#5BD6AE"
  success: "#16856A"
  success-on-dark: "#69DAB1"
  warning: "#B76A11"
  danger: "#C83C4A"
  danger-on-dark: "#FFB4A9"
  info: "#1674A8"
typography:
  family: "Segoe UI Variable, Segoe UI, ui-sans-serif, system-ui, sans-serif"
  mono: "Cascadia Code, SFMono-Regular, Consolas, ui-monospace, monospace"
rounded:
  micro: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  panel: "10px"
  lg: "12px"
  xl: "16px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
---

# Olume Chat Design System

## Visual Theme & Atmosphere

Olume Chat is a calm operations console used for long work sessions. Its hierarchy comes from clearly divided surfaces: deep forest anchors persistent navigation while white work areas sit on a cool near-white canvas, separated by precise 1px borders. Color is restrained: operational green identifies action and selection; signature mint carries the Olume mark and rare brand moments; semantic colors communicate real state.

The product should feel complete before it feels expressive. Familiar controls, accurate alignment, concise labels, and useful status language are the main aesthetic. Decoration never competes with the user's queue, customer, or configuration.

## Color Palette & Roles

- `ink-strong` and `ink` form the navigation and primary text hierarchy.
- `canvas` is the app background. It is a cool near-neutral, never cream or beige.
- `surface` holds task areas, tables, forms, and conversation panels.
- `surface-subtle` distinguishes toolbars, selected rows, and secondary regions.
- `primary` is reserved for primary actions, current navigation, focus, and links. Its soft tint may identify the current section without filling large areas.
- `signal` appears in the Olume mark and rare brand moments, not destructive actions.
- `success`, `warning`, `danger`, and `info` always accompany text or icon labels.
- `success-on-dark` is the text and icon variant for deep-forest surfaces. The standard
  `success` reaches only 3.94:1 over `ink`; this variant reaches 10.50:1.
- `danger-on-dark` is the text and icon variant for deep-forest surfaces. The standard
  `danger` reaches only 3.59:1 over `ink`, while this variant reaches 10.58:1 and keeps
  error feedback at WCAG AA contrast.
- `border` is the default divider. Elevation depends on surface contrast and borders, not large shadows.

All text and controls must meet WCAG 2.2 AA contrast against their actual background.

## Theme System

Every surface exposes the same appearance control. The preference is stored locally and applies immediately across the landing page, conversations, administration, and the internal operator console.

- `Claro` is the default Olume Chat composition, with cool near-white surfaces and dark operational text.
- `Escuro` uses deep forest and graphite surfaces, light text, visible borders, and operational-green actions.
- Preferences from older versions are normalized on load. `Sistema` is resolved once to Claro or Escuro; Drácula and Nord migrate to Escuro.

Themes change semantic tokens, not component markup. Surface, canvas, text, border, primary, signal, and status roles must remain consistent. Primary button text, body text, helper text, and status messaging must continue to meet WCAG 2.2 AA in every theme.

## Typography Rules

Use the native variable system sans throughout product chrome, headings, labels, buttons, body text, and data. Cascadia Code or the platform monospace is reserved for identifiers, tokens, phone numbers, timestamps, and audit details. No external font request is required for the interface to render.

| Role | Size | Weight | Line height | Use |
|---|---:|---:|---:|---|
| Page title | 20px | 650 | 1.3 | Main task context |
| Section title | 16px | 650 | 1.35 | Panels and groups |
| Body | 14px | 400 | 1.5 | Default UI copy |
| Supporting | 13px | 400 | 1.45 | Explanations and metadata |
| Label | 12px | 600 | 1.35 | Form labels and compact controls |
| Data | 13px | 500 | 1.4 | IDs, timestamps, counts |

Use sentence case. Avoid tracked uppercase except for very short immutable technical codes. Headings balance naturally and explanatory prose stays under 72 characters per line.

## Component Styling

### Navigation

Desktop administration uses a 264px white sidebar with a persistent right divider, workspace switcher, direct access to conversations, and workflow groups: operation, automation, people, and system. The active item uses a primary-soft surface, a subtle border, and primary text. A compact breadcrumb bar establishes location, while a contextual tab strip exposes sibling tasks without duplicating every route. Mobile replaces the sidebar with a compact light header and horizontally scrollable route tabs.

### Buttons

Buttons use an 8px radius and a minimum 40px height. Primary buttons use operational green with white text. Secondary buttons use a white surface and a strong border. Tertiary actions are plain and gain a subtle surface on hover. Destructive actions use danger only when the consequence is destructive.

Every button has hover, focus-visible, active, disabled, and loading states. Icon-only actions are at least 40×40px with accessible names.

### Forms

Inputs use white or subtle surfaces, a visible 1px border, 6px radius, 40px minimum height on desktop, and readable placeholder text. Touch layouts keep 44px targets. Focus uses a primary border and a translucent focus ring. Helper text explains consequence or required format; validation messages state how to recover.

### Panels and Tables

Panels use a 10px radius, a white surface, and a visible neutral hairline. A minimal 1px/2px shadow may reinforce separation, but the border does most of the work. Panels in the same task align to a shared grid; content must not float unanchored on the canvas. Tables use 44–48px rows, neutral header surfaces, clear column alignment, and responsive overflow.

### Status and Empty States

Status chips use compact rounded rectangles, never color alone. Empty states contain a concise explanation, what causes data to appear, and a relevant action when one exists. Loading uses structural skeletons for content regions; small inline mutations may use a spinner.

## Layout Principles

- Base spacing unit: 4px; primary rhythm: 8, 12, 16, 24, 32, 48px.
- Desktop admin: persistent sidebar plus a fluid content column capped at 1600px.
- Operational inbox: stable top bar, 384px conversation list, flexible thread panel.
- Operator console: sidebar, summary strip, client directory, guided provisioning area.
- Main page padding: 24–32px desktop, 16px tablet, 12–16px mobile.
- Use flexbox for toolbars and grids for genuinely two-dimensional summaries.
- Dense data is allowed; explanatory content remains airy enough to scan.

## Depth & Elevation

Use three levels:

1. Canvas: cool neutral app background.
2. Surface: white work areas separated by clearly visible hairlines.
3. Overlay: dialogs and menus with a compact `0 8px 24px rgba(14,21,37,.14)` shadow and backdrop.

Avoid shadows on standard cards. Sticky headers may use a 1px divider and a very small shadow only when scrolling makes separation necessary.

## Do's and Don'ts

### Do

- Keep the user's current task and system state visible.
- Use real product data and clear explanations as the visual payload.
- Keep action placement predictable across pages.
- Use sentence-case Portuguese labels and plain operational language.
- Make operator onboarding a visible sequence with recovery guidance.

### Don't

- Do not use colored side stripes on cards or alerts.
- Do not use gradients, glass, decorative blobs, or background patterns in product chrome.
- Do not use display fonts, oversized numbers, or marketing-style hero blocks.
- Do not repeat identical icon-heading-copy cards when a list, table, or grouped panel is clearer.
- Do not use pills for standard buttons or every status.
- Do not hide critical actions inside unlabeled icon menus.

## Responsive Behavior

- At 1024px, the administration sidebar collapses into light mobile navigation.
- At 768px, multi-column forms and summary rows stack; tables scroll horizontally rather than compressing text.
- The inbox shows either the conversation list or thread on small screens and preserves a clear back action.
- Dialogs become bottom sheets only when their workflow remains complete and keyboard-accessible.
- Touch targets are at least 44px where controls are primarily used on touch.
- Text sizes remain fixed; structure, not typography, responds to viewport width.

## Motion & Interaction

Transitions run 150–220ms with ease-out curves and communicate hover, selection, overlay entry, or completion. No staged page-load animation. Under `prefers-reduced-motion: reduce`, transforms and non-essential transitions are removed.

## Public Marketing Surface

The public root route is a brand and acquisition surface, not an authenticated product screen. It keeps the same forest ink, operational green, signature mint, borders, theme tokens, system typography, and 6–14px geometry, while allowing a more editorial scale and more open spacing.

- Lead with the operational pain, then show how the product changes the routine.
- Use documentary, people-centered photography. Never fabricate a product screenshot or place illegible generated UI inside a device frame.
- Keep the hero inside the first viewport on a typical laptop. The primary statement stays within two lines on desktop and the first actions remain visible without scrolling.
- Prefer asymmetric compositions, border-led feature regions, and real process sequences over rows of identical feature cards.
- Do not use gradients, decorative glows, fake customer logos, invented statistics, or unsupported claims.
- A brief hero entrance may establish hierarchy on the public route. It must respect `prefers-reduced-motion`.
- The demonstration form states that it opens the visitor's e-mail client and obtains its destination from `VITE_COMERCIAL_EMAIL`.
- The public route supports the same Claro and Escuro preferences as every authenticated surface.

## Illustrative UI Mocks vs. Social Proof

Authenticated screens may include illustrative interface previews built from invented
names, counts, or sample conversations — for example, the Login page's product preview
panel, which shows "Ana Martins" and a queue count inside a clearly framed device
mockup. This is legitimate: it depicts what the product looks like to someone who
already has an account, visibly inside a UI frame, never presented as a fact about the
company or its customers.

The line that must never be crossed, on any screen, public or authenticated:

- Never an aggregate number presented as a fact about the company (a real-looking
  dashboard total or count outside a clearly labeled preview).
- Never a testimonial or quote attributed to a customer.
- Never a name presented as a real customer, case study, or logo.

A mock stays on the legitimate side only while it is unmistakably an illustration of
the interface itself. The moment a number, name, or quote could be read as a claim
about the product or its customers, it falls under the rule established during the
landing cleanup (PR #49): **nothing presented as fact about the product or its
customers may be invented.** That rule applies to the whole app, not just the public
route.

## Agent Prompt Guide

When extending Olume Chat, begin with the existing workflow and semantic state. Use the divided shell, near-white canvas, white surfaces, operational-green actions, restrained mint signal, Inter typography, 6–10px radii, and border-led depth. Prefer a familiar product pattern over a novel control. Every new component must define keyboard focus, loading, empty, error, and responsive behavior.
