/* ============================================================
   Add to home screen — self-managing.

   Shows a small card offering a home-screen shortcut, but ONLY when:
     - the page is not already running from a shortcut
       (display-mode: standalone, iOS navigator.standalone, or ?src=a2hs)
     - it has not been installed before on this browser
     - the offer has not been dismissed in the last 60 days
     - the browser can actually install it
   Chrome and Edge (desktop and Android) expose beforeinstallprompt, which
   does not fire at all once the app is installed — so it is naturally quiet.
   iOS Safari and macOS Safari have no install API; they get the Share →
   Add to Home Screen / File → Add to Dock steps instead. Firefox: nothing.
   ============================================================ */
(() => {
  const KEY_DISMISSED = "a2hs.dismissedAt";
  const KEY_INSTALLED = "a2hs.installed";
  const SNOOZE_DAYS = 60;

  const store = {
    get(k){ try { return localStorage.getItem(k) } catch { return null } },
    set(k, v){ try { localStorage.setItem(k, v) } catch {} }
  };

  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafariIOS = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|GSA/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMac = navigator.platform === "MacIntel" && !isIOS;
  const isSafariMac = isMac && /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua);
  const isMobile = isIOS || isAndroid || matchMedia("(pointer: coarse)").matches;
  // Chrome and Edge, on desktop and Android alike, expose a real install API
  const hasInstallApi = "onbeforeinstallprompt" in window;

  const launchedFromShortcut =
    matchMedia("(display-mode: standalone)").matches ||
    matchMedia("(display-mode: fullscreen)").matches ||
    navigator.standalone === true ||
    new URLSearchParams(location.search).get("src") === "a2hs";

  // Running from the shortcut is the strongest proof it exists: remember it,
  // and tidy the query string so it does not linger in the address bar.
  if (launchedFromShortcut){
    store.set(KEY_INSTALLED, "1");
    if (location.search.includes("src=a2hs") && history.replaceState)
      history.replaceState(null, "", location.pathname);
  }

  const snoozed = () => {
    const t = Number(store.get(KEY_DISMISSED) || 0);
    return t && (Date.now() - t) < SNOOZE_DAYS * 864e5;
  };

  // register the (no-cache) service worker so Android considers us installable
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  if (launchedFromShortcut || store.get(KEY_INSTALLED) === "1" || snoozed()) return;
  if (!isMobile && !hasInstallApi && !isSafariMac) return;   // nothing to offer here

  // app.js sets data-kid only after its data loads; the path is available now
  const seg = (location.pathname.replace(/index\.html$/, "").split("/").filter(Boolean).pop() || "").toLowerCase();
  const kid = seg === "sophia" || seg === "olivia" ? seg : "both";
  const appName = kid === "sophia" ? "Sophia's School Day" : kid === "olivia" ? "Olivia's School Day" : "School Day";
  const iconSlug = kid === "sophia" || kid === "olivia" ? kid : "both";
  const iconSrc = (location.pathname.split("/").filter(Boolean).length ? "../" : "") + `icons/${iconSlug}-192.png`;

  function card(body, primary, secondary){
    const el = document.createElement("aside");
    el.className = "a2hs";
    el.setAttribute("role", "note");
    el.innerHTML = `
      <img class="a2hs-icon" src="${iconSrc}" alt="" width="44" height="44">
      <div class="a2hs-body">
        <p class="a2hs-title">${isMobile ? `Add ${appName} to your home screen` : `Install ${appName} as an app`}</p>
        <p class="a2hs-text">${body}</p>
        <div class="a2hs-actions">
          ${primary ? `<button type="button" class="a2hs-go">${primary}</button>` : ""}
          <button type="button" class="a2hs-later">${secondary}</button>
        </div>
      </div>`;
    el.querySelector(".a2hs-later").addEventListener("click", () => {
      store.set(KEY_DISMISSED, String(Date.now())); el.remove();
    });
    return el;
  }

  const mount = el => {
    const host = document.querySelector("footer") || document.body;
    host.parentNode.insertBefore(el, host);
  };

  const share = `<svg class="a2hs-share" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2 8 6h3v9h2V6h3l-4-4zM5 10v10h14V10h-2v8H7v-8H5z"/></svg>`;

  // iOS first: no browser there has an install API, whatever the UA claims
  if (isIOS){
    if (isSafariIOS) mount(card(`Tap ${share} <b>Share</b>, then <b>Add to Home Screen</b>.`, null, "Got it"));
    return;
  }

  if (hasInstallApi){
    // Chrome/Edge fire this only when installable AND not already installed —
    // on a phone or a desktop. Silence here means it is already installed.
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault();
      const el = card(isMobile
        ? "One tap opens it like an app, with its own icon."
        : "Opens in its own window, with an icon in your Dock or taskbar.", isMobile ? "Add" : "Install", "Not now");
      el.querySelector(".a2hs-go").addEventListener("click", async () => {
        e.prompt();
        const { outcome } = await e.userChoice;
        if (outcome === "accepted") store.set(KEY_INSTALLED, "1");
        else store.set(KEY_DISMISSED, String(Date.now()));
        el.remove();
      });
      mount(el);
    });
    window.addEventListener("appinstalled", () => store.set(KEY_INSTALLED, "1"));
    return;
  }

  if (isSafariMac){
    // Safari 17+ on macOS installs web apps from the File menu; no API for it
    mount(card(`In Safari's menu bar choose <b>File</b> → <b>Add to Dock…</b>.`, null, "Got it"));
  }
})();
