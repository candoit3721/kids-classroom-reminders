/* ============================================================
   Add to home screen — self-managing.

   Shows a small card offering a home-screen shortcut, but ONLY when:
     - the page is not already running from a shortcut
       (display-mode: standalone, iOS navigator.standalone, or ?src=a2hs)
     - it has not been installed before on this browser
     - the offer has not been dismissed in the last 60 days
     - the device is a phone or tablet (this is a mobile convenience)
   Android: waits for Chrome's own beforeinstallprompt, which does not fire
   at all if the app is already installed — so it is naturally quiet.
   iOS Safari has no install API; it shows the Share → Add to Home Screen
   steps instead.
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
  const isMobile = isIOS || isAndroid || matchMedia("(pointer: coarse)").matches;

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

  if (launchedFromShortcut || !isMobile || store.get(KEY_INSTALLED) === "1" || snoozed()) return;

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
        <p class="a2hs-title">Add ${appName} to your home screen</p>
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

  if (isAndroid){
    // Chrome fires this only when installable AND not already installed
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault();
      const el = card("One tap opens it like an app, with its own icon.", "Add", "Not now");
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

  if (isSafariIOS){
    const share = `<svg class="a2hs-share" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2 8 6h3v9h2V6h3l-4-4zM5 10v10h14V10h-2v8H7v-8H5z"/></svg>`;
    mount(card(`Tap ${share} <b>Share</b>, then <b>Add to Home Screen</b>.`, null, "Got it"));
  }
})();
