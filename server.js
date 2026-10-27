const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dotenv = require('dotenv');
const express = require('express');
const rateLimit = require('express-rate-limit');
const session = require('express-session');

dotenv.config();

const {
  isSupabaseConfigured,
  fetchAllInternsFromSupabase,
  fetchSingleInternFromSupabase,
  insertSingleInternInSupabase,
  updateSingleInternInSupabase,
  deleteSingleInternFromSupabase,
  syncInternsToSupabase
} = require('./supabaseClient');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME?.trim();
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH?.trim();
const SESSION_SECRET = process.env.SESSION_SECRET?.trim();
const passwordHashParts = ADMIN_PASSWORD_HASH?.split(':') ?? [];
const validPasswordHash = passwordHashParts.length === 2 &&
  /^[a-f0-9]{32}$/i.test(passwordHashParts[0]) &&
  /^[a-f0-9]{128}$/i.test(passwordHashParts[1]);

if (!ADMIN_USERNAME || !validPasswordHash || !SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('Configure ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and a 32-character SESSION_SECRET in .env.');
}

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const loginPage = path.join(__dirname, 'login.html');
const internHubPage = path.join(__dirname, 'index.html');
const profilePage = path.join(__dirname, 'profile.html');
const dataDirectory = path.resolve(process.env.INTERNHUB_DATA_DIR || path.join(__dirname, 'data'));
const internsFile = path.join(dataDirectory, 'interns.json');
const seedInternsFile = path.join(__dirname, 'data', 'seed-interns.json');

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use('/api/interns', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '50kb' }));
app.use(['/assets', '/profile/assets'], express.static(path.join(__dirname, 'assets'), { maxAge: '7d' }));

// Security Headers
app.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  next();
});

// Session Middleware
app.use(session({
  name: 'internhub.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 4 * 60 * 60 * 1000 // 4 hours
  }
}));

function sendLoginPage(res, errorCode = '') {
  const errors = {
    invalid: ['Incorrect username or password.', 401],
    limited: ['Too many login attempts. Please wait 15 minutes and try again.', 429]
  };
  const [message, status] = errors[errorCode] || ['', 200];
  fs.readFile(loginPage, 'utf8', (error, html) => {
    if (error) {
      console.error('Login page could not be read.', error);
      res.status(500).send('Login page is unavailable.');
      return;
    }
    const errorMarkup = message ? `<p class="error" role="alert" id="authErrorMsg">${message}</p>` : '';
    res.status(status).type('html').send(html.replace('<!--LOGIN_ERROR-->', errorMarkup));
  });
}

function isValidCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  const usernameMatches = username === ADMIN_USERNAME;
  const [salt, encodedHash] = passwordHashParts;
  try {
    const suppliedHash = crypto.scryptSync(password, salt, 64);
    const expectedHash = Buffer.from(encodedHash, 'hex');
    if (suppliedHash.length !== expectedHash.length) return false;
    const passwordMatches = crypto.timingSafeEqual(suppliedHash, expectedHash);
    return usernameMatches && passwordMatches;
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (req.session?.authenticated === true) {
    next();
    return;
  }
  res.redirect('/login');
}

function requireAdminApi(req, res, next) {
  if (req.session?.authenticated === true) {
    next();
    return;
  }
  res.status(401).json({ error: 'Administrator login required.' });
}

function deriveGrade(score) {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'E';
}

const RUBRIC_CATEGORIES = [
  { key: 'technical', weight: 0.25 },
  { key: 'projectQuality', weight: 0.25 },
  { key: 'problemSolving', weight: 0.20 },
  { key: 'taskCompletion', weight: 0.15 },
  { key: 'communication', weight: 0.10 },
  { key: 'teamwork', weight: 0.05 }
];

function normalizeSingleIntern(intern) {
  if (!intern || typeof intern !== 'object' || Array.isArray(intern)) return null;

  const text = (key, maximum, required = false) => {
    if (typeof intern[key] !== 'string') return required ? null : '';
    const value = intern[key].trim();
    return required && !value ? null : value.slice(0, maximum);
  };

  const id = text('id', 100, true);
  const name = text('name', 100, true);
  const college = text('college', 120, true);
  const domain = text('domain', 100, true);
  const role = text('role', 120, true);

  if (!id || !name || !college || !domain || !role) return null;

  const days = Number(intern.days ?? 0);
  const total = Number(intern.total ?? 90);
  if (!Number.isInteger(days) || !Number.isInteger(total) || days < 0 || total < 1 || days > total) {
    return null;
  }

  const inputMarks = intern.marks && typeof intern.marks === 'object' ? intern.marks : {};
  const marks = {};
  let weightedTotal = 0;
  let hasValidMarks = true;

  for (const { key, weight } of RUBRIC_CATEGORIES) {
    const mark = Number(inputMarks[key] ?? intern.score ?? 0);
    if (!Number.isFinite(mark) || mark < 0 || mark > 100) {
      hasValidMarks = false;
      break;
    }
    marks[key] = mark;
    weightedTotal += mark * weight;
  }

  if (!hasValidMarks) return null;

  const calculatedScore = Math.round(weightedTotal * 10) / 10;
  const score = Number.isFinite(Number(intern.score)) && Number(intern.score) >= 0 && Number(intern.score) <= 100
    ? Math.round(Number(intern.score) * 10) / 10
    : calculatedScore;

  const grade = text('grade', 10) || deriveGrade(score);

  const skills = Array.isArray(intern.skills) && intern.skills.length <= 100 &&
    intern.skills.every(skill => typeof skill === 'string' && skill.length <= 200)
    ? intern.skills.map(skill => skill.trim()).filter(Boolean)
    : [];

  const photo = text('photo', 1_500_000);
  const qrImage = text('qrImage', 1_500_000);
  const rawGithub = text('github', 250);

  let safeGithub = '';
  if (rawGithub) {
    const cleanGithub = rawGithub.startsWith('http://') || rawGithub.startsWith('https://')
      ? rawGithub
      : `https://github.com/${rawGithub.replace(/^@/, '')}`;
    try {
      const parsed = new URL(cleanGithub);
      if (['http:', 'https:'].includes(parsed.protocol)) safeGithub = parsed.href;
    } catch {
      safeGithub = '';
    }
  }

  if (photo && !/^https?:\/\//i.test(photo) && !/^data:image\/(?:jpeg|png|webp);base64,/i.test(photo)) {
    return null;
  }
  if (qrImage && !/^data:image\/(?:jpeg|png|webp);base64,/i.test(qrImage)) {
    return null;
  }

  return {
    ...intern,
    id,
    name,
    college,
    domain,
    role,
    days,
    total,
    score,
    grade,
    status: intern.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
    mentorName: text('mentorName', 100),
    mentorId: text('mentorId', 100),
    mentorReview: text('mentorReview', 2000),
    evaluation: text('evaluation', 2000),
    project: text('project', 160),
    description: text('description', 500),
    github: safeGithub,
    photo: photo || '',
    qrImage: qrImage || '',
    skills,
    marks
  };
}

function normalizeInternRecords(records) {
  if (!Array.isArray(records) || records.length > 5000) return null;
  const seenIds = new Set();
  const normalized = [];

  for (const raw of records) {
    const item = normalizeSingleIntern(raw);
    if (!item || seenIds.has(item.id.toLowerCase())) return null;
    seenIds.add(item.id.toLowerCase());
    normalized.push(item);
  }
  return normalized;
}

// Local File Persistence with Atomic Writes
async function readLocalInternDataset() {
  try {
    const raw = await fs.promises.readFile(internsFile, 'utf8');
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    const rawList = Array.isArray(data) ? data : data?.students;
    let records = rawList ? normalizeInternRecords(rawList) : null;
    if (!records) {
      console.warn('[InternHub] Persisted dataset missing or invalid. Attempting recovery from seed...');
      try {
        const seedRaw = await fs.promises.readFile(seedInternsFile, 'utf8');
        const seedData = JSON.parse(seedRaw);
        const seedList = Array.isArray(seedData) ? seedData : seedData?.students;
        records = normalizeInternRecords(seedList);
        if (records && records.length > 0) {
          await writeLocalInternDataset(records);
          console.log(`[InternHub] Successfully recovered dataset from seed with ${records.length} records.`);
        }
      } catch (recoveryErr) {
        console.warn('[InternHub] Recovery from seed failed:', recoveryErr.message);
      }
    }
    if (!records) throw new Error('The persisted intern dataset has an invalid format.');
    return records;
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        const seedRaw = await fs.promises.readFile(seedInternsFile, 'utf8');
        const seedData = JSON.parse(seedRaw);
        const seedList = Array.isArray(seedData) ? seedData : seedData?.students;
        const seedRecords = normalizeInternRecords(seedList);
        if (seedRecords && seedRecords.length > 0) {
          await writeLocalInternDataset(seedRecords);
          console.log(`[InternHub] Auto-initialized dataset from seed with ${seedRecords.length} records.`);
          return seedRecords;
        }
      } catch (seedError) {
        if (seedError.code !== 'ENOENT') {
          console.warn('[InternHub] Could not load seed dataset:', seedError.message);
        }
      }
      return [];
    }
    throw error;
  }
}

let datasetWriteQueue = Promise.resolve();

function writeLocalInternDataset(records) {
  const save = async () => {
    await fs.promises.mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${internsFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.promises.writeFile(
        temporaryFile,
        `${JSON.stringify({ version: 1, students: records }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
      await fs.promises.rename(temporaryFile, internsFile);
    } catch (error) {
      await fs.promises.rm(temporaryFile, { force: true }).catch(cleanupError => {
        console.error('Temporary dataset file could not be cleaned up.', cleanupError);
      });
      throw error;
    }
  };

  const result = datasetWriteQueue.then(save);
  datasetWriteQueue = result.catch(error => {
    console.error('Intern dataset could not be saved locally.', error);
  });
  return result;
}

// Unified Read / Write Dual Storage Orchestrator
async function readInternDataset() {
  if (isSupabaseConfigured()) {
    try {
      const supabaseRecords = await fetchAllInternsFromSupabase();
      if (Array.isArray(supabaseRecords) && supabaseRecords.length > 0) {
        const normalized = normalizeInternRecords(supabaseRecords);
        if (normalized && normalized.length > 0) {
          writeLocalInternDataset(normalized).catch(() => {});
          return normalized;
        }
      } else if (Array.isArray(supabaseRecords) && supabaseRecords.length === 0) {
        console.log('[InternHub] Supabase table "interns" is empty. Auto-seeding existing records...');
        const localRecords = await readLocalInternDataset();
        if (localRecords && localRecords.length > 0) {
          await syncInternsToSupabase(localRecords).catch(e => {
            console.warn('[InternHub] Auto-seed to Supabase notice:', e.message);
          });
          return localRecords;
        }
      }
    } catch (supabaseError) {
      console.warn('[InternHub] Supabase read failed, falling back to local file:', supabaseError.message);
    }
  }
  return await readLocalInternDataset();
}

async function writeInternDataset(records) {
  const localResult = await writeLocalInternDataset(records);
  if (isSupabaseConfigured()) {
    try {
      await syncInternsToSupabase(records);
      console.log(`[InternHub] Successfully synchronized ${records.length} records to Supabase.`);
    } catch (supabaseError) {
      console.error('[InternHub] Supabase batch synchronization failed:', supabaseError.message);
    }
  }
  return localResult;
}

// Public Profile Filtering (Security: do not leak admin notes or unapproved internal state)
function normalizePublicProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const stringField = (key, limit) => typeof input[key] === 'string' ? input[key].trim().slice(0, limit) : '';

  const id = stringField('id', 100);
  const name = stringField('name', 100);
  const college = stringField('college', 120);
  const domain = stringField('domain', 100);
  const role = stringField('role', 120);
  const score = Number(input.score);

  if (!id || !name || !college || !domain || !role || !Number.isFinite(score) || score < 0 || score > 100) {
    return null;
  }

  const photo = stringField('photo', 1_500_000);
  let safePhoto = '';
  if (photo) {
    if (/^data:image\/(?:jpeg|png|webp);base64,/i.test(photo)) {
      safePhoto = photo;
    } else {
      try {
        if (['http:', 'https:'].includes(new URL(photo).protocol)) safePhoto = photo;
      } catch {
        safePhoto = '';
      }
    }
  }

  const qrImage = stringField('qrImage', 1_500_000);
  const safeQrImage = /^data:image\/(?:jpeg|png|webp);base64,/i.test(qrImage) ? qrImage : '';

  const skills = Array.isArray(input.skills)
    ? input.skills.filter(s => typeof s === 'string').slice(0, 25).map(s => s.trim().slice(0, 60)).filter(Boolean)
    : [];

  const roundedScore = Math.round(score * 10) / 10;
  const grade = stringField('grade', 10) || deriveGrade(roundedScore);

  const marksInput = input.marks && typeof input.marks === 'object' ? input.marks : {};
  const marks = {};
  for (const { key } of RUBRIC_CATEGORIES) {
    const mark = Number(marksInput[key] ?? roundedScore);
    marks[key] = Number.isFinite(mark) && mark >= 0 && mark <= 100 ? mark : roundedScore;
  }

  const days = Number.isInteger(Number(input.days)) && Number(input.days) >= 0 ? Number(input.days) : 0;
  const total = Number.isInteger(Number(input.total)) && Number(input.total) >= 1 ? Number(input.total) : 90;

  const rawGithub = stringField('github', 250);
  let safeGithub = '';
  if (rawGithub) {
    const cleanGithub = rawGithub.startsWith('http://') || rawGithub.startsWith('https://')
      ? rawGithub
      : `https://github.com/${rawGithub.replace(/^@/, '')}`;
    try {
      const parsed = new URL(cleanGithub);
      if (['http:', 'https:'].includes(parsed.protocol)) safeGithub = parsed.href;
    } catch {
      safeGithub = '';
    }
  }

  return {
    id,
    name,
    college,
    domain,
    role,
    days,
    total,
    score: roundedScore,
    grade,
    status: input.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
    project: stringField('project', 160),
    description: stringField('description', 500),
    mentorReview: stringField('mentorReview', 2000),
    github: safeGithub,
    skills,
    marks,
    photo: safePhoto,
    qrImage: safeQrImage
  };
}

// Cryptographically Signed Profile Tokens for QR verification
function createProfileToken(profile) {
  const payloadData = {
    ...profile,
    exp: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days expiration
  };
  const payload = Buffer.from(JSON.stringify(payloadData)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function readProfileToken(token) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !/^[a-f0-9]{64}$/i.test(signature)) return null;

  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  try {
    const profile = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string' || typeof profile.name !== 'string') {
      return null;
    }
    if (profile.exp && typeof profile.exp === 'number' && Date.now() > profile.exp) {
      console.warn('[ProfileToken] Expired token received for id:', profile.id);
      return null;
    }
    return profile;
  } catch {
    return null;
  }
}

async function findPublicProfile(identifier) {
  if (typeof identifier !== 'string') return null;
  const decoded = decodeURIComponent(identifier).trim();
  if (!decoded) return null;

  // 1. Try finding directly from Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      const intern = await fetchSingleInternFromSupabase(decoded);
      if (intern) {
        return normalizePublicProfile(intern);
      }
    } catch (err) {
      console.warn('[InternHub] Supabase profile lookup notice:', err.message);
    }
  }

  // 2. Query dataset for matching ID
  try {
    const dataset = await readInternDataset();
    if (Array.isArray(dataset)) {
      const intern = dataset.find(item => item.id.toLowerCase() === decoded.toLowerCase());
      if (intern) {
        return normalizePublicProfile(intern);
      }
    }
  } catch (error) {
    console.error('Could not query dataset for public profile.', error);
  }

  // 3. Fall back to signed profile token
  const tokenProfile = readProfileToken(decoded);
  if (tokenProfile) {
    return normalizePublicProfile(tokenProfile);
  }

  return null;
}

function getLocalNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Authentication Rate Limiting: 5 attempts per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => sendLoginPage(res, 'limited')
});

// Authentication Routes
app.get('/login', (req, res) => {
  if (req.session?.authenticated === true) {
    res.redirect('/');
    return;
  }
  sendLoginPage(res);
});

app.post('/login', loginLimiter, (req, res, next) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (username.length > 254 || password.length > 256 || !isValidCredentials(username, password)) {
    sendLoginPage(res, 'invalid');
    return;
  }

  req.session.regenerate(error => {
    if (error) {
      next(error);
      return;
    }
    req.session.authenticated = true;
    req.session.save(saveError => {
      if (saveError) {
        next(saveError);
        return;
      }
      res.redirect('/');
    });
  });
});

app.post('/logout', requireAdmin, (req, res, next) => {
  req.session.destroy(error => {
    if (error) {
      next(error);
      return;
    }
    res.clearCookie('internhub.sid', { httpOnly: true, sameSite: 'lax' });
    res.redirect('/login');
  });
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: req.session?.authenticated === true,
    username: req.session?.authenticated === true ? ADMIN_USERNAME : null
  });
});

// Protected Administrative Intern CRUD APIs
app.get('/api/interns', requireAdminApi, async (_req, res, next) => {
  try {
    const students = await readInternDataset();
    res.json({ students: students || [] });
  } catch (error) {
    next(error);
  }
});

app.post('/api/interns', requireAdminApi, async (req, res, next) => {
  const newIntern = normalizeSingleIntern(req.body);
  if (!newIntern) {
    res.status(400).json({ error: 'Invalid intern data or missing required fields.' });
    return;
  }

  try {
    const dataset = await readInternDataset();
    if (dataset.some(i => i.id.toLowerCase() === newIntern.id.toLowerCase())) {
      res.status(409).json({ error: `An intern with ID "${newIntern.id}" already exists.` });
      return;
    }

    const updatedDataset = [...dataset, newIntern];
    await writeLocalInternDataset(updatedDataset);

    if (isSupabaseConfigured()) {
      try {
        await insertSingleInternInSupabase(newIntern);
      } catch (sbErr) {
        console.error('[InternHub] Supabase insert failed:', sbErr.message);
      }
    }

    res.status(201).json({ created: true, student: newIntern });
  } catch (error) {
    next(error);
  }
});

app.get('/api/interns/:id', requireAdminApi, async (req, res, next) => {
  const id = req.params.id.trim();
  try {
    const dataset = await readInternDataset();
    const intern = dataset.find(i => i.id.toLowerCase() === id.toLowerCase());
    if (!intern) {
      res.status(404).json({ error: `Intern with ID "${id}" was not found.` });
      return;
    }
    res.json({ student: intern });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/interns/:id', requireAdminApi, async (req, res, next) => {
  const id = req.params.id.trim();
  try {
    const dataset = await readInternDataset();
    const existingIndex = dataset.findIndex(i => i.id.toLowerCase() === id.toLowerCase());
    if (existingIndex === -1) {
      res.status(404).json({ error: `Intern with ID "${id}" was not found.` });
      return;
    }

    const merged = { ...dataset[existingIndex], ...req.body, id: dataset[existingIndex].id };
    const validated = normalizeSingleIntern(merged);
    if (!validated) {
      res.status(400).json({ error: 'Updated intern data is invalid.' });
      return;
    }

    dataset[existingIndex] = validated;
    await writeLocalInternDataset(dataset);

    if (isSupabaseConfigured()) {
      try {
        await updateSingleInternInSupabase(validated.id, validated);
      } catch (sbErr) {
        console.error('[InternHub] Supabase update failed:', sbErr.message);
      }
    }

    res.json({ updated: true, student: validated });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/interns/:id', requireAdminApi, async (req, res, next) => {
  const id = req.params.id.trim();
  try {
    const dataset = await readInternDataset();
    const existingIndex = dataset.findIndex(i => i.id.toLowerCase() === id.toLowerCase());
    if (existingIndex === -1) {
      res.status(404).json({ error: `Intern with ID "${id}" was not found.` });
      return;
    }

    const removedId = dataset[existingIndex].id;
    const updatedDataset = dataset.filter(i => i.id.toLowerCase() !== id.toLowerCase());
    await writeLocalInternDataset(updatedDataset);

    if (isSupabaseConfigured()) {
      try {
        await deleteSingleInternFromSupabase(removedId);
      } catch (sbErr) {
        console.error('[InternHub] Supabase deletion failed:', sbErr.message);
      }
    }

    res.json({ deleted: true, id: removedId });
  } catch (error) {
    next(error);
  }
});

// Batch Upsert for Cohort Import & Backup Restoration
app.put('/api/interns', requireAdminApi, async (req, res, next) => {
  const rawList = Array.isArray(req.body) ? req.body : req.body?.students;
  const records = normalizeInternRecords(rawList);
  if (!records) {
    res.status(400).json({ error: 'The intern dataset is invalid or contains duplicate IDs.' });
    return;
  }
  try {
    await writeInternDataset(records);
    res.json({ saved: true, count: records.length, students: records });
  } catch (error) {
    next(error);
  }
});

// Network Info for QR LAN generation
app.get('/api/network-info', (_req, res) => {
  const localIp = getLocalNetworkIp();
  res.json({
    localIp,
    port,
    baseUrl: process.env.PUBLIC_BASE_URL || `http://${localIp}:${port}`
  });
});

// Profile Link Token Generator (Admin Only)
app.post('/api/profile-link', requireAdmin, (req, res) => {
  const profile = normalizePublicProfile(req.body);
  if (!profile) {
    res.status(400).json({ error: 'A valid intern profile is required to generate its QR link.' });
    return;
  }
  const token = createProfileToken(profile);
  res.json({
    path: `/profile/${encodeURIComponent(profile.id)}`,
    tokenPath: `/profile/${token}`,
    id: profile.id
  });
});

// Public Verification Endpoints (No Admin Login Required)
app.get(['/profile', '/profile/'], (_req, res) => res.redirect('/'));

app.get('/profile/:identifier', async (req, res) => {
  const profile = await findPublicProfile(req.params.identifier);
  if (!profile) {
    res.status(404).sendFile(profilePage);
    return;
  }
  res.sendFile(profilePage);
});

// Dedicated Public API contract per Section 9
app.get('/api/public/interns/:identifier', async (req, res) => {
  const profile = await findPublicProfile(req.params.identifier);
  if (!profile) {
    res.status(404).json({ error: 'This intern profile link is invalid, expired, or unavailable.' });
    return;
  }
  res.json(profile);
});

// Backward compatibility alias for public profile API
app.get('/api/public-profile/:identifier', async (req, res) => {
  const profile = await findPublicProfile(req.params.identifier);
  if (!profile) {
    res.status(404).json({ error: 'This intern profile link is invalid, expired, or unavailable.' });
    return;
  }
  res.json(profile);
});

// Health check endpoint
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

// Protected Dashboard Routes
app.get('/', requireAdmin, (_req, res) => res.sendFile(internHubPage));
app.get('/index.html', requireAdmin, (_req, res) => res.sendFile(internHubPage));

// 404 Handler
app.use((_req, res) => res.status(404).send('Page not found.'));

// Global Error Handler
app.use((error, _req, res, _next) => {
  console.error('InternHub request error:', error);
  if (res.headersSent) return;
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  res.status(status).json({
    error: status === 413 ? 'Request body is too large.' : status === 400 ? 'The request is invalid.' : 'An internal server error occurred.'
  });
});

app.listen(port, host, async () => {
  console.log(`PSM InternHub listening on http://${host}:${port}`);
  if (isSupabaseConfigured()) {
    console.log('[InternHub] Supabase Database Mode: ACTIVE');
  } else {
    console.log('[InternHub] Local Storage Mode: ACTIVE (Dual-mode fallback ready)');
  }
  try {
    const records = await readInternDataset();
    if (records) {
      console.log(`[InternHub] Connected to backend dataset (${records.length} records loaded).`);
    } else {
      console.log('[InternHub] Backend dataset ready.');
    }
  } catch (err) {
    console.error('[InternHub] Failed to initialize backend dataset:', err.message);
  }
});
