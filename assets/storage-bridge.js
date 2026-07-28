/**
 * Storage bridge: runs in the extension's ISOLATED world so it can reach
 * chrome.storage.local, and proxies get/set calls coming from the MAIN-world
 * content script (editor.js) via window.postMessage.
 *
 * Why a bridge? editor.js runs in MAIN world to walk React fibers, but MAIN
 * world has no access to chrome.* APIs. This file is the smallest possible
 * shim that gives editor.js cross-page persistence.
 */
/* global chrome */
(function () {
  "use strict";

  const NS = "__aiEditorStorage";

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__ns !== NS) return;

    if (d.op === "get") {
      chrome.storage.local.get([d.key], (res) => {
        window.postMessage(
          { __ns: NS, op: "getResult", reqId: d.reqId, value: res[d.key] },
          "*"
        );
      });
    } else if (d.op === "set") {
      chrome.storage.local.set({ [d.key]: d.value });
    }
  });
})();
