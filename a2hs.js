/* ============================================================
   Install banner — self-managing.

   A slim banner across the top of the page offers the site as an app
   (a home-screen icon on phones, a Dock / taskbar icon on desktops),
   but ONLY when:
     - the page is not already running from the shortcut
       (display-mode: standalone, iOS navigator.standalone, or ?src=a2hs)
     - it has not been installed before on this browser
     - the banner has not been closed in the last 60 days
     - the browser can actually install it
   Chrome and Edge (desktop and Android) expose beforeinstallprompt, which
   never fires once the app is installed — so they go quiet on their own.
   Safari and Chrome on iOS, and Safari on macOS, have no install API, and
   once added they run the app with storage of its own that this page cannot
   see; there the banner shows the Share → Add to Home Screen / File → Add to
   Dock steps plus an "I've added it" button that retires it for good.
   Firefox and the other iOS browsers: nothing.
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
  const iconSrc = (location.pathname.split("/").filter(Boolean).length ? "../" : "") + `icons/${kid}-192.png`;
  // colour the banner for this kid straight away (app.js sets the same value later)
  if (!document.documentElement.dataset.kid) document.documentElement.dataset.kid = kid;

  let banner = null;
  const close = () => { if (banner){ banner.remove(); banner = null; } };
  const later = () => { store.set(KEY_DISMISSED, String(Date.now())); close(); };
  const installed = () => { store.set(KEY_INSTALLED, "1"); close(); };

  // One banner at a time, pinned as the first thing on the page.
  //   go   - the accent button (Install / Add) — only where a browser API exists
  //   done - the quiet "I've added it" button for the manual routes
  function show({ title, text, go, done, onGo }){
    close();
    const el = document.createElement("aside");
    el.className = "a2hs";
    el.setAttribute("aria-label", `Install ${appName}`);
    el.innerHTML = `
      <div class="a2hs-in">
        <img class="a2hs-icon" src="${iconSrc}" alt="" width="38" height="38">
        <div class="a2hs-body">
          <p class="a2hs-title">${title}</p>
          <p class="a2hs-text">${text}</p>
        </div>
        <div class="a2hs-actions">
          ${go ? `<button type="button" class="a2hs-go">${go}</button>` : ""}
          ${done ? `<button type="button" class="a2hs-done">${done}</button>` : ""}
        </div>
        <button type="button" class="a2hs-close" aria-label="Not now" title="Not now">&times;</button>
      </div>`;
    el.querySelector(".a2hs-go")?.addEventListener("click", onGo);
    el.querySelector(".a2hs-done")?.addEventListener("click", installed);
    el.querySelector(".a2hs-close").addEventListener("click", later);
    document.body.insertBefore(el, document.body.firstChild);
    banner = el;
  }

  const share = `<svg class="a2hs-share" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2 8 6h3v9h2V6h3l-4-4zM5 10v10h14V10h-2v8H7v-8H5z"/></svg>`;

  // iOS first: no browser there has an install API, whatever the UA claims.
  // Safari adds to the Home Screen from its share sheet; since iOS 16.4 Chrome
  // can too, from the share button beside its address bar (Chrome 115+).
  if (isIOS){
    const isChromeIOS = /CriOS/.test(ua);
    if (isSafariIOS || isChromeIOS) show({
      title: "Add to your home screen",
      text: isChromeIOS
        ? `Tap ${share} <b>Share</b> beside the address bar, then <b>Add to Home Screen</b>.`
        : `Tap ${share} <b>Share</b>, then <b>Add to Home Screen</b>.`,
      done: "I've added it"
    });
    return;
  }

  if (hasInstallApi){
    // Chrome/Edge fire this only when installable AND not already installed —
    // on a phone or a desktop. Silence here means it is already installed.
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault();
      const onGo = async () => {
        e.prompt();
        const { outcome } = await e.userChoice;
        outcome === "accepted" ? installed() : later();
      };
      show(isMobile ? {
        title: "Add to your home screen",
        text: "Opens like an app, with its own icon.",
        go: "Add", onGo
      } : {
        title: `Install ${appName}`,
        text: "Opens in its own window, with an icon in your Dock or taskbar.",
        go: "Install", onGo
      });
    });
    // installed from our button or from the address-bar icon alike
    window.addEventListener("appinstalled", installed);
    return;
  }

  if (isSafariMac){
    // Safari 17+ on macOS installs web apps from the File menu; no API for it
    show({
      title: `Add ${appName} to your Dock`,
      text: `In Safari's menu bar choose <b>File</b> → <b>Add to Dock…</b>.`,
      done: "I've added it"
    });
  }
})();
