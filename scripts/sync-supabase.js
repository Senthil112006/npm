const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const {
  isSupabaseConfigured,
  syncInternsToSupabase,
  fetchAllInternsFromSupabase
} = require('../supabaseClient');

function validateAndNormalizeRecord(intern, index, seenIds) {
  if (!intern || typeof intern !== 'object') {
    return { valid: false, reason: `Item at index ${index} is not an object` };
  }

  const id = typeof intern.id === 'string' ? intern.id.trim() : '';
  const name = typeof intern.name === 'string' ? intern.name.trim() : '';
  const college = typeof intern.college === 'string' ? intern.college.trim() : '';
  const domain = typeof intern.domain === 'string' ? intern.domain.trim() : '';
  const role = typeof intern.role === 'string' ? intern.role.trim() : '';

  if (!id) return { valid: false, reason: `Record #${index + 1} is missing a required 'id'` };
  if (seenIds.has(id.toLowerCase())) {
    return { valid: false, reason: `Duplicate intern ID detected: "${id}"` };
  }
  seenIds.add(id.toLowerCase());

  if (!name) return { valid: false, reason: `Intern [${id}] is missing 'name'` };
  if (!college) return { valid: false, reason: `Intern [${id}] is missing 'college'` };
  if (!domain) return { valid: false, reason: `Intern [${id}] is missing 'domain'` };
  if (!role) return { valid: false, reason: `Intern [${id}] is missing 'role'` };

  const days = Number(intern.days ?? 0);
  const total = Number(intern.total ?? 90);
  const score = Number(intern.score ?? 0);

  if (!Number.isInteger(days) || days < 0) {
    return { valid: false, reason: `Intern [${id}] has invalid days completed: ${intern.days}` };
  }
  if (!Number.isInteger(total) || total < 1) {
    return { valid: false, reason: `Intern [${id}] has invalid total days: ${intern.total}` };
  }
  if (days > total) {
    return { valid: false, reason: `Intern [${id}] days (${days}) exceeds total days (${total})` };
  }
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return { valid: false, reason: `Intern [${id}] score (${score}) must be between 0 and 100` };
  }

  const categories = ['technical', 'projectQuality', 'problemSolving', 'taskCompletion', 'communication', 'teamwork'];
  const inputMarks = intern.marks && typeof intern.marks === 'object' ? intern.marks : {};
  const marks = {};
  for (const cat of categories) {
    const mark = Number(inputMarks[cat] ?? score);
    if (!Number.isFinite(mark) || mark < 0 || mark > 100) {
      return { valid: false, reason: `Intern [${id}] mark for "${cat}" (${mark}) is out of range 0-100` };
    }
    marks[cat] = mark;
  }

  const skills = Array.isArray(intern.skills)
    ? intern.skills.filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean)
    : [];

  return {
    valid: true,
    record: {
      ...intern,
      id,
      name,
      college,
      domain,
      role,
      days,
      total,
      score: Math.round(score * 10) / 10,
      grade: typeof intern.grade === 'string' ? intern.grade.trim() : '',
      status: intern.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
      mentorName: typeof intern.mentorName === 'string' ? intern.mentorName.trim() : '',
      mentorId: typeof intern.mentorId === 'string' ? intern.mentorId.trim() : '',
      mentorReview: typeof intern.mentorReview === 'string' ? intern.mentorReview.trim() : '',
      evaluation: typeof intern.evaluation === 'string' ? intern.evaluation.trim() : '',
      project: typeof intern.project === 'string' ? intern.project.trim() : '',
      description: typeof intern.description === 'string' ? intern.description.trim() : '',
      github: typeof intern.github === 'string' ? intern.github.trim() : '',
      photo: typeof intern.photo === 'string' ? intern.photo.trim() : '',
      qrImage: typeof intern.qrImage === 'string' ? intern.qrImage.trim() : '',
      skills,
      marks
    }
  };
}

async function main() {
  console.log('========================================================');
  console.log('  PSM InternHub -> Supabase Database Migration & Sync   ');
  console.log('========================================================\n');

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = (
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY
  )?.trim();

  if (!supabaseUrl || supabaseUrl.includes('your-project-ref') || supabaseUrl.includes('<your-project-id>')) {
    console.error('❌ ERROR: SUPABASE_URL is missing or still set to placeholder in your .env file!');
    console.error('👉 Please configure SUPABASE_URL=https://<your-project-id>.supabase.co in .env\n');
    process.exit(1);
  }

  if (!supabaseKey || supabaseKey.includes('<your-supabase-anon')) {
    console.error('❌ ERROR: SUPABASE_KEY is missing or placeholder in your .env file!\n');
    process.exit(1);
  }

  if (!isSupabaseConfigured()) {
    console.error('❌ ERROR: Could not connect to Supabase with the current configuration.');
    console.error(`Project URL: ${supabaseUrl}`);
    process.exit(1);
  }

  console.log(`📡 Connected to Supabase project at: ${supabaseUrl}`);

  // 1. Read dataset
  const dataDir = path.resolve(process.env.INTERNHUB_DATA_DIR || path.join(__dirname, '..', 'data'));
  const internsFile = path.join(dataDir, 'interns.json');
  const seedFile = path.join(__dirname, '..', 'data', 'seed-interns.json');

  let fileToRead = internsFile;
  if (!fs.existsSync(fileToRead)) {
    fileToRead = seedFile;
  }

  if (!fs.existsSync(fileToRead)) {
    console.error('❌ ERROR: No dataset file found in data/ directory.');
    process.exit(1);
  }

  console.log(`📂 Reading records from: ${path.basename(fileToRead)}...`);
  const rawData = fs.readFileSync(fileToRead, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(rawData);
  } catch (err) {
    console.error('❌ ERROR: Invalid JSON in dataset file:', err.message);
    process.exit(1);
  }

  const rawStudents = Array.isArray(parsed) ? parsed : parsed.students;
  if (!Array.isArray(rawStudents) || rawStudents.length === 0) {
    console.error('❌ ERROR: No student records found in file.');
    process.exit(1);
  }

  console.log(`🔍 Validating ${rawStudents.length} candidate records...`);
  const seenIds = new Set();
  const validRecords = [];
  const validationErrors = [];

  rawStudents.forEach((item, idx) => {
    const res = validateAndNormalizeRecord(item, idx, seenIds);
    if (res.valid) {
      validRecords.push(res.record);
    } else {
      validationErrors.push(res.reason);
    }
  });

  if (validationErrors.length > 0) {
    console.error(`\n❌ Validation failed for ${validationErrors.length} record(s):`);
    validationErrors.forEach(err => console.error(`   - ${err}`));
    process.exit(1);
  }

  console.log(`✅ All ${validRecords.length} records passed schema validation.`);

  // 2. Perform upsert to Supabase
  try {
    console.log('🚀 Upserting records into Supabase "interns" table...');
    const result = await syncInternsToSupabase(validRecords);
    console.log(`\n✅ SUCCESS! ${result.count} intern records synchronized to Supabase:`);
    validRecords.forEach((s, idx) => {
      console.log(`   ${idx + 1}. [${s.id}] ${s.name} (${s.domain}) - Score: ${s.score}% [${s.status}]`);
    });

    // 3. Verify
    console.log('\n🔍 Verifying records from Supabase...');
    const liveRecords = await fetchAllInternsFromSupabase();
    console.log(`✅ Verified: Supabase table "interns" now contains ${liveRecords.length} live records.\n`);
    console.log('🎉 Your Supabase database is synchronized and ready for production!');
  } catch (syncErr) {
    console.error('\n❌ ERROR during Supabase synchronization:', syncErr.message);
    if (syncErr.message.includes('relation "interns" does not exist') || syncErr.message.includes('42P01')) {
      console.error('\n💡 HINT: The table "interns" has not been created in Supabase yet.');
      console.error('   Please run supabase-schema.sql in your Supabase SQL Editor.');
    } else if (syncErr.message.includes('row-level security') || syncErr.message.includes('RLS')) {
      console.error('\n💡 HINT: Row-Level Security (RLS) is blocking operations.');
      console.error('   Ensure the RLS policies in supabase-schema.sql are applied.');
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected failure:', err);
  process.exit(1);
});
