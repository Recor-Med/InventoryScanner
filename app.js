document.addEventListener('DOMContentLoaded', async () => {
  // ---- Feature flags ----
  // Set these to `true` later if you want to re-enable account verification
  // and/or live inventory lookups. The original functions are left intact
  // below, they are simply not invoked while these flags are false.
  const FEATURES = {
    accountVerification: true,
    inventoryLookup: false,
    // The Scanbot SDK defaults to locking the scanner to the rear/"environment"
    // facing camera (cameraModule: 'BACK'), which is what you want on a phone
    // but gets in the way when testing on a laptop (e.g. using an iPhone as a
    // Continuity Camera / plugged-in webcam, or just the laptop's built-in
    // camera). Set to `true` to restore the original rear-camera lock.
    lockRearCamera: false,
  };

  const videoElement = document.getElementById('video');
  const output = document.getElementById('output');
  const scanningView = document.getElementById('scanningView');
  const tableView = document.getElementById('tableView');
  const confirmationView = document.getElementById('confirmationView');
  const submissionResultView = document.getElementById('submissionResultView');
  const submissionMessage = document.getElementById('submissionMessage');
  const accountSection = document.getElementById('accountSection');
  const tableSection = document.getElementById('tableSection');
  const buttonSection = document.getElementById('buttonSection');
  const verifyAccountBtn = document.getElementById('verifyAccountBtn');
  const startBtn = document.getElementById('startBtn');
  const cancelScanBtn = document.getElementById('cancelScanBtn');
  const scanNextBtn = document.getElementById('scanNextBtn');
  const submitBtn = document.getElementById('submitBtn');
  const confirmSubmitBtn = document.getElementById('confirmSubmitBtn');
  const cancelSubmitBtn = document.getElementById('cancelSubmitBtn');
  const itemTableBody = document.querySelector('#itemTable tbody');

  // The Scanbot SDK license key
  const licenseKey = window.LOCAL_SDK_LICENSE_KEY ||
    "eyJpZCI6IkI4QTAwODI4LTI0MTYtNDk3QS1BN0ZELTdDMkMwRkY0M0Y4QyIsInR5cGUiOiJPRkZMSU5FIiwiYXBwSWRzIjpbImxvY2FsaG9zdCIsInNjYW5uZXIucmVjb3JtZWRpY2FsLmNvbSJdLCJleHBpcmF0aW9uVGltZXN0YW1wIjoxODIyMTc2MDAwMDAwLCJmZWF0dXJlcyI6WyJCYXJjb2RlU2Nhbm5lciJdLCJwbGF0Zm9ybXMiOlsiV2ViQXNzZW1ibHkiXSwidmFsaWRGcm9tVGltZXN0YW1wIjoxNzkwNzI2NDAwMDAwLCJncmFjZVBlcmlvZE1zIjo1MTg0MDAwMDAwLCJtZXRhZGF0YSI6eyJsaWNlbnNlZSI6IlJlY29yIE1lZGljYWwgSW5jIiwibGljZW5zZUlkIjoiYTVqT0swMDAwMDFtbU9MWUFZIiwib3BlcmF0b3IiOiJATGF1cmVsIn19.MEYCIQDaaciootHlOv4IQ1tXsb-V11BhYTjChBrntHer2xoXhgIhANpZGsBuIaBbe6XPVuGzulb2_9Sxt9FKRpt9fGIQRcom";

  const today = new Date()

  // Base URL for the Recor Scanner API. The API is hosted on Azure and
  // firewalled to accept requests only from specific fixed IPs, so even when
  // the front end itself is served locally (e.g. `npm start` here using
  // `serve -l 3000`), it still calls the deployed Azure instance rather than a local API.
  const API_BASE_URL = 'https://inventoryscanerapi-czexe2e7a5fjggef.centralus-01.azurewebsites.net';

  const scannedCodes = [];
  let scanbotSDK = null;
  let barcodeScanner = null;

  let barcodeScannerController = null;

  // Guards against startScan() being invoked concurrently from multiple
  // triggers (the heartbeat interval, the visibilitychange handler, and the
  // user clicking "Scan Next" can all fire close together after the app
  // resumes from idle). Without this, two overlapping calls can race on the
  // shared barcodeScanner reference - e.g. one call disposes the scanner
  // just after another has created a new one, silently leaving the camera
  // non-functional with no error surfaced.
  let startScanPromise = null;

  // Set once we've decided the camera/SDK is unrecoverable in-page and a
  // reload has been triggered, so the heartbeat/visibilitychange handlers
  // don't try to trigger a second overlapping reload.
  let reloadRecoveryTriggered = false;
  const SCAN_RECOVERY_STORAGE_KEY = 'inventoryScannerRecoveryState';

  let formattedDate = today.toISOString().split('T')[0];
  let confirmedAccount = null;
  let confirmedAccountName = null;
  let currentDeviceId = null;
  let lastScannedCode = null;
  let confirmedWarehouseCode = null;
  let scanCooldown = false;
  let inventoryProductItems = [];
  let ids = [];

  // Keep scanner alive during idle periods to prevent camera suspension
  let scannerHeartbeatInterval = null;
  let wakeLock = null;
  let scannerActive = false; // true while we expect the camera to be running

  // The Screen Wake Lock API prevents the screen (and therefore the camera
  // feed) from being suspended by the OS/browser while scanning is active.
  // This is what actually keeps the camera alive on mobile Safari/Chrome -
  // merely polling the SDK object (the old "heartbeat") does nothing because
  // it never touches the underlying MediaStream/video element.
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          console.log('Wake lock released');
        });
        console.log('Wake lock acquired');
      }
    } catch (e) {
      console.warn('Could not acquire wake lock:', e);
      wakeLock = null;
    }
  }

  async function releaseWakeLock() {
    try {
      if (wakeLock) {
        await wakeLock.release();
      }
    } catch (e) {
      console.warn('Error releasing wake lock:', e);
    } finally {
      wakeLock = null;
    }
  }

  // Checks whether the <video> element the SDK is rendering into is still
  // actually receiving new camera frames. The wake lock is automatically
  // released by the browser whenever the tab/page is backgrounded (e.g.
  // switching apps on a phone, locking the screen), which in turn can
  // suspend the camera's MediaStream. When the page becomes visible again
  // we re-acquire the wake lock and, if the video has actually stalled,
  // restart the scanner.
  //
  // IMPORTANT: checking the <video> element's paused/ended/readyState flags,
  // or even sampling video.currentTime, is NOT reliable for a live
  // MediaStream. Unlike a regular video file, currentTime on a live stream
  // just advances with wall-clock time - it keeps ticking even if the
  // decoder is stuck rendering a frozen last frame, so it will falsely
  // report "healthy" exactly in the case we care about (camera suspended by
  // the OS after idle). We instead count actual delivered frames using
  // requestVideoFrameCallback (Safari 15.4+/Chrome), falling back to the
  // webkit/moz decoded-frame counters, and only fall back to the weaker
  // currentTime heuristic if none of those APIs are available.
  function countVideoFrames(video, windowMs) {
    return new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback === 'function') {
        let count = 0;
        let cancelled = false;
        const onFrame = () => {
          if (cancelled) return;
          count++;
          handle = video.requestVideoFrameCallback(onFrame);
        };
        let handle = video.requestVideoFrameCallback(onFrame);
        setTimeout(() => {
          cancelled = true;
          if (typeof video.cancelVideoFrameCallback === 'function') {
            try { video.cancelVideoFrameCallback(handle); } catch {}
          }
          resolve(count);
        }, windowMs);
        return;
      }

      const getDecodedFrameCount = () =>
        video.webkitDecodedFrameCount ?? video.mozDecodedFrames ?? null;

      const before = getDecodedFrameCount();
      if (before === null) {
        resolve(null); // No frame-counting API available at all.
        return;
      }
      setTimeout(() => {
        const after = getDecodedFrameCount();
        resolve(after !== null ? after - before : null);
      }, windowMs);
    });
  }

  async function isVideoStreamHealthy() {
    const video = document.querySelector('#video video');
    if (!video) {
      console.log('[healthcheck] no <video> element found');
      return false;
    }

    // Mobile Safari/Chrome frequently auto-pause the <video> element itself
    // when the tab is backgrounded, even though the underlying MediaStream
    // track is still 'live' and the camera hardware was never released. In
    // that case a plain video.play() resumes it immediately - much cheaper
    // than tearing down and recreating the whole scanner. Try that first.
    if (video.paused && !video.ended) {
      try {
        await video.play();
        console.log('[healthcheck] video was paused, resumed via video.play()');
      } catch (e) {
        console.warn('[healthcheck] video.play() resume attempt failed:', e);
      }
    }

    if (video.paused || video.ended || video.readyState < 2) {
      console.log('[healthcheck] unhealthy: paused=%s ended=%s readyState=%s', video.paused, video.ended, video.readyState);
      return false;
    }

    const stream = video.srcObject;
    if (stream instanceof MediaStream) {
      const tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
      if (tracks.length === 0 || tracks.some(track => track.readyState !== 'live')) {
        console.log('[healthcheck] unhealthy: video track(s) not live', tracks.map(t => t.readyState));
        return false;
      }
    }

    const framesDelivered = await countVideoFrames(video, 350);
    if (video.paused || video.ended) {
      console.log('[healthcheck] unhealthy: video paused/ended during frame count');
      return false;
    }

    if (framesDelivered !== null) {
      if (framesDelivered <= 0) {
        console.log('[healthcheck] unhealthy: 0 frames delivered in 350ms window');
      }
      return framesDelivered > 0;
    }

    // Last-resort fallback when no frame-counting API exists: at least
    // confirm currentTime is advancing (weak, but better than nothing).
    const before = video.currentTime;
    await new Promise(resolve => setTimeout(resolve, 300));
    if (video.paused || video.ended) return false;
    const healthy = video.currentTime !== before;
    if (!healthy) {
      console.log('[healthcheck] unhealthy: currentTime not advancing (fallback check)');
    }
    return healthy;
  }

  function startScannerHeartbeat() {
    if (scannerHeartbeatInterval) return; // Already running
    scannerActive = true;
    requestWakeLock();

    scannerHeartbeatInterval = setInterval(async () => {
      if (!scannerActive) return;
      if (document.hidden) return; // nothing we can do while backgrounded

      // Re-acquire the wake lock if it was dropped (e.g. OS dimmed the
      // screen briefly) without the page having been fully hidden.
      if (!wakeLock) {
        await requestWakeLock();
      }

      if (barcodeScanner && !(await isVideoStreamHealthy())) {
        console.warn('Scanner heartbeat: video stream stalled, restarting camera...');
        await startScan();
      } else {
        console.log('Scanner heartbeat: active');
      }
    }, 10000); // Check every 10 seconds
  }

  function stopScannerHeartbeat() {
    scannerActive = false;
    if (scannerHeartbeatInterval) {
      clearInterval(scannerHeartbeatInterval);
      scannerHeartbeatInterval = null;
    }
    releaseWakeLock();
  }

  // When the page comes back into the foreground, re-acquire the wake lock
  // (the browser force-releases it on backgrounding) and verify the camera
  // actually resumed; if not, restart it.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    if (!scannerActive) return;

    await requestWakeLock();

    if (barcodeScanner && !(await isVideoStreamHealthy())) {
      console.warn('Camera did not resume after returning to foreground, restarting...');
      await startScan();
    }
  });

  // Initialize Scanbot SDK
  async function initScanbot() {
    try {
      scanbotSDK = await ScanbotSDK.initialize({
        licenseKey: licenseKey,
        enginePath: '/wasm/',
        onInitialize: () => console.log('Scanbot SDK initialized!'),
        onInitializeError: (error) => console.error('Init failed:', error)
      });
      console.log('Scanbot SDK ready:', scanbotSDK.isReady);
    } catch (err) {
      console.error('Failed to initialize Scanbot SDK:', err);
      output.textContent = 'Failed to initialize scanner.';
    }
  }

  await initScanbot();
  const scanStateWasRestored = restoreScanRecoveryStateIfPresent();

  // The front end is reached via a link from one of two Salesforce pages:
  //  - The Account page, which supplies the Account's record Id as
  //    ?accountId=001XXXXXXXXXXXXXXX. The Account's Recor Account Number is
  //    looked up from that Id, and used as the prefix to filter
  //    Inventory_Product_Line__c records.
  //  - The Contact page, which supplies the Contact's record Id as
  //    ?contactId=003XXXXXXXXXXXXXXX. The Contact's email address is looked
  //    up from that Id instead, and used as the prefix (Inventory_Product_
  //    Line__c records can be linked directly to a Contact rather than an
  //    Account, in which case the line's Id is prefixed with the contact's
  //    email address instead of an account number).
  // The legacy ?account=<Recor Account Number> param is still supported as
  // a fallback for manual testing/links that pass the account number
  // directly rather than a Salesforce record Id.
  const urlParams = new URLSearchParams(window.location.search);
  const urlAccountId = (urlParams.get('accountId') || '').trim();
  const urlContactId = (urlParams.get('contactId') || '').trim();
  const legacyAccountNumber = (urlParams.get('account') || '').trim();
  const CONFIRMED_PREFIX_STORAGE_KEY = 'inventoryScannerConfirmedPrefix';

  function getStoredConfirmedPrefix() {
    try {
      return (sessionStorage.getItem(CONFIRMED_PREFIX_STORAGE_KEY) || '').trim();
    } catch {
      return '';
    }
  }

  function setStoredConfirmedPrefix(prefix) {
    try {
      if (prefix) {
        sessionStorage.setItem(CONFIRMED_PREFIX_STORAGE_KEY, prefix);
      }
    } catch {
      // Ignore storage errors (e.g. disabled storage/private mode restrictions)
    }
  }

  function clearStoredConfirmedPrefix() {
    try {
      sessionStorage.removeItem(CONFIRMED_PREFIX_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }

  // Resolves whichever identifier was supplied in the URL into the prefix
  // value (account number or contact email) used to filter inventory
  // product lines.
  async function resolveInventoryPrefix() {
    if (urlAccountId) {
      const res = await fetch(`${API_BASE_URL}/api/account?id=${encodeURIComponent(urlAccountId)}`);
      const data = await res.json();
      if (!res.ok || !data.found || !data.accountNumber) {
        throw new Error(data.error || `Unable to resolve account id ${urlAccountId}`);
      }
      return { prefix: data.accountNumber };
    }
    if (urlContactId) {
      const res = await fetch(`${API_BASE_URL}/api/contact?id=${encodeURIComponent(urlContactId)}`);
      const data = await res.json();
      if (!res.ok || !data.found || !data.email) {
        throw new Error(data.error || `Unable to resolve contact id ${urlContactId}`);
      }
      return { prefix: data.email };
    }
    if (legacyAccountNumber) {
      return { prefix: legacyAccountNumber };
    }
    return null;
  }

  const storedConfirmedPrefix =
    !urlAccountId && !urlContactId && !legacyAccountNumber
      ? ''
      : '';

  console.log('Init check:', { urlAccountId, urlContactId, legacyAccountNumber, storedConfirmedPrefix, scanStateWasRestored });

  // Skip the normal URL-param/manual-entry account resolution entirely if
  // we just restored scanned progress after a recovery reload - otherwise
  // this would immediately reset confirmedAccount/confirmedWarehouseCode
  // and flip the account/table views back, discarding everything
  // restoreScanRecoveryStateIfPresent() just set up.
  if (!scanStateWasRestored) {
  if (urlAccountId || urlContactId || legacyAccountNumber) {
    // An identifier was supplied via the URL (from the Account page, the
    // Contact page, or a legacy direct-account-number link) - skip the
    // manual entry form entirely and resolve + load inventory straight away.
    confirmedAccount = null;
    confirmedAccountName = null;
    confirmedWarehouseCode = null;

    accountSection.classList.add('hidden');
    tableView.classList.remove('hidden');
    output.textContent = 'Loading inventory...';

    try {
      const resolved = storedConfirmedPrefix
        ? { prefix: storedConfirmedPrefix }
        : await resolveInventoryPrefix();
      confirmedAccount = resolved.prefix;
      confirmedAccountName = null;
      setStoredConfirmedPrefix(resolved.prefix);
      output.textContent = 'Loading inventory...';
      await fetchInventoryProducts(resolved.prefix);
      populateInventoryProductTable();
      output.textContent = `Ready to scan. Loaded ${inventoryProductItems.length} inventory line(s).`;
    } catch (err) {
      console.error('Error fetching inventory product items:', err);
      clearStoredConfirmedPrefix();
      const input = document.getElementById('accountInput');
      if (input) input.value = '';
      accountSection.classList.remove('hidden');
      tableView.classList.add('hidden');
      output.textContent = `Ready to scan. Failed to load inventory: ${err.message}`;
    }
  } else {
    // No identifier was supplied at all (e.g. the user navigated to the
    // bare scanner URL directly) - show the manual entry form so they can
    // type in either an account number or an email address.
    clearStoredConfirmedPrefix();
    const input = document.getElementById('accountInput');
    if (input) input.value = '';
    accountSection.classList.remove('hidden');
    tableView.classList.add('hidden');
  }
  }

  updateViewState();

  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  async function verifyAccountNumber() {
    const input = document.getElementById('accountInput');
    const status = document.getElementById('accountStatus');
    const rawValue = input.value.trim();

    if (!rawValue) {
      status.textContent = 'Please enter an account number.';
      status.style.color = 'red';
      return;
    }

    const isEmail = EMAIL_PATTERN.test(rawValue);

    status.textContent = isEmail ? 'Looking up contact...' : 'Looking up account...';
    status.style.color = 'blue';

    try {
      const res = isEmail
        ? await fetch(`${API_BASE_URL}/api/contact?email=${encodeURIComponent(rawValue)}`)
        : await fetch(`${API_BASE_URL}/api/account?number=${encodeURIComponent(rawValue)}`);
      const data = await res.json();

      if (res.status === 404) {
        status.textContent = isEmail
          ? `No contact found for ${rawValue}`
          : `No account found for ${rawValue}`;
        status.style.color = 'red';
        return;
      }
      if (res.status === 422) {
        status.textContent = `Found but missing required fields. Please contact support.`;
        status.style.color = 'darkorange';
        return;
      }
      if (res.status >= 500) {
        status.textContent = 'Server error. Please try again later.';
        status.style.color = 'red';
        return;
      }

      const prefix = isEmail ? data.email : data.accountNumber;
      confirmedAccount = prefix;
      confirmedAccountName = null;
      confirmedWarehouseCode = null;
      setStoredConfirmedPrefix(prefix);

      output.textContent = 'Loading inventory product items...';

      try {
        await fetchInventoryProducts(prefix);
        populateInventoryProductTable();

        accountSection.classList.add('hidden');
        tableView.classList.remove('hidden');

        status.textContent = 'Verified.';
        status.style.color = 'green';
        output.textContent = `Ready to scan. Loaded ${inventoryProductItems.length} inventory line(s).`;
        updateViewState();
      } catch (err) {
        console.error("Error fetching inventory product items:", err);
        alert("Failed to load inventory product data. Please try again.");
      }

    } catch (err) {
      console.error('Network/Server Error:', err);
      status.textContent = 'Unable to connect. Please try again.';
      status.style.color = 'red';
    }
  }

  async function fetchInventoryProducts(prefix) {
    const res = await fetch(
      `${API_BASE_URL}/api/items?prefix=${encodeURIComponent(prefix)}`
    );
    if (!res.ok) throw new Error(`Unable to fetch items: ${res.status}`);
    const data = await res.json();
    inventoryProductItems = data.items || [];
    console.log('Fetched /api/items:', inventoryProductItems);
  }

  // Lists the full set of Inventory_Product_line__c records returned for the
  // account (from the URL) so the user can see expected inventory up front.
  // Each row's Count starts at 0 and is incremented as matching lot/serial
  // numbers are scanned (see addRawRowToTable's inventoryProductItems lookup).
  function populateInventoryProductTable() {
    itemTableBody.innerHTML = '';
    inventoryProductItems.forEach((item, index) => {
      const row = document.createElement('tr');
      row.dataset.reference = item.lotSerial || '';
      row.dataset.gtin = '';
      row.dataset.prds = item.sku || '';
      row.innerHTML = `
        <td data-label="#">${index + 1}</td>
        <td data-label="PRDS">${escapeHtml(item.sku || '')}</td>
        <td data-label="Lot/Serial">${escapeHtml(item.lotSerial || '')}</td>
        <td data-label="Expiry Date">${formatDate(item.expiry)}</td>
        <td data-label="Quantity">${item.quantity || 0}</td>
        <td data-label="Count">0</td>
      `;
      itemTableBody.appendChild(row);
    });
  }

  async function fetchIds() {
    try {
      const res = await fetch(`${API_BASE_URL}/api/ids`);
      if (!res.ok) {
        throw new Error(`Failed to fetch /api/ids: ${res.status}`);
      }
      const data = await res.json();
      ids = data.ids || [];
      console.log('Fetched /api/ids:', ids);
    } catch (err) {
      console.error('Error fetching /api/ids:', err);
      ids = [];
    }
  }

  function updateViewState() {
    const hasScans = scannedCodes.length > 0;
    startBtn.classList.toggle('hidden', hasScans || !confirmedAccount);
    startBtn.disabled = !confirmedAccount;
    scanNextBtn.classList.toggle('invisible', !hasScans);
    scanNextBtn.disabled = !hasScans;
    submitBtn.disabled = !hasScans;
    buttonSection.classList.toggle('hidden', !hasScans);
  }

  // The Scanbot SDK has no supported way to tear down/terminate a worker
  // once ScanbotSDK.initialize() has created one (there is no dispose() on
  // the SDK itself, only on individual scanner handles). That means calling
  // initScanbot() again to "recover" from a broken scanner leaks a brand
  // new worker on top of the old, still-alive one - which in practice is
  // what was causing the repeating "Your license is not valid" errors:
  // each extra worker appears to compete for/corrupt the license's
  // single-active-feature validation, so every subsequent attempt fails
  // the same way, forever, every time the heartbeat fires.
  //
  // The only reliable fix is a full page reload, which guarantees a single
  // clean worker. To avoid losing the user's already-scanned items, we
  // persist the current table + account state to sessionStorage right
  // before reloading, and restore it once the page comes back up.
  function persistScanRecoveryState() {
    try {
      const state = {
        tableHtml: itemTableBody.innerHTML,
        confirmedAccount,
        confirmedAccountName,
        confirmedWarehouseCode,
        inventoryProductItems,
      };
      sessionStorage.setItem(SCAN_RECOVERY_STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Failed to persist scan recovery state:', e);
    }
  }

  function restoreScanRecoveryStateIfPresent() {
    let raw;
    try {
      raw = sessionStorage.getItem(SCAN_RECOVERY_STORAGE_KEY);
    } catch {
      return false;
    }
    if (!raw) return false;

    sessionStorage.removeItem(SCAN_RECOVERY_STORAGE_KEY);

    try {
      const state = JSON.parse(raw);
      confirmedAccount = state.confirmedAccount || null;
      confirmedAccountName = state.confirmedAccountName || null;
      confirmedWarehouseCode = state.confirmedWarehouseCode || null;
      inventoryProductItems = Array.isArray(state.inventoryProductItems) ? state.inventoryProductItems : [];
      if (state.tableHtml) {
        itemTableBody.innerHTML = state.tableHtml;
        // scannedCodes only needs to reflect "how many rows exist" for
        // updateViewState()'s hasScans check; the actual row data already
        // lives in the restored DOM.
        scannedCodes.length = 0;
        const restoredRowCount = itemTableBody.querySelectorAll('tr').length;
        for (let i = 0; i < restoredRowCount; i++) scannedCodes.push(true);
      }

      accountSection.classList.add('hidden');
      tableView.classList.remove('hidden');
      tableSection.classList.remove('hidden');
      scanningView.classList.add('hidden');
      output.textContent = 'Camera reset after idle timeout - your scanned items were preserved. Tap "Scan Next" to continue.';
      output.style.color = 'darkorange';
      updateViewState();
      return true;
    } catch (e) {
      console.warn('Failed to restore scan recovery state:', e);
      return false;
    }
  }

  // Last-resort recovery: the in-page SDK state is unrecoverable (repeated
  // scanner creation failures, typically surfaced as a licensing/feature
  // error after the worker was suspended/duplicated while backgrounded).
  // Persist progress and force a full reload to get a guaranteed-clean SDK
  // worker instance.
  function triggerReloadRecovery(reason) {
    if (reloadRecoveryTriggered) return;
    reloadRecoveryTriggered = true;
    scannerActive = false;
    stopScannerHeartbeat();
    console.error('Triggering full page reload to recover scanner:', reason);
    output.textContent = 'Camera needs to restart - reloading page, your scanned items will be kept...';
    persistScanRecoveryState();
    setTimeout(() => window.location.reload(), 600);
  }

  // Creates (or replaces) the #video container div that the SDK renders
  // its camera preview into. Pulled out into a helper since it's needed in
  // multiple recovery paths below.
  function recreateVideoContainer() {
    const existing = document.getElementById('video');
    const parent = existing ? existing.parentNode : document.getElementById('scanningView');
    const fresh = document.createElement('div');
    fresh.id = 'video';
    fresh.style.width = '400px';
    fresh.style.height = '300px';
    fresh.style.background = 'black';
    if (existing && parent) {
      parent.replaceChild(fresh, existing);
    } else if (parent) {
      parent.appendChild(fresh);
    }
  }

  function buildBarcodeScannerConfig() {
    return {
      containerId: 'video',
      // Controls which camera module the SDK requests. By default the SDK
      // locks to 'BACK' (rear/environment-facing camera). While
      // lockRearCamera is false, request 'FRONT' instead so a laptop's
      // built-in webcam / Continuity Camera / other non-rear camera can be
      // used. Set FEATURES.lockRearCamera back to true to restore the
      // original rear-camera-only behavior.
      cameraConfiguration: {
        cameraModule: FEATURES.lockRearCamera ? 'BACK' : 'FRONT'
      },
      showFinder: false,
      onBarcodesDetected: (result) => {
        if (result.barcodes && result.barcodes.length > 0) {
          onBarcodeDetected(result.barcodes);
        }
      },
      // Critical: without this, errors raised by the SDK's *ongoing*
      // detection loop (as opposed to errors from createBarcodeScanner()
      // itself) are never surfaced to our code at all - they just get
      // logged as uncaught worker errors in the console, repeating on
      // every detection frame, forever. This is exactly what was causing
      // the endlessly repeating "Your license is not valid" error: the
      // scanner was created successfully (so our retry/health-check logic
      // never triggered), but every detection cycle afterward failed
      // internally with no way for us to react to it. Wiring onError lets
      // us detect this and force the reload-based recovery immediately
      // instead of leaving the camera silently broken.
      onError: (e) => {
        console.error('Scanbot scanner reported an internal error:', e);
        const message = String(e?.message || e || '');
        if (/license/i.test(message)) {
          triggerReloadRecovery(e);
        }
      },
      // finder: {
      //   visible: true,
      //   style: { _type: "FinderStrokedStyle", strokeColor: "green", strokeWidth: 3 }
      // },
      userGuidance: {
        visible: true,
        title: { text: "Scan item", color: "white" }
      }
    };
  }

  async function startScan() {
    // If a startScan() call is already in flight (triggered by the
    // heartbeat, a visibilitychange recovery, or a user click), wait for it
    // to finish and reuse its outcome instead of starting a second,
    // overlapping attempt that would race on the shared barcodeScanner
    // reference.
    if (startScanPromise) {
      return startScanPromise;
    }
    startScanPromise = runStartScan();
    try {
      await startScanPromise;
    } finally {
      startScanPromise = null;
    }
  }

  async function runStartScan() {
    try {
      if (!scanbotSDK) {
        output.textContent = 'Scanbot SDK not ready.';
        return;
      }

      scanningView.classList.remove('hidden');
      tableView.classList.add('hidden');
      scanNextBtn.disabled = true;

      // Fast path: if the existing scanner's camera stream is still alive
      // (e.g. we were only away for a moment and the wake lock kept the
      // camera running), just reuse it instead of tearing everything down
      // and re-requesting the camera - that full teardown/recreate is what
      // causes the ~25-30s loading animation, and it's unnecessary when
      // nothing actually went wrong with the stream.
      if (barcodeScanner && (await isVideoStreamHealthy())) {
        output.textContent = '';
        try {
          if (typeof barcodeScanner.resumeDetection === 'function') {
            barcodeScanner.resumeDetection();
          }
        } catch (e) {
          console.warn('resumeDetection failed, continuing with existing stream:', e);
        }
        startScannerHeartbeat();
        scanNextBtn.disabled = false;
        return;
      }

      output.textContent = 'Starting Scanbot camera...';

      if (barcodeScanner) {
        try {
          await barcodeScanner.dispose();
        } catch (e) {
          console.warn('Error disposing previous scanner:', e);
        }
        barcodeScanner = null;
      }

      recreateVideoContainer();
      const config = buildBarcodeScannerConfig();

      // Camera creation can fail transiently right after the OS/browser
      // suspends a backgrounded tab (the stream needs a moment to be
      // reclaimed). It can also "succeed" (resolve without throwing) while
      // still producing a dead/frozen stream - the SDK call itself doesn't
      // always surface that. So after each attempt we verify the resulting
      // stream is actually healthy, and retry if it isn't. Retry a couple
      // of times with a short delay - this is fast (no WASM/engine reload)
      // and resolves the vast majority of post-idle failures without ever
      // touching the expensive full SDK reinitialization below.
      const maxQuickRetries = 2;
      let lastErr = null;
      for (let attempt = 0; attempt <= maxQuickRetries; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (barcodeScanner) {
              try {
                await barcodeScanner.dispose();
              } catch (e) {
                console.warn('Error disposing stalled scanner before retry:', e);
              }
              barcodeScanner = null;
            }
            recreateVideoContainer();
          }
          barcodeScanner = await scanbotSDK.createBarcodeScanner(config);

          // Give the stream a brief moment to actually start producing
          // frames before judging it, then confirm it's really healthy.
          await new Promise(resolve => setTimeout(resolve, 400));
          const healthy = await isVideoStreamHealthy();
          if (!healthy) {
            throw new Error('Scanner created but camera stream is not producing frames');
          }

          console.log(`Barcode scanner created${attempt > 0 ? ` (quick retry ${attempt})` : ''}`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`Scanner creation attempt ${attempt + 1} failed:`, err);
          // A license/feature validation error means the SDK worker itself is
          // in a bad state (this has been observed after the worker gets
          // suspended or duplicated while the tab was backgrounded) -
          // retrying createBarcodeScanner() on the same broken instance will
          // just repeat the same failure, so stop burning quick-retry
          // attempts and go straight to the escalation path below.
          if (/license/i.test(String(err?.message || err))) {
            break;
          }
        }
      }

      if (!lastErr) {
        startScannerHeartbeat(); // Keep camera alive during scanning
      } else {
        // Quick retries failed (or we fast-failed on a license/feature
        // error). ScanbotSDK.initialize() has no supported way to dispose
        // the SDK/worker it created, so previously this fell back to
        // calling initScanbot() again to "fully reinitialize" - but that
        // just leaks another worker on top of the broken one without ever
        // freeing it, which corrupts the license's active-feature tracking
        // and makes every subsequent attempt (including the next
        // heartbeat tick) fail identically forever. A full page reload is
        // the only way to guarantee a single clean worker, so that's what
        // we do here instead, after preserving the user's scanned progress.
        triggerReloadRecovery(lastErr);
        return;
      }
    } catch (err) {
      console.error('Error while starting scanner:', err);
      if (/license/i.test(String(err?.message || err))) {
        triggerReloadRecovery(err);
        return;
      }
      stopScannerHeartbeat();
      output.textContent = 'Unable to start scanner. See console.';
      scanningView.classList.add('hidden');
      tableView.classList.remove('hidden');
      scanNextBtn.disabled = false;
    }
  }

  async function onBarcodeDetected(barcodes) {
    if (!barcodes || barcodes.length === 0) return;
    if (scanCooldown) return;

    scanCooldown = true;
    setTimeout(() => (scanCooldown = false), 1000);

    const candidates = barcodes
      .map(candidate => ({
        barcode: candidate,
        extracted: extractBarcodeFields(candidate),
      }))
      .filter(({ barcode, extracted }) =>
        Boolean((barcode.text || '').trim()) &&
        Boolean(extracted.lot || extracted.serial)
      )
      .sort((left, right) => {
        const leftHasLot = left.extracted.lot ? 1 : 0;
        const rightHasLot = right.extracted.lot ? 1 : 0;
        if (leftHasLot !== rightHasLot) return rightHasLot - leftHasLot;
        return (right.barcode.sizeScore || 0) - (left.barcode.sizeScore || 0);
      });

    if (candidates.length === 0) {
      output.textContent = 'Barcode ignored: no batch/lot or serial reference found.';
      output.style.color = 'darkorange';
      scanNextBtn.disabled = false;
      return;
    }

    const { barcode, extracted } = candidates[0];
    const code = (barcode.text || '').trim();
    const format = barcode.format || '';

    if (!code) {
      output.textContent = 'Empty barcode read, skipping.';
      scanNextBtn.disabled = false;
      return;
    }

    const entry = {
      code,
      format,
      count: 1,
      reference: extracted.lot || extracted.serial || '',
      referenceType: extracted.lot ? 'BATCH/LOT' : extracted.serial ? 'SERIAL' : '',
      extracted,
    };
    entry.details = snapshotBarcode(barcode);
    scannedCodes.push(entry);
    addToTable(scannedCodes.length, entry);

    lastScannedCode = code;
    stopScannerHeartbeat(); // Stop heartbeat when returning to table view
    scanningView.classList.add('hidden');
    tableView.classList.remove('hidden');
    scanNextBtn.disabled = false;
    updateViewState();

    console.log('Barcode detected:', { code, format });
  }

  function addToTable(index, entry) {
    addRawRowToTable(entry);
  }

  function snapshotBarcode(value, seen = new WeakSet()) {
    if (value instanceof Uint8Array) return Array.from(value);
    if (ArrayBuffer.isView(value)) return Array.from(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(item => snapshotBarcode(item, seen));
    }

    const snapshot = {};
    Object.keys(value).forEach(key => {
      try {
        snapshot[key] = snapshotBarcode(value[key], seen);
      } catch (error) {
        snapshot[key] = '[Unavailable]';
      }
    });
    return snapshot;
  }

  function extractBarcodeFields(barcode) {
    const fields = (barcode.extractedDocument?.children || []).map(element => {
      const values = {};
      (element.fields || []).forEach(field => {
        const fieldName = field.type?.name || field.type?.normalizedName?.split('.').pop() || '';
        values[fieldName] = field.value?.text || '';
      });
      return values;
    });

    const findField = (applicationIdentifier, titlePattern, descriptionPattern) =>
      fields.find(field =>
        field.ApplicationIdentifier === applicationIdentifier ||
        titlePattern.test(field.DataTitle || '') ||
        descriptionPattern.test(field.ElementDescription || '')
      );

    const lotField = findField('10', /BATCH\/LOT/i, /BATCH OR LOT NUMBER/i);
    const serialField = findField('21', /^SERIAL$/i, /^SERIAL NUMBER$/i);
    const expiryField = fields.find(field =>
      /EXPIR|USE BY|BEST BEFORE/i.test(field.DataTitle || '') ||
      /EXPIR|USE BY|BEST BEFORE/i.test(field.ElementDescription || '')
    );
    const productField = findField('01', /^GTIN$/i, /GLOBAL TRADE ITEM NUMBER/i);

    return {
      fields,
      lot: lotField?.RawValue || '',
      serial: serialField?.RawValue || '',
      expiry: expiryField?.RawValue || '',
      product: productField?.RawValue || '',
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function addRawRowToTable(entry) {
    const existingRow = Array.from(itemTableBody.querySelectorAll('tr'))
      .find(row => row.dataset.reference === entry.reference);

    if (existingRow) {
      const countCell = existingRow.cells[5];
      countCell.textContent = Number(countCell.textContent) + 1;
      output.textContent = `Incremented count for ${entry.referenceType} ${entry.reference}`;
      output.style.color = 'green';
      return;
    }

    // Match the scanned lot/serial against the inventory product items
    // fetched from /api/items (Inventory_Product_line__c records for this
    // account), so SKU/expiry/quantity come from Salesforce instead of a
    // "Pending API" placeholder.
    const matchedItem = entry.reference
      ? inventoryProductItems.find(item =>
          item.lotSerial &&
          item.lotSerial.trim().toUpperCase() === entry.reference.trim().toUpperCase()
        )
      : null;

    const sku = matchedItem?.sku || '';
    const expiry = matchedItem ? formatDate(matchedItem.expiry) : (entry.extracted.expiry || '');
    const quantity = matchedItem ? (Number(matchedItem.quantity) || 0) : 0;
    // Prefer the Lot_Serial_Number__c value returned from the API (matchedItem.lotSerial)
    // for the visible column; fall back to the raw scanned reference if no match was found.
    const lotSerialDisplay = matchedItem?.lotSerial || entry.reference;

    const row = document.createElement('tr');
    row.dataset.reference = entry.reference;
    row.dataset.gtin = entry.extracted.product;
    row.dataset.prds = sku;
    row.innerHTML = `
      <td data-label="#">${itemTableBody.children.length + 1}</td>
      <td data-label="PRDS">${escapeHtml(sku || 'Unknown')}</td>
      <td data-label="Lot/Serial">${escapeHtml(lotSerialDisplay)}</td>
      <td data-label="Expiry Date">${escapeHtml(expiry || 'Unknown')}</td>
      <td data-label="Quantity">${quantity}</td>
      <td data-label="Count">1</td>
    `;
    itemTableBody.appendChild(row);

    if (matchedItem) {
      output.textContent = `Matched ${entry.referenceType} ${entry.reference}: ${sku}`;
      output.style.color = 'green';
    } else {
      output.textContent = `Scanned ${entry.referenceType} ${entry.reference} (no inventory match found)`;
      output.style.color = 'darkorange';
    }
  }

  function formatDate(dateString) {
    if (!dateString) return '';

    // Common Salesforce/ISO date formats (YYYY-MM-DD or full ISO datetime)
    // are reformatted explicitly to avoid timezone shifting.
    const isoLike = String(dateString).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoLike) {
      const [, year, month, day] = isoLike;
      return `${month}/${day}/${year}`;
    }

    // Fallback for other parseable date formats.
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) {
      return String(dateString);
    }

    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    return `${month}/${day}/${year}`;
  }

  verifyAccountBtn.addEventListener('click', verifyAccountNumber);

  startBtn.addEventListener('click', async () => {
    if (!confirmedAccount) {
      output.textContent = 'Please confirm the account before scanning.';
      return;
    }
    tableView.classList.add('hidden');
    scanningView.classList.remove('hidden');
    output.textContent = '📷 Initializing camera...';
    await startScan();
  });

  cancelScanBtn.addEventListener('click', async () => {
    stopScannerHeartbeat();
    if (barcodeScanner) {
      try {
        await barcodeScanner.dispose();
      } catch (e) {
        console.warn('Error disposing scanner on cancel:', e);
      }
      barcodeScanner = null;
    }
    scanningView.classList.add('hidden');
    tableView.classList.remove('hidden');
    output.textContent = 'Scan cancelled.';
    scanCooldown = false;
    updateViewState();
  });

  scanNextBtn.addEventListener('click', () => startScan());

  submitBtn.addEventListener('click', () => {
    if (!confirmedAccount) {
      output.textContent = 'Missing account';
      return;
    }

    const rows = Array.from(itemTableBody.querySelectorAll('tr'));
    const codes = rows.map(row => ({
      sku: row.dataset.prds || '',
      lotSerial: row.querySelector('[data-label="Lot/Serial"]').textContent.trim(),
      expiry: row.querySelector('[data-label="Expiry Date"]').textContent.trim(),
      quantity: row.querySelector('[data-label="Quantity"]').textContent.trim(),
      count: parseInt(row.querySelector('[data-label="Count"]').textContent.trim(), 10) || 0
    }));

    if (codes.length === 0) {
      output.textContent = 'No scanned items to submit';
      return;
    }

    window.pendingSubmission = {
      account: confirmedAccount,
      accountName: confirmedAccountName,
      date: formattedDate,
      codes
    };

    tableSection.classList.add('hidden');
    tableView.classList.add('hidden');
    scanningView.classList.add('hidden');
    confirmationView.classList.remove('hidden');
    output.textContent = '';
  });

  confirmSubmitBtn.addEventListener('click', async () => {
    if (!window.pendingSubmission) return;
    confirmationView.classList.add('hidden');
    tableView.classList.add('hidden');
    scanningView.classList.add('hidden');
    accountSection.classList.add('hidden');

    submissionResultView.classList.remove('hidden');
    submissionMessage.textContent = 'Submitting...';
    submissionMessage.classList.add('text-green-600');

    try {
      const res = await fetch(
        `${API_BASE_URL}/api/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(window.pendingSubmission)
        }
      );
      const data = await res.json();
      if (res.ok) {
        submissionMessage.textContent = 'Table submitted successfully!';
        itemTableBody.innerHTML = '';
        scannedCodes.length = 0;
        confirmedAccount = null;
        confirmedAccountName = null;
        confirmedWarehouseCode = null;
        window.pendingSubmission = null;
      } else {
        submissionMessage.textContent = 'Failed to submit table';
        console.error('Flow error:', data);
      }
    } catch (err) {
      submissionMessage.textContent = 'Network error triggering flow';
      console.error(err);
    }
  });

  cancelSubmitBtn.addEventListener('click', () => {
    confirmationView.classList.add('hidden');
    tableView.classList.remove('hidden');
    output.textContent = 'Submission cancelled';
    window.pendingSubmission = null;
  });

});