require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const store = require('./store');

const app = express();
const port = Number(process.env.PORT) || 3000;
const staffPassword = process.env.STAFF_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET;
if (!staffPassword || staffPassword.length < 16) {
  throw new Error('Set STAFF_PASSWORD to a passphrase of at least 16 characters before starting the server.');
}
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('Set SESSION_SECRET to a random secret of at least 32 characters before starting the server.');
}
const staffPasswordDigest = crypto.createHash('sha256').update(staffPassword).digest();
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const publicDirectory = path.join(__dirname, 'public');

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production' || process.env.VERCEL) app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

function getCookie(req, name) {
  const cookies = req.get('cookie') || '';
  for (const pair of cookies.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return '';
}

function makeSessionToken() {
  const payload = Buffer.from(`${Date.now() + sessionLifetimeMs}.${crypto.randomBytes(24).toString('base64url')}`)
    .toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function isValidSessionToken(token) {
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) return false;
  const expected = crypto.createHmac('sha256', sessionSecret).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], 'hex');
  if (!crypto.timingSafeEqual(expected, supplied)) return false;
  try {
    const payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    const expiresAt = Number(payload.slice(0, payload.indexOf('.')));
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  } catch {
    return false;
  }
}

function requireStaff(req, res, next) {
  if (isValidSessionToken(getCookie(req, 'charging_session'))) {
    res.set('Cache-Control', 'no-store');
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Your staff session has expired. Sign in again.' });
  return res.redirect('/login.html');
}

function getMode(req) {
  const mode = req.get('x-data-mode') || 'live';
  if (mode !== 'live' && mode !== 'demo') {
    const error = new Error('Invalid data mode.');
    error.status = 400;
    throw error;
  }
  return mode;
}

function validText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

app.get('/healthz', async (req, res, next) => {
  try {
    await store.initialize();
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
});
app.get('/login.html', (req, res) => res.sendFile(path.join(publicDirectory, 'login.html')));
app.get('/login.css', (req, res) => res.sendFile(path.join(publicDirectory, 'login.css')));
app.get('/login.js', (req, res) => res.sendFile(path.join(publicDirectory, 'login.js')));

app.use('/api', async (req, res, next) => {
  try {
    await store.initialize();
    next();
  } catch (error) {
    next(error);
  }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (await store.isLoginLimited(ip)) {
      return fail(res, 429, 'Too many sign-in attempts. Try again in 15 minutes.');
    }

    const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
    const suppliedDigest = crypto.createHash('sha256').update(supplied).digest();
    if (!crypto.timingSafeEqual(staffPasswordDigest, suppliedDigest)) {
      await store.recordFailedLogin(ip);
      return fail(res, 401, 'That passphrase is not correct.');
    }

    await store.clearLoginFailures(ip);
    res.cookie('charging_session', makeSessionToken(), {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'strict',
      path: '/',
      maxAge: sessionLifetimeMs
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', requireStaff, (req, res) => {
  res.clearCookie('charging_session', {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'strict',
    path: '/'
  });
  res.json({ ok: true });
});

app.use(requireStaff);
app.use('/vendor/html5-qrcode.min.js', express.static(path.join(__dirname, 'node_modules', 'html5-qrcode', 'html5-qrcode.min.js')));
app.use(express.static(publicDirectory, { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(publicDirectory, 'index.html')));

app.get('/api/bootstrap', async (req, res, next) => {
  try {
    res.json(await store.bootstrap(getMode(req)));
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'all');
    const search = String(req.query.search || '').trim().slice(0, 100);
    if (!['all', 'active', 'collected', 'cancelled'].includes(status)) {
      return fail(res, 400, 'Choose a valid history filter.');
    }
    res.json(await store.listJobs(getMode(req), status, search));
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs/:claimCode', async (req, res, next) => {
  try {
    const job = await store.jobByCode(getMode(req), req.params.claimCode);
    if (!job) return fail(res, 404, 'No job was found for that claim code.');
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sockets/:number/job', async (req, res, next) => {
  try {
    const number = Number(req.params.number);
    if (!Number.isInteger(number) || number < 1 || number > 60) {
      return fail(res, 400, 'Choose a socket between 1 and 60.');
    }
    const job = await store.jobBySocket(getMode(req), number);
    if (!job) return fail(res, 404, `No active job is assigned to socket ${number}.`);
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.post('/api/jobs', async (req, res, next) => {
  try {
    const mode = getMode(req);
    const { customer, gadget, socket, price, notes = '' } = req.body || {};
    if (!validText(customer, 100)) return fail(res, 400, 'Enter a customer name or reference (up to 100 characters).');
    if (!validText(gadget, 120)) return fail(res, 400, 'Enter a gadget description (up to 120 characters).');
    if (typeof notes !== 'string' || notes.length > 500) return fail(res, 400, 'Notes must be 500 characters or fewer.');
    const numericPrice = Number(price);
    const settings = await store.getSettings(mode);
    if (!Number.isFinite(numericPrice) || numericPrice < settings.minimumPrice || numericPrice > 1_000_000) {
      return fail(res, 400, `Price must be at least ${settings.minimumPrice} ${settings.currency}.`);
    }
    const socketNumber = socket === null || socket === '' || socket === undefined ? null : Number(socket);
    if (socketNumber !== null && (!Number.isInteger(socketNumber) || socketNumber < 1 || socketNumber > 60)) {
      return fail(res, 400, 'Choose a socket between 1 and 60.');
    }
    const job = await store.createJob(mode, {
      customer: customer.trim(),
      gadget: gadget.trim(),
      socket: socketNumber,
      price: numericPrice,
      notes: notes.trim()
    });
    res.status(201).json({ job });
  } catch (error) {
    next(error);
  }
});

app.post('/api/jobs/:claimCode/collect', async (req, res, next) => {
  try {
    const mode = getMode(req);
    const job = await store.jobByCode(mode, req.params.claimCode);
    if (!job) return fail(res, 404, 'No job was found for that claim code.');
    if (job.status !== 'active') return fail(res, 409, `This job is already ${job.status}.`);
    const { paymentMethod, amountPaid, gadgetConfirmed } = req.body || {};
    const settings = await store.getSettings(mode);
    const paid = Number(amountPaid);
    if (gadgetConfirmed !== true) return fail(res, 400, 'Confirm the matching gadget before collection.');
    if (!settings.paymentMethods.includes(paymentMethod)) return fail(res, 400, 'Choose a payment method from Settings.');
    if (!Number.isFinite(paid) || paid < job.price || paid > 1_000_000) {
      return fail(res, 400, `Amount paid must be at least ${job.price.toFixed(2)} ${settings.currency}.`);
    }
    const collected = await store.collectJob(mode, job, paymentMethod, paid);
    if (!collected) return fail(res, 409, 'This job has already changed. Refresh and try again.');
    res.json({ job: collected });
  } catch (error) {
    next(error);
  }
});

app.post('/api/jobs/:claimCode/cancel', async (req, res, next) => {
  try {
    const mode = getMode(req);
    const job = await store.jobByCode(mode, req.params.claimCode);
    if (!job) return fail(res, 404, 'No job was found for that claim code.');
    if (job.status !== 'active') return fail(res, 409, `Only active jobs can be cancelled; this job is ${job.status}.`);
    const cancelled = await store.cancelJob(mode, job);
    if (!cancelled) return fail(res, 409, 'This job has already changed. Refresh and try again.');
    res.json({ job: cancelled });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/sockets/:number', async (req, res, next) => {
  try {
    const number = Number(req.params.number);
    const { status } = req.body || {};
    if (!Number.isInteger(number) || number < 1 || number > 60) return fail(res, 400, 'Choose a socket between 1 and 60.');
    if (!['available', 'out_of_service'].includes(status)) return fail(res, 400, 'Choose available or out of service.');
    res.json(await store.setSocketStatus(getMode(req), number, status));
  } catch (error) {
    next(error);
  }
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const { businessName, currency, basePrice, minimumPrice, paymentMethods } = req.body || {};
    if (!validText(businessName, 80)) return fail(res, 400, 'Business name is required and must be 80 characters or fewer.');
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return fail(res, 400, 'Currency must be a 3-letter code, such as USD or EUR.');
    const base = Number(basePrice);
    const minimum = Number(minimumPrice);
    if (!Number.isFinite(base) || !Number.isFinite(minimum) || base < 0 || minimum < 0 || base > 1_000_000 || minimum > 1_000_000) {
      return fail(res, 400, 'Base price and minimum price must be valid non-negative amounts.');
    }
    if (base < minimum) return fail(res, 400, 'Default price must be at least the minimum allowed price.');
    if (!Array.isArray(paymentMethods) || paymentMethods.length < 1 || paymentMethods.length > 8 ||
        paymentMethods.some((method) => !validText(method, 40)) ||
        new Set(paymentMethods.map((method) => method.trim().toLowerCase())).size !== paymentMethods.length) {
      return fail(res, 400, 'Add 1–8 distinct payment methods, each 40 characters or fewer.');
    }
    res.json(await store.saveSettings(getMode(req), {
      businessName: businessName.trim(),
      currency,
      basePrice: base,
      minimumPrice: minimum,
      paymentMethods: paymentMethods.map((method) => method.trim())
    }));
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(error);
  res.status(error.status || 500).json({
    error: error.status ? error.message : 'Something went wrong. Check the server log and try again.'
  });
});

if (!process.env.VERCEL) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Charging Desk running at http://localhost:${port}`);
    console.log(store.postgres ? 'Using PostgreSQL database.' : 'SQLite files stored locally.');
  });
}

module.exports = app;
