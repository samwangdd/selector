/**
 * Selector — visual element picker with per-element annotations.
 * Inject via bookmarklet. Click = select, Shift+click = multi, Drag = marquee.
 */
(function () {
  "use strict";

  const NS = "ai-editor";
  const AI_ID = "data-ai-id";

  let selectedElements = [];
  let activeElement = null;
  let chatPanel = null;
  let hoverBox = null;
  let aiIdCounter = 0;
  let rafPending = false;
  let lastMoveTarget = null;
  let paused = false;
  const selOverlays = new Map();
  const annotations = new Map();
  const listeners = [];
  let dragState = null;
  let wasJustDragging = false;
  let activePopover = null;
  const selectionHistory = [];
  let launcherEl = null;
  let active = false;

  // DOMParser-based helpers avoid innerHTML Trusted Types violations on strict-CSP pages (e.g. Gemini)
  function svgEl(str) {
    const tmp = new DOMParser().parseFromString(`<!DOCTYPE html><body>${str}`, 'text/html');
    return document.adoptNode(tmp.body.firstChild);
  }
  function setHTML(el, html) {
    const tmp = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}`, 'text/html');
    el.replaceChildren(...Array.from(document.adoptNode(tmp.body).childNodes));
  }

  // ── Storage bridge (MAIN ↔ ISOLATED via window.postMessage) ─────
  const STORAGE_NS = "__aiEditorStorage";
  const LAUNCHER_POS_KEY = "launcherPos";
  const LAUNCHER_SIZE = 40;
  const LAUNCHER_MARGIN = 8;

  function storageGet(key) {
    return new Promise((resolve) => {
      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const handler = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (d && d.__ns === STORAGE_NS && d.op === "getResult" && d.reqId === reqId) {
          window.removeEventListener("message", handler);
          resolve(d.value);
        }
      };
      window.addEventListener("message", handler);
      window.postMessage({ __ns: STORAGE_NS, op: "get", key, reqId }, "*");
    });
  }
  function storageSet(key, value) {
    window.postMessage({ __ns: STORAGE_NS, op: "set", key, value }, "*");
  }

  function clampLauncherPos(left, top) {
    const maxLeft = window.innerWidth - LAUNCHER_SIZE - LAUNCHER_MARGIN;
    const maxTop = window.innerHeight - LAUNCHER_SIZE - LAUNCHER_MARGIN;
    return {
      left: Math.max(LAUNCHER_MARGIN, Math.min(left, maxLeft)),
      top: Math.max(LAUNCHER_MARGIN, Math.min(top, maxTop)),
    };
  }
  function applyLauncherPos(pos) {
    if (!launcherEl || !pos) return;
    const { left, top } = clampLauncherPos(pos.left, pos.top);
    launcherEl.style.left = `${left}px`;
    launcherEl.style.top = `${top}px`;
    launcherEl.style.right = "auto";
    launcherEl.style.bottom = "auto";
  }

  function attachLauncherDrag(el) {
    const DRAG_THRESHOLD = 4;
    let startX = 0, startY = 0;
    let origLeft = 0, origTop = 0;
    let dragging = false;
    let moved = false;

    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      dragging = true;
      moved = false;
      e.preventDefault();
    });

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      el.classList.add(`${NS}-launcher-dragging`);
      applyLauncherPos({ left: origLeft + dx, top: origTop + dy });
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      if (!moved) return;
      el.classList.remove(`${NS}-launcher-dragging`);
      const { left, top } = clampLauncherPos(
        parseFloat(el.style.left),
        parseFloat(el.style.top)
      );
      storageSet(LAUNCHER_POS_KEY, { left, top });
      // Suppress the synthetic click that follows a drag-mouseup
      const blockClick = (e) => {
        e.stopImmediatePropagation();
        e.preventDefault();
        document.removeEventListener("click", blockClick, true);
      };
      document.addEventListener("click", blockClick, true);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

  function createLauncher() {
    if (document.querySelector(`.${NS}-launcher`)) return;
    launcherEl = document.createElement("button");
    launcherEl.className = `${NS}-root ${NS}-launcher`;
    launcherEl.title = "Selector (drag to reposition)";
    launcherEl.appendChild(svgEl('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="22"/><line x1="2" y1="12" x2="7" y2="12"/><line x1="17" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>'));
    launcherEl.addEventListener("click", toggleActive);
    attachLauncherDrag(launcherEl);
    document.body.appendChild(launcherEl);

    storageGet(LAUNCHER_POS_KEY).then((pos) => {
      if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
        applyLauncherPos(pos);
      }
    });

    window.addEventListener("resize", () => {
      if (!launcherEl || !launcherEl.style.left) return;
      applyLauncherPos({
        left: parseFloat(launcherEl.style.left),
        top: parseFloat(launcherEl.style.top),
      });
    });
  }

  function toggleActive() {
    if (active) {
      destroy();
    } else {
      activate();
    }
  }

  function on(target, type, fn, capture) {
    target.addEventListener(type, fn, capture);
    listeners.push({ target, type, fn, capture });
  }

  // ── Activate ───────────────────────────────────────────────
  function activate() {
    active = true;
    launcherEl.classList.add(`${NS}-launcher-active`);
    assignAiIds(document.body);
    createHoverBox();
    createChatPanel();

    on(document, "mousedown", handleMouseDown, true);
    on(document, "click", handleClick, true);
    on(document, "mousemove", handleMouseMove, true);
    on(document, "mouseup", handleMouseUp, true);
    on(document, "mouseleave", () => { showHover(null); cancelDrag(); }, true);
    on(document, "keydown", handleKeyDown, true);

    let repositionRaf = false;
    const scheduleReposition = () => {
      if (!repositionRaf) {
        repositionRaf = true;
        requestAnimationFrame(() => { positionAllOverlays(); repositionRaf = false; });
      }
    };
    on(window, "scroll", scheduleReposition, true);
    on(window, "resize", scheduleReposition, false);
  }

  // ── Destroy ────────────────────────────────────────────────
  function destroy() {
    active = false;
    for (const { target, type, fn, capture } of listeners) {
      target.removeEventListener(type, fn, capture);
    }
    listeners.length = 0;
    destroyAllOverlays();
    selectedElements = [];
    activeElement = null;
    annotations.clear();
    selectionHistory.length = 0;
    removeAnnotationPopover();
    cancelDrag();
    paused = false;
    wasJustDragging = false;
    if (hoverBox) { hoverBox.remove(); hoverBox = null; }
    if (chatPanel) { chatPanel.remove(); chatPanel = null; }
    if (launcherEl) launcherEl.classList.remove(`${NS}-launcher-active`);
  }

  // ── AI-ID ──────────────────────────────────────────────────
  function assignAiIds(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (isEditorElement(node)) continue;
      if (!node.hasAttribute(AI_ID)) node.setAttribute(AI_ID, `el-${aiIdCounter++}`);
    }
  }

  function isEditorElement(el) {
    return el && el.closest && !!el.closest(`.${NS}-root`);
  }

  function byAiId(id) {
    return document.querySelector(`[${AI_ID}="${id}"]`);
  }

  // ── Resolve target ─────────────────────────────────────────
  function resolveTarget(el) {
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (isEditorElement(cur)) { cur = cur.parentElement; continue; }
      if (!isVisible(cur)) { cur = cur.parentElement; continue; }
      if (isMeaningful(cur)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }

  function isMeaningful(el) {
    if (hasDirectText(el)) return true;
    if (el.querySelector("img,video,canvas,svg,button,a,input,select,textarea,iframe")) return true;
    if (el.children.length > 1) return true;
    return false;
  }

  function hasDirectText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) return true;
    }
    return false;
  }

  // ── Hover overlay ──────────────────────────────────────────
  function createHoverBox() {
    hoverBox = document.createElement("div");
    hoverBox.className = `${NS}-hover-box`;
    document.body.appendChild(hoverBox);
  }

  function showHover(el) {
    if (!el || isEditorElement(el) || selectedElements.includes(el)) {
      hoverBox.style.opacity = "0";
      return;
    }
    const r = el.getBoundingClientRect();
    hoverBox.style.top = (r.top - 1) + "px";
    hoverBox.style.left = (r.left - 1) + "px";
    hoverBox.style.width = (r.width + 2) + "px";
    hoverBox.style.height = (r.height + 2) + "px";
    hoverBox.style.opacity = "1";
  }

  // ── Mouse handling ─────────────────────────────────────────
  function handleMouseMove(e) {
    if (paused) return;

    if (dragState) {
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;

      if (!dragState.isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        dragState.isDragging = true;
        dragState.marquee = document.createElement("div");
        dragState.marquee.className = `${NS}-marquee`;
        document.body.appendChild(dragState.marquee);
        showHover(null);
      }

      if (dragState.isDragging) {
        const left = Math.min(e.clientX, dragState.startX);
        const top = Math.min(e.clientY, dragState.startY);
        dragState.marquee.style.left = left + "px";
        dragState.marquee.style.top = top + "px";
        dragState.marquee.style.width = Math.abs(dx) + "px";
        dragState.marquee.style.height = Math.abs(dy) + "px";
        return;
      }
    }

    lastMoveTarget = resolveTarget(e.target);
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => { showHover(lastMoveTarget); rafPending = false; });
    }
  }

  function handleMouseDown(e) {
    if (isEditorElement(e.target)) return;
    if (paused) return;
    if (e.button !== 0) return;
    if (e.shiftKey) e.preventDefault();

    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
      marquee: null,
    };
  }

  function handleMouseUp(e) {
    if (!dragState || !dragState.isDragging) {
      dragState = null;
      return;
    }

    wasJustDragging = true;

    const mRect = dragState.marquee.getBoundingClientRect();
    dragState.marquee.remove();
    dragState = null;

    pushHistory();
    if (!e.shiftKey) clearSelection();

    document.querySelectorAll(`[${AI_ID}]`).forEach((el) => {
      if (isEditorElement(el)) return;
      if (!isVisible(el)) return;
      if (!isMeaningful(el)) return;
      const r = el.getBoundingClientRect();
      if (rectsIntersect(mRect, r)) addSelection(el);
    });

    updateTags();
    setTimeout(() => { wasJustDragging = false; }, 0);
  }

  function cancelDrag() {
    if (dragState && dragState.marquee) dragState.marquee.remove();
    dragState = null;
  }

  function rectsIntersect(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function handleClick(e) {
    if (isEditorElement(e.target)) return;
    if (paused) return;
    if (wasJustDragging) return;

    e.preventDefault();
    e.stopPropagation();
    removeAnnotationPopover();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();

    pushHistory();
    const el = resolveTarget(e.target);
    if (e.shiftKey) {
      toggleElement(el);
    } else {
      clearSelection();
      addSelection(el);
    }
    updateTags();
  }

  // ── Selection overlays ─────────────────────────────────────
  function createSelOverlay(el) {
    const aiId = el.getAttribute(AI_ID);
    if (selOverlays.has(aiId)) return;

    const box = document.createElement("div");
    box.className = `${NS}-sel-box`;

    const corners = [0, 1, 2, 3].map((i) => {
      const c = document.createElement("div");
      c.className = `${NS}-sel-corner`;
      c.style.animationDelay = `${i * 28}ms`;
      document.body.appendChild(c);
      return c;
    });

    const label = document.createElement("div");
    label.className = `${NS}-sel-label`;
    label.textContent = elementLabel(el);

    const annotateBtn = document.createElement("button");
    annotateBtn.className = `${NS}-root ${NS}-annotate-btn`;
    annotateBtn.title = "Add instruction";
    annotateBtn.appendChild(svgEl('<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'));
    annotateBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      showAnnotationPopover(el, annotateBtn);
    };

    document.body.appendChild(box);
    document.body.appendChild(label);
    document.body.appendChild(annotateBtn);
    selOverlays.set(aiId, { box, corners, label, annotateBtn });
    positionSelOverlay(el);
  }

  function positionSelOverlay(el) {
    const aiId = el.getAttribute(AI_ID);
    const ov = selOverlays.get(aiId);
    if (!ov) return;
    const r = el.getBoundingClientRect();
    const pad = 2;

    ov.box.style.top = (r.top - pad) + "px";
    ov.box.style.left = (r.left - pad) + "px";
    ov.box.style.width = (r.width + pad * 2) + "px";
    ov.box.style.height = (r.height + pad * 2) + "px";

    const cs = 6;
    const pos = [
      { top: r.top - pad - cs / 2,    left: r.left - pad - cs / 2 },
      { top: r.top - pad - cs / 2,    left: r.right + pad - cs / 2 },
      { top: r.bottom + pad - cs / 2, left: r.left - pad - cs / 2 },
      { top: r.bottom + pad - cs / 2, left: r.right + pad - cs / 2 },
    ];
    for (let i = 0; i < 4; i++) {
      ov.corners[i].style.top = pos[i].top + "px";
      ov.corners[i].style.left = pos[i].left + "px";
    }

    ov.label.style.top = (r.top - pad - 20) + "px";
    ov.label.style.left = (r.left - pad) + "px";

    ov.annotateBtn.style.top = (r.top - pad - 22) + "px";
    const annotateSize = 20;
    const annotateGap = 4;
    const viewportPad = 4;
    const right = r.right + pad + annotateGap;
    const left = r.left - pad - annotateGap - annotateSize;
    if (right + annotateSize <= window.innerWidth - viewportPad) {
      ov.annotateBtn.style.left = right + "px";
    } else if (left >= viewportPad) {
      ov.annotateBtn.style.left = left + "px";
    } else {
      ov.annotateBtn.style.left = (window.innerWidth - annotateSize - viewportPad) + "px";
    }

    if (annotations.has(aiId)) {
      ov.annotateBtn.classList.add(`${NS}-has-note`);
    } else {
      ov.annotateBtn.classList.remove(`${NS}-has-note`);
    }
  }

  function positionAllOverlays() {
    for (const el of selectedElements) positionSelOverlay(el);
  }

  function destroySelOverlay(aiId) {
    const ov = selOverlays.get(aiId);
    if (!ov) return;
    ov.box.remove();
    ov.corners.forEach(c => c.remove());
    ov.label.remove();
    ov.annotateBtn.remove();
    selOverlays.delete(aiId);
  }

  function destroyAllOverlays() {
    for (const [aiId] of selOverlays) destroySelOverlay(aiId);
  }

  function addSelection(el) {
    if (!selectedElements.includes(el)) {
      selectedElements.push(el);
      createSelOverlay(el);
    }
    setActiveElement(el);
  }

  function setActiveElement(el) {
    activeElement = el;
    for (const [aiId, ov] of selOverlays) {
      const isActive = !!el && aiId === el.getAttribute(AI_ID);
      ov.box.classList.toggle(`${NS}-active`, isActive);
      ov.label.classList.toggle(`${NS}-active`, isActive);
    }
  }

  function removeSelection(el, force = false) {
    const idx = selectedElements.indexOf(el);
    if (idx >= 0) {
      const aiId = el.getAttribute(AI_ID);
      if (annotations.has(aiId) && !force) return false;
      selectedElements.splice(idx, 1);
      destroySelOverlay(aiId);
      annotations.delete(aiId);
      if (activeElement === el) setActiveElement(selectedElements[selectedElements.length - 1] || null);
      return true;
    }
    return false;
  }

  function toggleElement(el) {
    if (selectedElements.includes(el)) {
      if (!removeSelection(el)) setActiveElement(el);
    } else {
      addSelection(el);
    }
  }

  function clearSelection(force = false) {
    for (const el of [...selectedElements]) removeSelection(el, force);
    removeAnnotationPopover();
  }

  // ── Selection history (undo) ────────────────────────────────
  function pushHistory() {
    selectionHistory.push({
      elements: [...selectedElements],
      annotations: new Map(annotations),
      activeElement,
    });
    if (selectionHistory.length > 30) selectionHistory.shift();
  }

  function undo() {
    if (selectionHistory.length === 0) return;
    const state = selectionHistory.pop();
    destroyAllOverlays();
    removeAnnotationPopover();
    selectedElements = state.elements;
    activeElement = state.activeElement || selectedElements[selectedElements.length - 1] || null;
    annotations.clear();
    for (const [k, v] of state.annotations) annotations.set(k, v);
    for (const el of selectedElements) createSelOverlay(el);
    setActiveElement(activeElement);
    updateTags();
  }

  // ── Parent / child navigation ─────────────────────────────
  function moveActiveSelection(target) {
    pushHistory();
    removeSelection(activeElement);
    addSelection(target);
    updateTags();
  }

  function navigateToParent() {
    const el = activeElement;
    if (!el) return;
    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      if (!isEditorElement(parent) && isVisible(parent)) {
        moveActiveSelection(parent);
        return;
      }
      parent = parent.parentElement;
    }
  }

  function navigateToChild() {
    const el = activeElement;
    if (!el) return;
    for (const child of el.children) {
      if (!isEditorElement(child) && isVisible(child) && isMeaningful(child)) {
        moveActiveSelection(child);
        return;
      }
    }
  }

  function navigateToSibling(dir) {
    const el = activeElement;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const siblings = Array.from(parent.children).filter(
      c => !isEditorElement(c) && isVisible(c) && isMeaningful(c)
    );
    const idx = siblings.indexOf(el);
    const next = siblings[idx + dir];
    if (next) {
      moveActiveSelection(next);
    }
  }


  function handleKeyDown(e) {
    if (isEditorElement(e.target) && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    const mod = e.metaKey || e.ctrlKey;

    if (e.key === "Escape") {
      if (activePopover) { removeAnnotationPopover(); }
      else { pushHistory(); clearSelection(); updateTags(); }
      return;
    }
    if (mod && e.key.toLowerCase() === "c" && !e.shiftKey && selectedElements.length > 0) {
      e.preventDefault();
      copyPrompt();
      return;
    }
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if (e.key === "ArrowUp" && activeElement) {
      e.preventDefault();
      navigateToParent();
      return;
    }
    if (e.key === "ArrowDown" && activeElement) {
      e.preventDefault();
      navigateToChild();
      return;
    }
    if (e.key === "ArrowLeft" && activeElement) {
      e.preventDefault();
      navigateToSibling(-1);
      return;
    }
    if (e.key === "ArrowRight" && activeElement) {
      e.preventDefault();
      navigateToSibling(1);
      return;
    }
    if (e.key === " " && !mod && !e.altKey) {
      e.preventDefault();
      togglePaused();
    }
  }

  function togglePaused() {
    paused = !paused;
    showHover(null);
    const dot = chatPanel.querySelector(`.${NS}-status-dot`);
    const label = chatPanel.querySelector(`.${NS}-status-label`);
    if (dot) dot.style.background = paused ? "#888" : "#4ade80";
    if (label) label.textContent = paused ? "Paused" : "Selecting";
  }

  // ── Annotation popover ─────────────────────────────────────
  function showAnnotationPopover(el, btn) {
    removeAnnotationPopover();

    const aiId = el.getAttribute(AI_ID);
    const popover = document.createElement("div");
    popover.className = `${NS}-root ${NS}-annotate-popover`;

    const textarea = document.createElement("textarea");
    textarea.className = `${NS}-annotate-input`;
    textarea.value = annotations.get(aiId) || "";
    textarea.placeholder = "Instruction for this element\u2026";
    textarea.rows = 2;

    const actions = document.createElement("div");
    actions.className = `${NS}-annotate-actions`;

    const clearNoteBtn = document.createElement("button");
    clearNoteBtn.className = `${NS}-annotate-clear`;
    clearNoteBtn.textContent = "Clear";

    const doneBtn = document.createElement("button");
    doneBtn.className = `${NS}-annotate-done`;
    doneBtn.textContent = "Done";

    const save = () => {
      const val = textarea.value.trim();
      if (val) annotations.set(aiId, val);
      else annotations.delete(aiId);
      removeAnnotationPopover();
      positionSelOverlay(el);
    };

    doneBtn.onclick = (e) => { e.stopPropagation(); save(); };
    clearNoteBtn.onclick = (e) => {
      e.stopPropagation();
      annotations.delete(aiId);
      removeAnnotationPopover();
      positionSelOverlay(el);
    };

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
      e.stopPropagation();
    });
    textarea.addEventListener("click", (e) => e.stopPropagation());

    actions.appendChild(clearNoteBtn);
    actions.appendChild(doneBtn);
    popover.appendChild(textarea);
    popover.appendChild(actions);

    const r = btn.getBoundingClientRect();
    popover.style.top = (r.bottom + 6) + "px";
    popover.style.right = Math.max(8, window.innerWidth - r.right) + "px";

    document.body.appendChild(popover);
    activePopover = popover;
    textarea.focus();
  }

  function removeAnnotationPopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  // ── Chat panel ─────────────────────────────────────────────
  function createChatPanel() {
    chatPanel = document.createElement("div");
    chatPanel.className = `${NS}-root ${NS}-chat`;
    setHTML(chatPanel, `
      <div class="${NS}-drag-handle">
        <span class="${NS}-drag-title">
          <span class="${NS}-status-dot"></span>
          <span class="${NS}-status-label">Selecting</span>
        </span>
        <div class="${NS}-panel-actions">
          <button class="${NS}-panel-btn" data-action="close" title="Close">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="${NS}-panel-body">
        <div class="${NS}-chat-tags ${NS}-hidden"></div>
        <div class="${NS}-shortcuts">
          <span><kbd>Click</kbd> Select</span>
          <span><kbd>Shift</kbd> Multi</span>
          <span><kbd>\u2190\u2191\u2192\u2193</kbd> Navigate</span>
          <span><kbd>Space</kbd> Pause</span>
          <span><kbd>\u2318C</kbd> Copy</span>
          <span><kbd>\u2318Z</kbd> Undo</span>
          <span><kbd>Esc</kbd> Clear</span>
        </div>
        <button class="${NS}-copy-btn" disabled>Copy Prompt</button>
      </div>
    `);
    document.body.appendChild(chatPanel);

    chatPanel.querySelector(`.${NS}-copy-btn`).onclick = () => copyPrompt();
    chatPanel.querySelector('[data-action="close"]').onclick = destroy;

    makeDraggable(chatPanel, chatPanel.querySelector(`.${NS}-drag-handle`));
  }

  function makeDraggable(panel, handle) {
    let sx, sy, sl, st;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(`.${NS}-panel-btn`)) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      const move = (e) => {
        panel.style.left   = sl + e.clientX - sx + "px";
        panel.style.top    = st + e.clientY - sy + "px";
        panel.style.right  = "auto";
        panel.style.bottom = "auto";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // ── Element label ──────────────────────────────────────────
  function elementLabel(el) {
    if (el.id) return `#${el.id}`;
    if (el.classList.length) return `.${el.classList[0]}`;
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || "").trim();
    if (text) {
      const preview = text.length > 20 ? text.slice(0, 20) + "\u2026" : text;
      return `${tag} "${preview}"`;
    }
    return `<${tag}>`;
  }

  // ── Tags ───────────────────────────────────────────────────
  function updateTags() {
    const container = chatPanel.querySelector(`.${NS}-chat-tags`);
    const copyBtn = chatPanel.querySelector(`.${NS}-copy-btn`);
    container.replaceChildren();

    if (selectedElements.length > 0) {
      container.classList.remove(`${NS}-hidden`);
      copyBtn.disabled = false;

      for (let i = 0; i < selectedElements.length; i++) {
        const el = selectedElements[i];
        const aiId = el.getAttribute(AI_ID);
        const tag = document.createElement("span");
        tag.className = `${NS}-tag`;
        const hasNote = annotations.has(aiId);
        setHTML(tag, `<span class="${NS}-tag-num">${i + 1}</span><span class="${NS}-tag-label">${elementLabel(el)}${hasNote ? ' \u270e' : ''}</span><button class="${NS}-tag-x" data-aiid="${aiId}" title="Remove">\u00d7</button>`);
        container.appendChild(tag);
      }

      container.querySelectorAll(`.${NS}-tag-x`).forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const el = byAiId(btn.dataset.aiid);
          if (el) removeSelection(el, true);
          updateTags();
        }, true);
      });

      const clearAllBtn = document.createElement("button");
      clearAllBtn.className = `${NS}-tags-action`;
      clearAllBtn.title = "Clear all";
      setHTML(clearAllBtn, `<svg width="8" height="8" viewBox="0 0 8 8" fill="none"><line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Clear`);
      clearAllBtn.onclick = (e) => { e.stopPropagation(); clearSelection(true); updateTags(); };
      container.appendChild(clearAllBtn);
    } else {
      container.classList.add(`${NS}-hidden`);
      copyBtn.disabled = true;
    }
  }

  // ── Copy with button feedback ──────────────────────────────
  let copyTimer = null;
  function showCopyFeedback(msg) {
    const btn = chatPanel.querySelector(`.${NS}-copy-btn`);
    if (copyTimer) clearTimeout(copyTimer);
    btn.classList.add(`${NS}-copy-done`);
    setHTML(btn, `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> ${msg}`);
    copyTimer = setTimeout(() => {
      btn.classList.remove(`${NS}-copy-done`);
      btn.textContent = "Copy Prompt";
      copyTimer = null;
    }, 2000);
  }

  function copyPrompt() {
    const text = buildPromptText();
    if (!text) return;
    writeToClipboard(text);
    showCopyFeedback("Copied");
  }

  // ── Prompt building ────────────────────────────────────────
  function buildPromptText() {
    if (selectedElements.length === 0) return "";

    const lines = ["Page: " + location.pathname, ""];
    selectedElements.forEach((el, i) => {
      const ctx = buildElementContext(el, i + 1);
      lines.push(`${i + 1}. ${elementLabel(el)} <${ctx.tag}>`);
      if (ctx.source)    lines.push(`   source: ${ctx.source}`);
      if (ctx.react)     lines.push(`   react: ${ctx.react}`);
      if (ctx.text)      lines.push(`   text: "${ctx.text}"`);
      Object.entries(ctx.dataAttrs).forEach(([k, v]) => lines.push(`   ${k}: ${v}`));
      if (ctx.outerHTML)  lines.push(`   html: ${ctx.outerHTML}`);
      if (ctx.selector)  lines.push(`   selector: ${ctx.selector}`);

      const aiId = el.getAttribute(AI_ID);
      const note = annotations.get(aiId);
      if (note) lines.push(`   instruction: ${note}`);
    });
    return lines.join("\n");
  }

  function writeToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
  }

  // ── React debug info (dev mode only) ──────────────────────
  const SKIP_REACT = new Set([
    "ClientPageRoot","LinkComponent","ServerComponent","AppRouter",
    "Router","HotReload","ReactDevOverlay","InnerLayoutRouter",
    "OuterLayoutRouter","RedirectBoundary","NotFoundBoundary",
    "ErrorBoundary","LoadingBoundary","TemplateContext",
    "ScrollAndFocusHandler","RenderFromTemplateContext",
    "PathnameContextProviderAdapter","Hot","Inner","Forward","Root",
  ]);

  function isUserComponent(name) {
    if (!name || name.length < 2) return false;
    if (SKIP_REACT.has(name)) return false;
    if (/^[a-z]/.test(name)) return false;
    if (name.startsWith("_")) return false;
    return true;
  }

  function getReactDebug(el) {
    try {
      const fiberKey = Object.keys(el).find(k =>
        k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
      );
      if (!fiberKey) return {};

      const result = {};
      let f = el[fiberKey];

      let walker = f;
      while (walker) {
        if (walker._debugSource) {
          const s = walker._debugSource;
          const file = s.fileName.replace(/^.*?\/src\//, "src/");
          result.source = `${file}:${s.lineNumber}`;
          break;
        }
        walker = walker.return;
      }

      const components = [];
      walker = f;
      while (walker) {
        if (walker.type && typeof walker.type === "function") {
          const name = walker.type.displayName || walker.type.name;
          if (isUserComponent(name) && !components.includes(name)) {
            components.push(name);
            if (components.length >= 3) break;
          }
        }
        walker = walker.return;
      }
      if (components.length) result.react = components.reverse().join(" \u203a ");

      return result;
    } catch {
      return {};
    }
  }

  // ── Element context ────────────────────────────────────────
  function buildElementContext(el, index) {
    const dataAttrs = {};
    for (const attr of el.attributes) {
      if (attr.name.startsWith("data-") && attr.name !== AI_ID) {
        dataAttrs[attr.name] = attr.value;
      }
    }
    const reactInfo = getReactDebug(el);
    return {
      index,
      aiId: el.getAttribute(AI_ID),
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      text: truncate(el.textContent, 80),
      classes: Array.from(el.classList),
      outerHTML: el.outerHTML.slice(0, 200),
      dataAttrs,
      ...reactInfo,
    };
  }

  function buildSelector(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      let seg = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`#${node.id}`); break; }
      const p = node.parentElement;
      if (p) {
        const s = Array.from(p.children).filter(c => c.tagName === node.tagName);
        if (s.length > 1) seg += `:nth-of-type(${s.indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function truncate(s, max) {
    if (!s) return "";
    s = s.replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max) + "\u2026" : s;
  }

  // ── Boot ───────────────────────────────────────────────────
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", createLauncher);
  else createLauncher();
})();
