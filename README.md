# PSM InternHub

Production-ready Internship Management, Weighted Performance Evaluation, Printable ID Pass, and Public QR Verification Web Application.

---

## 1. Quick Start (Local Development)

### Prerequisites
- Node.js 18 or later (`node -v`)
- npm 9 or later (`npm -v`)

### Steps

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   Copy `.env.example` to `.env` if not already present:
   ```bash
   cp .env.example .env
   ```

3. **Set administrator password:**
   Run the secure password setup utility:
   ```bash
   npm run set-password
   ```
   Follow the interactive prompt to enter your new administrator password. The script automatically derives a salted scrypt hash (`salt:hash`), generates a 64-character `SESSION_SECRET`, and updates your local `.env`.

4. **Start the application:**
   ```bash
   npm run dev
   # or
   npm start
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

5. **Run automated test suite:**
   ```bash
   npm test
   ```

---

## 2. Supabase PostgreSQL Setup

PSM InternHub supports dual-mode storage: Supabase PostgreSQL as the primary database with a resilient local JSON file fallback (`data/interns.json`).

### Step 1: Create Supabase Project
1. Log in to [Supabase Dashboard](https://supabase.com/dashboard) and create a new project.
2. Navigate to **Project Settings** -> **API** to retrieve:
   - **Project URL** (`https://<project-ref>.supabase.co`)
   - **anon / public key** or **service_role key**

### Step 2: Run Database Schema
1. In the Supabase Dashboard, open **SQL Editor** -> **New query**.
2. Copy the entire content of [`supabase-schema.sql`](file:///c:/Users/MRasu/Downloads/psm/supabase-schema.sql) and click **Run**.
3. This creates:
   - `public.interns` table with constraints for scores (`0-100`), days, and statuses
   - Performance indexes on `status`, `domain`, `score`, and `created_at`
   - Automated trigger for updating `updated_at`
   - Row-Level Security (RLS) policies allowing public read access for verification and write access for authenticated server operations

### Step 3: Configure Environment Variables
In your `.env` file (and production host):
```env
SUPABASE_URL=https://<your-project-id>.supabase.co
SUPABASE_KEY=<your-supabase-key>
```

### Step 4: Synchronize Cohort Records
To upload and verify existing local student records into Supabase:
```bash
npm run db:sync
```

---

## 3. Project Structure & Architecture

### Repository Structure
```text
PSM-InternHub/
│
├── assets/                 # Shared visual assets, icons, badges, and stylesheets
├── data/                   # Local JSON data & seed files (resilient fallback)
├── scripts/                # Database synchronization & admin password setup utilities
├── tests/                  # Automated integration and unit test suite
├── index.html              # Administrator management dashboard (Stitch Ref 2, 3, 4, 5)
├── login.html              # Administrator authentication screen (Stitch Ref 1)
├── profile.html            # Public QR-verified student profile (Stitch Ref 5)
├── server.js               # Production Express backend & secure API
├── supabaseClient.js       # Resilient Supabase PostgreSQL client
├── supabase-schema.sql     # Database schema, indexes, triggers & RLS policies
├── render.yaml             # Render infrastructure-as-code blueprint
├── package.json            # Application dependencies and execution scripts
├── package-lock.json       # Exact dependency lockfile
├── .env.example            # Environment variable template
├── .gitignore              # Git ignore rules
└── README.md               # Repository documentation
```

### Screens & Modules
The application reproduces the 5 Google Stitch reference interfaces:

| Stitch Reference | Module / Screen | Route | Key Capabilities |
| :--- | :--- | :--- | :--- |
| **Reference 1** | Administrator Login | `GET /login` | Secure scrypt authentication, rate limiting (5 req / 15 min), password visibility toggle, accessible feedback. |
| **Reference 2** | Executive Overview | `GET /#dashboard` | Live metrics (Total, Active, Certified, Projects, Avg Score, Attendance, Mentors), Chart.js visualizations, Top Performers leaderboard. |
| **Reference 3** | Intern Directory (CRUD) | `GET /#students` | Full intern listing, search, domain filter, status filter, sorting, live modal CRUD (`POST`, `PATCH`, `DELETE`), quick attendance dialog. |
| **Reference 4** | Weighted Grading Rubric | `GET /#evaluator` | 6 category rubric (Technical, Quality, Problem Solving, Task Completion, Communication, Teamwork), weighted composite calculation, letter grade derivation, mentor review saving. |
| **Reference 5** | Verified Profile & ID Pass | `GET /profile/:id` & `GET /#idcard` | Public verification profile with live QR code, attendance progress, rubric breakdown, print credential view, and printable official badge pass. |

---

## 4. API Endpoints

### Public APIs
- `GET /health` &mdash; Returns `{"status":"ok"}`.
- `GET /login` &mdash; Standalone administrator login screen.
- `POST /login` &mdash; Validates credentials, regenerates session cookie.
- `GET /profile/:id` &mdash; Standalone public intern verification profile.
- `GET /api/public/interns/:id` &mdash; Public API returning approved non-sensitive intern details and verification state.
- `GET /api/network-info` &mdash; Local IP and base URL for mobile QR code scanning.

### Protected Administrator APIs (Requires Session Cookie)
- `GET /` & `GET /index.html` &mdash; Administrator dashboard.
- `POST /logout` &mdash; Destroys admin session.
- `GET /api/auth/status` &mdash; Checks session authentication status.
- `GET /api/interns` &mdash; Returns all intern records.
- `POST /api/interns` &mdash; Creates a new validated intern (rejects duplicate IDs).
- `GET /api/interns/:id` &mdash; Returns single intern record.
- `PATCH /api/interns/:id` &mdash; Updates existing intern fields and recalculates score.
- `DELETE /api/interns/:id` &mdash; Deletes intern record from database and local storage.
- `PUT /api/interns` &mdash; Batch upsert for backup restoration and cohort synchronization.
- `POST /api/profile-link` &mdash; Generates signed cryptographic HMAC token link for QR verification.

---

## 5. Deployment on Render

This repository includes a production-ready [`render.yaml`](file:///c:/Users/MRasu/Downloads/psm/render.yaml) blueprint.

### Steps to Deploy:
1. Push this project to your GitHub repository:
   ```bash
   git add .
   git commit -m "Production ready PSM InternHub"
   git push origin main
   ```
2. Log in to [Render](https://dashboard.render.com).
3. Click **New +** -> **Blueprint**.
4. Connect your GitHub repository. Render automatically reads `render.yaml`.
5. In the Render environment configuration, fill in your production values:
   - `ADMIN_USERNAME`: e.g. `admin@psm`
   - `ADMIN_PASSWORD_HASH`: Output from `npm run set-password`
   - `SUPABASE_URL`: Your Supabase Project URL
   - `SUPABASE_KEY`: Your Supabase Server API Key
   - `SESSION_SECRET`: Auto-generated by Render
6. Click **Apply**.
7. Render provisions the web service, attaches the `/var/data` disk, runs `npm install`, and starts `server.js` with active health monitoring on `/health`.

---

## 6. Security & Hardening Features

- **Password Storage**: Salted scrypt key derivation (`crypto.scryptSync`, 16-byte random salt, 64-byte key).
- **Constant-Time Verification**: `crypto.timingSafeEqual` with buffer length checking prevents timing side-channels.
- **Session Protection**: `express-session` with `HttpOnly`, `SameSite=Lax`, 4-hour expiration, and session ID regeneration upon login.
- **Rate Limiting**: `express-rate-limit` enforces a strict 5-request limit per 15-minute window on `/login`.
- **Security Headers**: Standard defense-in-depth headers:
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: no-store` on authenticated endpoints
  - `Referrer-Policy: strict-origin-when-cross-origin`
- **Public Data Isolation**: Dedicated public profile serializer guarantees internal administrative notes, passwords, and sensitive system state are never transmitted to public visitors.

---

## 7. License

PSM InternHub &copy; 2026 Problem Solving Minds. All rights reserved.
#   P S M - I n t e r n H u b  
 