document.addEventListener('DOMContentLoaded', async () => {
  // ---- Feature flags ----
  // Set these to `true` later if you want to re-enable account verification
  // and/or live inventory lookups. The original functions are left intact
  // below, they are simply not invoked while these flags are false.
  const FEATURES = {
    accountVerification: false,
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

  const licenseKey =
  "oze+riwtsfpaOqdCCzdgCkYyjEFYPN" +
  "L7C6JhRFE3WGAu8nc2c1v2hj2ga3Bi" +
  "06C+zZBXYGH4g6eMjdYUC59Ghl7opc" +
  "VD2O4bbx9EvmTvWv2CL55J28zO2JeL" +
  "xichG6OBJql4xSU3nYGw679vs+FXUt" +
  "P8+ILJryCkLvs4wXPPg/60NyOcZoDZ" +
  "A7y8sw9ZieWXxNNkN8goSiN1TI6Jg3" +
  "JY8PuiWIxxoMjS4nvQDRBGKcKnrUeb" +
  "U2j2CCas4TQMGoDPZk8lwm7IOM2z7I" +
  "jMjm/ITxSBq+MF+PHaqJCD2lP2up1c" +
  "hqF0DcHXvnS+jSsdpeL+EZQ0U/d4Q0" +
  "cGEcGL4Z6/1w==\nU2NhbmJvdFNESw" +
  "pzY2FubmVyLnZlcnlhbm1lZC5jb218" +
  "bG9jYWxob3N0CjE3OTkwMjA3OTkKNT" +
  "EyCjg=\n";

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

  let formattedDate = today.toISOString().split('T')[0];
  let confirmedAccount = null;
  let confirmedAccountName = null;
  let currentDeviceId = null;
  let lastScannedCode = null;
  let confirmedWarehouseCode = null;
  let scanCooldown = false;
  let inventoryProductItems = [];
  let ids = [];


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

  // Resolves whichever identifier was supplied in the URL into the prefix
  // value (account number or contact email) used to filter inventory
  // product lines, along with a human-readable label for status messages.
  async function resolveInventoryPrefix() {
    if (urlAccountId) {
      const res = await fetch(`${API_BASE_URL}/api/account?id=${encodeURIComponent(urlAccountId)}`);
      const data = await res.json();
      if (!res.ok || !data.found || !data.accountNumber) {
        throw new Error(data.error || `Unable to resolve account id ${urlAccountId}`);
      }
      return { prefix: data.accountNumber, label: data.name || data.accountNumber };
    }
    if (urlContactId) {
      const res = await fetch(`${API_BASE_URL}/api/contact?id=${encodeURIComponent(urlContactId)}`);
      const data = await res.json();
      if (!res.ok || !data.found || !data.email) {
        throw new Error(data.error || `Unable to resolve contact id ${urlContactId}`);
      }
      return { prefix: data.email, label: data.name || data.email };
    }
    if (legacyAccountNumber) {
      return { prefix: legacyAccountNumber, label: legacyAccountNumber };
    }
    return null;
  }

  if (urlAccountId || urlContactId || legacyAccountNumber) {
    // An identifier was supplied via the URL (from the Account page, the
    // Contact page, or a legacy direct-account-number link) - skip the
    // manual entry form entirely and resolve + load inventory straight away.
    const resolvedIdentifier = urlAccountId || urlContactId || legacyAccountNumber;
    confirmedAccount = resolvedIdentifier;
    confirmedAccountName = resolvedIdentifier;
    confirmedWarehouseCode = null;

    accountSection.classList.add('hidden');
    tableView.classList.remove('hidden');
    output.textContent = 'Loading inventory...';

    try {
      const resolved = await resolveInventoryPrefix();
      confirmedAccountName = resolved.label;
      output.textContent = `Loading inventory for ${resolved.label}...`;
      await fetchInventoryProducts(resolved.prefix);
      populateInventoryProductTable();
      output.textContent = `Ready to scan. Loaded ${inventoryProductItems.length} inventory line(s) for ${resolved.label}.`;
    } catch (err) {
      console.error('Error fetching inventory product items:', err);
      output.textContent = `Ready to scan. Failed to load inventory: ${err.message}`;
    }
  } else {
    // No identifier was supplied at all (e.g. the user navigated to the
    // bare scanner URL directly) - show the manual entry form so they can
    // type in either an account number or an email address.
    accountSection.classList.remove('hidden');
    tableView.classList.add('hidden');
  }

  updateViewState();

  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  async function verifyAccountNumber() {
    const input = document.getElementById('accountInput');
    const status = document.getElementById('accountStatus');
    const rawValue = input.value.trim();

    if (!rawValue) {
      status.textContent = 'Please enter an account number or email address.';
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

      const displayName = data.name || rawValue;
      const prefix = isEmail ? data.email : data.accountNumber;

      status.innerHTML = `
        Found: ${displayName} <br/>
        Is this correct? 
        <button id="confirmAccountBtn" class="bg-green-600 text-white px-3 py-1 rounded ml-2">Yes</button>
        <button id="rejectAccountBtn" class="bg-red-600 text-white px-3 py-1 rounded ml-2">No</button>
      `;
      status.style.color = 'green';

      const confirmBtn = status.querySelector('#confirmAccountBtn');
      const rejectBtn = status.querySelector('#rejectAccountBtn');

      confirmBtn.addEventListener('click', async () => {
        confirmedAccount = prefix;
        confirmedAccountName = displayName;
        confirmedWarehouseCode = null;

        output.textContent = 'Loading inventory product items...';

        try {
          await fetchInventoryProducts(prefix);
          await fetchIds();
          populateInventoryProductTable();

          accountSection.classList.add('hidden');
          tableView.classList.remove('hidden');

          output.textContent = `Confirmed: ${displayName}. Ready to scan.`;
          updateViewState();
        } catch (err) {
          console.error("Error fetching inventory product items:", err);
          alert("Failed to load inventory product data. Please try again.");
        }
      });

      rejectBtn.addEventListener('click', () => {
        confirmedAccount = null;
        confirmedAccountName = null;
        confirmedWarehouseCode = null;
        input.value = '';
        status.textContent = 'Please enter the correct account number or email address.';
        status.style.color = 'darkorange';
      });

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
        <td hidden data-label="Lot Number">${escapeHtml(item.lotSerial || '')}</td>
        <td data-label="Lot Number/Serial Number">${escapeHtml(item.lotSerial || '')}</td>
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

  async function startScan() {
    try {
      if (!scanbotSDK) {
        output.textContent = 'Scanbot SDK not ready.';
        return;
      }

      scanningView.classList.remove('hidden');
      tableView.classList.add('hidden');
      output.textContent = 'Starting Scanbot camera...';
      scanNextBtn.disabled = true;

      if (barcodeScanner) {
        try {
          await barcodeScanner.dispose();
        } catch (e) {
          console.warn('Error disposing previous scanner:', e);
        }
        barcodeScanner = null;
      }

      const config = {
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
        // finder: {
        //   visible: true,
        //   style: { _type: "FinderStrokedStyle", strokeColor: "green", strokeWidth: 3 }
        // },
        userGuidance: {
          visible: true,
          title: { text: "Scan item", color: "white" }
        }
      };

      barcodeScanner = await scanbotSDK.createBarcodeScanner(config);
      console.log('Barcode scanner created:', barcodeScanner);

    } catch (err) {
      console.error('Error while starting scanner:', err);
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
      const countCell = existingRow.cells[6];
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
      <td hidden data-label="Lot Number">${escapeHtml(entry.reference)}</td>
      <td data-label="Lot Number/Serial Number">${escapeHtml(lotSerialDisplay)}</td>
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
    const date = new Date(dateString);
    return date.toISOString().split('T')[0];
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
    if (barcodeScanner) await barcodeScanner.dispose();
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
      description: '',
      lot: row.querySelector('[data-label="Lot Number/Serial Number"]').textContent.trim(),
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
      warehouseCode: confirmedWarehouseCode,
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