# Selector - Visual Element Picker

Visually select any DOM element and copy a structured prompt for an AI coding assistant.

> Forked from [oil-oil/selector](https://github.com/oil-oil/selector). Added browser extension support.

A browser extension that lets you point and click any element on any webpage, add instructions, and copy a structured AI prompt.

## Install

1. Install from the Chrome Web Store
2. Done — a launcher button appears on every page

Works in Chromium-based browsers that support Chrome extensions.

## Usage

Click the **●** launcher button in the bottom-left corner of any page to open Selector. Click it again (or press ✕) to close.

| Action | What it does |
|---|---|
| **Click** | Select an element |
| **Shift + Click** | Add to selection |
| **Drag** | Marquee select multiple elements |
| **↑ / ↓** | Navigate to parent / child element |
| **← / →** | Navigate to previous / next sibling |
| **✎ button** | Add per-element instruction |
| **⌘C** | Copy prompt to clipboard |
| **Include screenshot of active selection** | Optional, off by default; add a screenshot to the next Copy Prompt |
| **⌘Z** | Undo last selection change |
| **Space** | Pause / resume selecting |
| **Esc** | Clear selection |

The copied prompt includes element metadata (tag, selector, text, React component info) plus any per-element instructions you added.

### Copy the prompt with a screenshot

Select an element, check **Include screenshot of active selection**, then activate **Copy Prompt** and choose **This Tab** in Chrome's sharing dialog. The prompt still describes all selected elements, but the screenshot covers only the active element's visible region. Selector writes one clipboard item with plain text and PNG representations; the paste destination decides which formats it accepts. It does not download a file or upload the image.

The checkbox starts unchecked and clears after a successful screenshot copy. Cmd/Ctrl+C remains a text-only shortcut. Cancelled or unsupported capture does not fall back to another clipboard write; uncheck the option to copy just the prompt. Chrome Region Capture may include content already painted over the selected area, including content in nested documents or shadow trees. Screenshot copy is unavailable for directly selected frames and areas overlapping visible cross-origin frames in the top-level document's light DOM. Capture failures never fall back to copying the full tab.

The selected-area workflow is inspired by [oil-oil/selector](https://github.com/oil-oil/selector/tree/0eb020b5a7266ea58a79126bf067f27d86950587), whose README states that it is MIT-licensed. The implementation here does not copy its screenshot code or require any remote dependencies.

## Example output

```
Page: /dashboard

1. .hero-title <h1>
   selector: body > main > section > h1
   source: src/components/Hero.tsx:12
   react: Layout › Hero
   text: "Welcome to the Dashboard"
   html: <h1 class="hero-title">Welcome to the Dashboard</h1>
   instruction: Make this red and larger

2. .sidebar <nav>
   selector: body > aside > nav
   text: "Home Settings Profile Logout"
   html: <nav class="sidebar">…
   instruction: Add an "Analytics" link after "Settings"
```

## How it works

The extension declares `assets/editor.css` + `assets/editor.js` as content scripts injected into all pages. A small launcher button (bottom-left) appears on every page; clicking it activates the full picker UI. Everything runs client-side — no data is sent anywhere.

## Development

```bash
git clone https://github.com/oil-oil/selector.git
cd selector
# Edit assets/editor.js and assets/editor.css
# Load unpacked extension: chrome://extensions → Developer Mode → Load unpacked → repo root
# Push to main — GitHub Pages auto-deploys the install page
```

### UI color guidelines

Use Selector's namespaced color properties in `assets/editor.css` for new controls in the selection panel. Set text colors explicitly so they stay readable on the panel's white background in both light and dark host pages.

| Role | Color | Use |
|---|---|---|
| Selecting | `--ai-editor-color-selecting` (`#4ade80`) | The Selecting indicator and enabled checked controls |
| Panel text | `--ai-editor-color-panel-text` (`#333`) | Element tags and control labels |
| Secondary text | `--ai-editor-color-panel-secondary` (`#666`) | Instructions and status messages |
| Paused | `#888` | The paused indicator, with the Paused label |
| Disabled action | `#aaa` on `#e0e0e0` | Disabled Copy Prompt button |
| Copy success | `#16a34a` | Copy Prompt success background, with the Copied label |

Keep normal-size labels and explanations on the white panel at a contrast ratio of at least 4.5:1. Use text for success, cancellation, and error feedback so color alone does not carry the result. Retain native focus and disabled styles for form controls.

## License

MIT
