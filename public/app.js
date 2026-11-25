const state = {
  mode: 'live',
  settings: null,
  sockets: [],
  recentJobs: [],
  scanner: null,
  scannerRunning: false,
  toastTimer: null
};

const titles = {
  dashboard: 'Dashboard',
  'new-job': 'New charge',
  scan: 'Scan & collect',
  history: 'Job history',
  settings: 'Settings'
};

function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  headers.set('X-Data-Mode', state.mode);
  return fetch(path, { ...options, headers }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.replace('/login.html');
      throw new Error('Your staff session has expired. Sign in again.');
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function formatMoney(value) {
  const currency = state.settings?.currency || 'USD';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(value));
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function showToast(message, isError = false) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 3800);
}

function goTo(view) {
  if (!titles[view]) return;
  if (view !== 'scan' && state.scannerRunning) {
    stopScanner().catch((error) => showToast(error.message, true));
  }
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  document.querySelector('#page-title').textContent = titles[view];
  if (view === 'history') loadHistory();
  if (view === 'settings') fillSettings();
  if (view === 'new-job') fillNewJob();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadDashboard() {
  const data = await api('/api/bootstrap');
  state.settings = data.settings;
  state.sockets = data.sockets;
  document.querySelector('#stat-available').textContent = data.counts.available ?? 0;
  document.querySelector('#stat-occupied').textContent = data.counts.occupied ?? 0;
  document.querySelector('#stat-out').textContent = data.counts.outOfService ?? 0;
  renderSockets();
  fillNewJob();
  await loadRecent();
}

function renderSockets() {
  const grid = document.querySelector('#socket-grid');
  grid.replaceChildren();
  for (const socket of state.sockets) {
    const occupied = Boolean(socket.claimCode);
    const out = socket.serviceStatus === 'out_of_service';
    const status = occupied ? 'occupied' : out ? 'out of service' : 'available';
    const button = document.createElement('button');
    button.className = `socket-cell${occupied ? ' occupied' : out ? ' out-of-service' : ''}`;
    button.textContent = socket.number;
    button.title = `Socket ${socket.number}: ${status}${occupied ? ` — ${socket.gadget}` : ''}. Click to manage.`;
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', () => manageSocket(socket));
    grid.append(button);
  }
}

async function manageSocket(socket) {
  if (socket.claimCode) {
    showToast(`Socket ${socket.number} is occupied by ${socket.gadget}. Collect or cancel that job first.`, true);
    return;
  }
  const newStatus = socket.serviceStatus === 'out_of_service' ? 'available' : 'out_of_service';
  const action = newStatus === 'available' ? 'return to service' : 'mark out of service';
  if (!window.confirm(`Socket ${socket.number} is available. ${action[0].toUpperCase()}${action.slice(1)}?`)) return;
  try {
    await api(`/api/sockets/${socket.number}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
    await loadDashboard();
    showToast(`Socket ${socket.number} marked ${newStatus.replaceAll('_', ' ')}.`);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadRecent() {
  const jobs = await api('/api/jobs?status=all');
  state.recentJobs = jobs.slice(0, 5);
  const body = document.querySelector('#recent-jobs');
  body.replaceChildren();
  if (!state.recentJobs.length) {
    body.innerHTML = '<tr><td class="empty-row" colspan="5">No jobs yet. Start your first charge to see it here.</td></tr>';
    return;
  }
  for (const job of state.recentJobs) {
    const row = document.createElement('tr');
    row.innerHTML = `<td class="code-text">${escapeHtml(job.claimCode)}</td><td class="gadget-cell">${escapeHtml(job.gadget)}</td><td>${job.socket}</td><td>${escapeHtml(formatMoney(job.price))}</td><td><span class="status-pill ${job.status}">${job.status}</span></td>`;
    body.append(row);
  }
}

function fillNewJob() {
  if (!state.settings) return;
  const select = document.querySelector('#job-socket');
  const current = select.value;
  select.replaceChildren(new Option('Auto-assign next available', ''));
  state.sockets.filter((socket) => socket.serviceStatus === 'available' && !socket.claimCode)
    .forEach((socket) => select.add(new Option(`Socket ${socket.number}`, String(socket.number))));
  if ([...select.options].some((option) => option.value === current)) select.value = current;
  document.querySelector('#price-currency').textContent = state.settings.currency;
  document.querySelector('#job-price').value = state.settings.basePrice;
  document.querySelector('#job-price').min = state.settings.minimumPrice;
  document.querySelector('#price-hint').textContent = `Minimum ${formatMoney(state.settings.minimumPrice)}.`;
}

function showAssignedSocketCard(job) {
  const root = document.querySelector('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal claim-modal"><h2>Charging job created</h2><p>Socket ${job.socket} is reserved. Give the customer the matching preprinted Socket ${job.socket} card.</p><div class="socket-card-callout"><span class="socket-card-number">${job.socket}</span><div><strong>Use the Socket ${job.socket} QR card</strong><p>Scanning its QR opens the active job at this socket. No new QR is generated.</p></div></div><div class="fallback-code-block"><span>Staff fallback claim code</span><code class="fallback-code"></code><button class="text-button" type="button" data-copy-code>Copy code</button></div><p class="muted tiny">Keep this unique code for manual lookup if the preprinted card is unavailable. Use the physical cards; the source PDF is not hosted online.</p><div class="modal-actions"><button class="button primary" data-close>Done</button></div></div></div>`;
  root.querySelector('.fallback-code').textContent = job.claimCode;
  root.querySelector('[data-close]').addEventListener('click', () => { root.replaceChildren(); });
  root.querySelector('[data-copy-code]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(job.claimCode);
      showToast('Fallback claim code copied.');
    } catch (error) {
      showToast('Could not copy the code. Select and copy it manually.', true);
    }
  });
}

document.querySelector('#new-job-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  const fields = new FormData(form);
  const socket = fields.get('socket');
  try {
    const result = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        customer: fields.get('customer'),
        gadget: fields.get('gadget'),
        socket: socket || null,
        price: fields.get('price'),
        notes: fields.get('notes')
      })
    });
    form.reset();
    await loadDashboard();
    goTo('dashboard');
    showAssignedSocketCard(result.job);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

async function lookupJob(code) {
  if (!code.trim()) {
    showToast('Enter or scan a claim code.', true);
    return;
  }
  try {
    const result = await api(`/api/jobs/${encodeURIComponent(code.trim())}`);
    renderCollection(result.job);
  } catch (error) {
    document.querySelector('#collection-result').replaceChildren();
    showToast(error.message, true);
  }
}

function socketFromQr(payload) {
  const match = String(payload).match(/Charging\s+Port\s*\(\s*(\d{1,2})\s*\)/i);
  if (!match) return null;
  const number = Number(match[1]);
  return number >= 1 && number <= 60 ? number : null;
}

async function lookupSocket(number) {
  try {
    const result = await api(`/api/sockets/${number}/job`);
    renderCollection(result.job);
  } catch (error) {
    document.querySelector('#collection-result').replaceChildren();
    showToast(error.message, true);
  }
}

function lookupScannedValue(value) {
  const socketNumber = socketFromQr(value);
  if (socketNumber !== null) {
    lookupSocket(socketNumber);
  } else {
    lookupJob(value);
  }
}

function renderCollection(job) {
  const result = document.querySelector('#collection-result');
  const statusText = job.status === 'active' ? 'Awaiting collection' : job.status;
  result.innerHTML = `<article class="panel job-detail"><div class="job-detail-header"><div><h2>${escapeHtml(job.gadget)}</h2><p class="muted">Claim ${escapeHtml(job.claimCode)}</p></div><span class="status-pill ${job.status}">${escapeHtml(statusText)}</span></div><div class="job-detail-grid"><div class="detail-item"><small>Customer</small><strong>${escapeHtml(job.customer)}</strong></div><div class="detail-item"><small>Socket</small><strong>${job.socket}</strong></div><div class="detail-item"><small>Price due</small><strong>${escapeHtml(formatMoney(job.price))}</strong></div><div class="detail-item"><small>Checked in</small><strong>${escapeHtml(formatDate(job.createdAt))}</strong></div><div class="detail-item"><small>Notes</small><strong>${escapeHtml(job.notes || '—')}</strong></div>${job.status === 'collected' ? `<div class="detail-item"><small>Payment recorded</small><strong>${escapeHtml(job.paymentMethod)} · ${escapeHtml(formatMoney(job.amountPaid))}</strong></div>` : ''}</div>${job.status === 'active' ? `<form class="collect-form"><div class="section-title"><span class="step-number">✓</span><div><h2>Confirm payment & collection</h2><p class="muted">Match the gadget before releasing it.</p></div></div><label class="confirm-row"><input type="checkbox" name="gadgetConfirmed" required><span>I confirm the gadget matches the customer’s claim.</span></label><div class="field-grid"><label class="field"><span>Payment method</span><select name="paymentMethod" required>${state.settings.paymentMethods.map((method) => `<option value="${escapeHtml(method)}">${escapeHtml(method)}</option>`).join('')}</select></label><label class="field"><span>Amount paid (${escapeHtml(state.settings.currency)})</span><input name="amountPaid" type="number" min="${Number(job.price)}" step="0.01" value="${Number(job.price).toFixed(2)}" required></label></div><div class="job-actions"><button class="button primary" type="submit">Confirm & collect</button><button class="button danger" type="button" data-cancel>Cancel job</button></div></form>` : ''}</article>`;
  if (job.status !== 'active') return;
  result.querySelector('.collect-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const response = await api(`/api/jobs/${encodeURIComponent(job.claimCode)}/collect`, {
        method: 'POST',
        body: JSON.stringify({
          gadgetConfirmed: data.get('gadgetConfirmed') === 'on',
          paymentMethod: data.get('paymentMethod'),
          amountPaid: data.get('amountPaid')
        })
      });
      renderCollection(response.job);
      await loadDashboard();
      showToast('Payment recorded and gadget marked collected.');
    } catch (error) {
      showToast(error.message, true);
      submit.disabled = false;
    }
  });
  result.querySelector('[data-cancel]').addEventListener('click', () => confirmCancel(job));
}

function confirmCancel(job) {
  const root = document.querySelector('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal"><h2>Cancel this charging job?</h2><p><strong>${escapeHtml(job.gadget)}</strong> on socket ${job.socket} will be marked cancelled and the socket made available. This cannot be undone.</p><div class="modal-actions"><button class="button secondary" data-dismiss>Keep job</button><button class="button danger" data-confirm>Cancel job</button></div></div></div>`;
  root.querySelector('[data-dismiss]').addEventListener('click', () => root.replaceChildren());
  root.querySelector('[data-confirm]').addEventListener('click', async () => {
    try {
      await api(`/api/jobs/${encodeURIComponent(job.claimCode)}/cancel`, { method: 'POST', body: '{}' });
      root.replaceChildren();
      document.querySelector('#collection-result').replaceChildren();
      await loadDashboard();
      showToast('Job cancelled. Socket is available again.');
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

document.querySelector('#lookup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  lookupScannedValue(new FormData(event.currentTarget).get('claimCode'));
});

async function startScanner() {
  if (!window.Html5Qrcode) {
    showToast('QR scanner is unavailable. Use manual claim-code entry.', true);
    return;
  }
  try {
    if (!state.scanner) state.scanner = new Html5Qrcode('qr-reader');
    const cameras = await Html5Qrcode.getCameras();
    if (!cameras.length) throw new Error('No camera was found on this device.');
    const camera = cameras.find((item) => /back|rear|environment/i.test(item.label)) || cameras[0];
    await state.scanner.start(camera.id, { fps: 10, qrbox: { width: 220, height: 220 } }, (decodedText) => {
      stopScanner().catch((error) => showToast(error.message, true));
      document.querySelector('#lookup-form [name=claimCode]').value = decodedText;
      lookupScannedValue(decodedText);
    });
    state.scannerRunning = true;
    document.querySelector('#camera-start').classList.add('hidden');
    document.querySelector('#camera-stop').classList.remove('hidden');
    document.querySelector('#camera-status').textContent = 'Camera is active. Point it at a claim code.';
  } catch (error) {
    showToast(error.message || 'Could not start the camera. Check browser permissions.', true);
  }
}

async function stopScanner() {
  if (state.scanner && state.scannerRunning) {
    await state.scanner.stop();
    state.scannerRunning = false;
  }
  document.querySelector('#camera-start').classList.remove('hidden');
  document.querySelector('#camera-stop').classList.add('hidden');
  document.querySelector('#camera-status').textContent = 'Camera works on localhost or a secure HTTPS connection.';
}
document.querySelector('#camera-start').addEventListener('click', startScanner);
document.querySelector('#camera-stop').addEventListener('click', stopScanner);

async function loadHistory() {
  const status = document.querySelector('#history-status').value;
  const search = document.querySelector('#history-search').value;
  try {
    const jobs = await api(`/api/jobs?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`);
    const body = document.querySelector('#history-jobs');
    body.replaceChildren();
    if (!jobs.length) {
      body.innerHTML = '<tr><td class="empty-row" colspan="8">No matching jobs found.</td></tr>';
      return;
    }
    for (const job of jobs) {
      const row = document.createElement('tr');
      row.innerHTML = `<td class="code-text">${escapeHtml(job.claimCode)}</td><td>${escapeHtml(job.customer)}</td><td class="gadget-cell">${escapeHtml(job.gadget)}</td><td>${job.socket}</td><td>${escapeHtml(formatMoney(job.price))}</td><td>${escapeHtml(formatDate(job.createdAt))}</td><td><span class="status-pill ${job.status}">${job.status}</span></td><td>${job.status === 'active' ? '<button class="text-button lookup-history">Open</button>' : ''}</td>`;
      row.querySelector('.lookup-history')?.addEventListener('click', () => {
        goTo('scan');
        document.querySelector('#lookup-form [name=claimCode]').value = job.claimCode;
        lookupJob(job.claimCode);
      });
      body.append(row);
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

let searchTimer;
document.querySelector('#history-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadHistory, 220);
});
document.querySelector('#history-status').addEventListener('change', loadHistory);

function fillSettings() {
  if (!state.settings) return;
  const form = document.querySelector('#settings-form');
  form.elements.businessName.value = state.settings.businessName;
  form.elements.currency.value = state.settings.currency;
  form.elements.basePrice.value = state.settings.basePrice;
  form.elements.minimumPrice.value = state.settings.minimumPrice;
  form.elements.paymentMethods.value = state.settings.paymentMethods.join('\n');
}

document.querySelector('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const methods = form.elements.paymentMethods.value.split('\n').map((method) => method.trim()).filter(Boolean);
  const message = document.querySelector('#settings-message');
  try {
    state.settings = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        businessName: form.elements.businessName.value,
        currency: form.elements.currency.value.toUpperCase(),
        basePrice: form.elements.basePrice.value,
        minimumPrice: form.elements.minimumPrice.value,
        paymentMethods: methods
      })
    });
    message.textContent = 'Settings saved.';
    fillNewJob();
    showToast('Settings saved.');
  } catch (error) {
    message.textContent = '';
    showToast(error.message, true);
  }
});

document.querySelectorAll('.nav-link').forEach((button) => button.addEventListener('click', () => goTo(button.dataset.view)));
document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => goTo(button.dataset.go)));
document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
    window.location.replace('/login.html');
  } catch (error) {
    showToast(error.message, true);
  }
});
document.querySelector('#demo-mode').addEventListener('change', async (event) => {
  await stopScanner();
  state.mode = event.target.checked ? 'demo' : 'live';
  document.querySelector('#collection-result').replaceChildren();
  document.querySelector('#settings-message').textContent = '';
  try {
    await loadDashboard();
    if (document.querySelector('#view-settings').classList.contains('active')) fillSettings();
    if (document.querySelector('#view-history').classList.contains('active')) loadHistory();
    showToast(state.mode === 'demo' ? 'Demo mode on. Sample data is separate from live records.' : 'Live mode on.');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
loadDashboard().catch((error) => showToast(error.message, true));
