const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const PORT = 3849;
let serverProcess = null;
let sessionCookie = '';

// Ephemeral test credentials for isolated authentication testing
const TEST_PASSWORD = 'TestPassword_2026_Secure!';
const TEST_SALT = crypto.randomBytes(16).toString('hex');
const TEST_DERIVED = crypto.scryptSync(TEST_PASSWORD, TEST_SALT, 64).toString('hex');
const TEST_PASSWORD_HASH = `${TEST_SALT}:${TEST_DERIVED}`;

function waitForServer(url, timeoutMs = 12000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      http.get(url, (res) => {
        if (res.statusCode) {
          resolve();
        } else {
          retry();
        }
      }).on('error', () => {
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server at ${url} did not start within ${timeoutMs}ms`));
      } else {
        setTimeout(check, 250);
      }
    };

    check();
  });
}

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ADMIN_USERNAME: 'admin@psm',
      ADMIN_PASSWORD_HASH: TEST_PASSWORD_HASH,
      NODE_ENV: 'test'
    },
    stdio: 'pipe'
  });

  await waitForServer(`http://127.0.0.1:${PORT}/health`);
});

test.after(() => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

test('1. Health check endpoint returns status ok', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/health',
    method: 'GET'
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json, { status: 'ok' });
});

test('2. Unauthenticated access to dashboard redirects to /login', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/',
    method: 'GET'
  });
  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.headers.location, '/login');
});

test('3. Unauthenticated access to /api/interns returns 401', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/interns',
    method: 'GET'
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.json?.error, 'Administrator login required.');
});

test('4. Login fails with incorrect credentials', async () => {
  const body = 'username=admin%40psm&password=incorrect_password';
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  assert.strictEqual(res.statusCode, 401);
  assert.match(res.body, /Incorrect username or password/);
});

test('5. Login succeeds with valid credentials and sets secure session cookie', async () => {
  const body = `username=admin%40psm&password=${encodeURIComponent(TEST_PASSWORD)}`;
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.headers.location, '/');
  assert.ok(res.headers['set-cookie']);

  // Extract session cookie
  const rawCookie = res.headers['set-cookie'][0];
  sessionCookie = rawCookie.split(';')[0];
  assert.match(sessionCookie, /^internhub\.sid=/);
});

test('6. Authenticated session accesses dashboard (200 OK)', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/',
    method: 'GET',
    headers: {
      Cookie: sessionCookie
    }
  });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.body, /PSM InternHub/);
});

test('7. Authenticated session accesses /api/interns and reads records', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/interns',
    method: 'GET',
    headers: {
      Cookie: sessionCookie
    }
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json.students));
  assert.ok(res.json.students.length > 0);
});

test('8. Authenticated session creates a new intern record (POST /api/interns)', async () => {
  const newIntern = {
    id: 'TEST-INT-AUTO-999',
    name: 'Dev Test Candidate',
    college: 'Anna University',
    domain: 'Full Stack Web',
    role: 'Junior Full Stack Engineer',
    days: 30,
    total: 90,
    score: 92.5,
    status: 'ACTIVE',
    skills: ['Node.js', 'Express', 'PostgreSQL'],
    project: 'Automated Test Pipeline',
    description: 'Verification deliverable for regression testing.',
    mentorName: 'Test Mentor',
    marks: {
      technical: 95,
      projectQuality: 92,
      problemSolving: 90,
      taskCompletion: 94,
      communication: 90,
      teamwork: 90
    }
  };

  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/interns',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    }
  }, newIntern);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.json.created, true);
  assert.strictEqual(res.json.student.id, 'TEST-INT-AUTO-999');
});

test('9. Rejects duplicate intern ID creation with 409 Conflict', async () => {
  const duplicate = {
    id: 'TEST-INT-AUTO-999',
    name: 'Duplicate Candidate',
    college: 'IIT',
    domain: 'AI',
    role: 'AI Intern',
    days: 10,
    total: 90
  };

  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/interns',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    }
  }, duplicate);

  assert.strictEqual(res.statusCode, 409);
  assert.match(res.json.error, /already exists/);
});

test('10. Reads the created intern (GET /api/interns/:id)', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/interns/TEST-INT-AUTO-999',
    method: 'GET',
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json.student.name, 'Dev Test Candidate');
});

test('11. Updates the created intern (PATCH /api/interns/:id)', async () => {
  const updatePayload = {
    days: 45,
    status: 'COMPLETED'
  };

  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/interns/TEST-INT-AUTO-999',
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie
    }
  }, updatePayload);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json.student.days, 45);
  assert.strictEqual(res.json.student.status, 'COMPLETED');
});

test('12. Deletes the created test intern (DELETE /api/interns/:id)', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/interns/TEST-INT-AUTO-999',
    method: 'DELETE',
    headers: {
      Cookie: sessionCookie
    }
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json.deleted, true);
  assert.strictEqual(res.json.id, 'TEST-INT-AUTO-999');
});

test('13. Public profile endpoint retrieves verified intern PSMI011', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/public/interns/PSMI011',
    method: 'GET'
  });
  assert.strictEqual(res.statusCode, 200);
  const data = res.json;
  assert.strictEqual(data.id, 'PSMI011');
  assert.strictEqual(typeof data.score, 'number');
  assert.strictEqual(typeof data.days, 'number');
  assert.strictEqual(typeof data.total, 'number');
  // Secrets not leaked
  assert.strictEqual(data.password, undefined);
  assert.strictEqual(data.ADMIN_PASSWORD_HASH, undefined);
});

test('14. Public profile returns 404 for nonexistent ID', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/public/interns/NON-EXISTENT-ID',
    method: 'GET'
  });
  assert.strictEqual(res.statusCode, 404);
});

test('15. Logout destroys session and redirects to /login', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/logout',
    method: 'POST',
    headers: {
      Cookie: sessionCookie
    }
  });
  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.headers.location, '/login');

  // Verify that former session cookie is now rejected
  const protectedRes = await request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/interns',
    method: 'GET',
    headers: {
      Cookie: sessionCookie
    }
  });
  assert.strictEqual(protectedRes.statusCode, 401);
});
