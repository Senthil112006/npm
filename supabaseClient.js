const { createClient } = require('@supabase/supabase-js');

const rawUrl = process.env.SUPABASE_URL?.trim();
const rawKey = (
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY
)?.trim();

let supabaseInstance = null;
let isConfigured = false;

function normalizeSupabaseUrl(url) {
  if (!url) return '';
  // Support dashboard project URLs: https://supabase.com/dashboard/project/<project-id>
  const match = url.match(/supabase\.com\/dashboard\/project\/([a-z0-9_-]+)/i);
  if (match) {
    return `https://${match[1]}.supabase.co`;
  }
  return url.replace(/\/+$/, '');
}

function isValidUrl(urlString) {
  if (!urlString || urlString.includes('your-project-ref') || urlString.includes('<your-project-id>')) return false;
  try {
    const parsed = new URL(urlString);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

const cleanedUrl = normalizeSupabaseUrl(rawUrl);

if (isValidUrl(cleanedUrl) && rawKey && !rawKey.includes('<your-supabase-anon')) {
  try {
    supabaseInstance = createClient(cleanedUrl, rawKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    isConfigured = true;
  } catch (error) {
    console.warn('[Supabase] Failed to initialize client:', error.message);
    supabaseInstance = null;
    isConfigured = false;
  }
}

function isSupabaseConfigured() {
  return isConfigured && supabaseInstance !== null;
}

function getSupabaseClient() {
  return supabaseInstance;
}

/**
 * Maps a database row from Supabase into the application's normalized intern object.
 * Supports both camelCase and snake_case column identifiers.
 */
function mapRowToIntern(row) {
  if (!row || typeof row !== 'object') return null;

  const score = Number(row.score ?? 0);
  const days = Number(row.days ?? 0);
  const total = Number(row.total ?? 90);

  let skills = [];
  if (Array.isArray(row.skills)) {
    skills = row.skills;
  } else if (typeof row.skills === 'string') {
    try {
      skills = JSON.parse(row.skills);
    } catch {
      skills = [];
    }
  }

  let marks = {};
  if (row.marks && typeof row.marks === 'object' && !Array.isArray(row.marks)) {
    marks = row.marks;
  } else if (typeof row.marks === 'string') {
    try {
      marks = JSON.parse(row.marks);
    } catch {
      marks = {};
    }
  }

  return {
    id: String(row.id || '').trim(),
    name: String(row.name || '').trim(),
    college: String(row.college || '').trim(),
    domain: String(row.domain || '').trim(),
    role: String(row.role || '').trim(),
    days: Number.isInteger(days) && days >= 0 ? days : 0,
    total: Number.isInteger(total) && total >= 1 ? total : 90,
    score: Number.isFinite(score) ? Math.round(score * 10) / 10 : 0,
    grade: String(row.grade || '').trim(),
    status: row.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
    mentorName: String(row.mentorName || row.mentor_name || '').trim(),
    mentorId: String(row.mentorId || row.mentor_id || '').trim(),
    mentorReview: String(row.mentorReview || row.mentor_review || '').trim(),
    evaluation: String(row.evaluation || '').trim(),
    project: String(row.project || '').trim(),
    description: String(row.description || '').trim(),
    github: String(row.github || '').trim(),
    photo: String(row.photo || '').trim(),
    qrImage: String(row.qrImage || row.qr_image || '').trim(),
    skills: Array.isArray(skills) ? skills.filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean) : [],
    marks
  };
}

/**
 * Maps a normalized intern object into a database row suitable for Supabase.
 */
function mapInternToRow(intern) {
  return {
    id: intern.id,
    name: intern.name,
    college: intern.college,
    domain: intern.domain,
    role: intern.role,
    days: intern.days,
    total: intern.total,
    score: intern.score,
    grade: intern.grade || '',
    status: intern.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
    mentorName: intern.mentorName || '',
    mentorId: intern.mentorId || '',
    mentorReview: intern.mentorReview || '',
    evaluation: intern.evaluation || '',
    project: intern.project || '',
    description: intern.description || '',
    github: intern.github || '',
    photo: intern.photo || '',
    qrImage: intern.qrImage || '',
    skills: intern.skills || [],
    marks: intern.marks || {},
    updated_at: new Date().toISOString()
  };
}

/**
 * Fetches all interns from Supabase table 'interns'.
 */
async function fetchAllInternsFromSupabase() {
  if (!isSupabaseConfigured()) return null;

  const { data, error } = await supabaseInstance
    .from('interns')
    .select('*')
    .order('id', { ascending: true });

  if (error) {
    throw new Error(`Supabase query error: ${error.message} (code: ${error.code})`);
  }

  if (!Array.isArray(data)) return [];

  return data.map(mapRowToIntern).filter(Boolean);
}

/**
 * Fetches a single intern by identifier (case-insensitive ID) from Supabase.
 */
async function fetchSingleInternFromSupabase(identifier) {
  if (!isSupabaseConfigured() || !identifier) return null;

  const cleanId = String(identifier).trim();
  const { data, error } = await supabaseInstance
    .from('interns')
    .select('*')
    .ilike('id', cleanId)
    .maybeSingle();

  if (error) {
    console.warn(`[Supabase] Single intern query error for ID ${cleanId}:`, error.message);
    return null;
  }

  if (!data) return null;
  return mapRowToIntern(data);
}

/**
 * Inserts a single intern record into Supabase.
 */
async function insertSingleInternInSupabase(intern) {
  if (!isSupabaseConfigured() || !intern) return null;

  const row = mapInternToRow(intern);
  const { data, error } = await supabaseInstance
    .from('interns')
    .insert([row])
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase insert error: ${error.message} (code: ${error.code})`);
  }

  return mapRowToIntern(data);
}

/**
 * Updates a single intern record in Supabase by ID.
 */
async function updateSingleInternInSupabase(id, intern) {
  if (!isSupabaseConfigured() || !id || !intern) return null;

  const row = mapInternToRow(intern);
  delete row.id; // Avoid mutating primary key

  const { data, error } = await supabaseInstance
    .from('interns')
    .update(row)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase update error: ${error.message} (code: ${error.code})`);
  }

  return mapRowToIntern(data);
}

/**
 * Deletes a single intern from Supabase by ID.
 */
async function deleteSingleInternFromSupabase(id) {
  if (!isSupabaseConfigured() || !id) return false;

  const { error } = await supabaseInstance
    .from('interns')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Supabase delete error: ${error.message} (code: ${error.code})`);
  }

  return true;
}

/**
 * Upserts a list of intern records into Supabase and deletes removed records.
 */
async function syncInternsToSupabase(records) {
  if (!isSupabaseConfigured() || !Array.isArray(records)) {
    return { synced: false, count: 0 };
  }

  const rows = records.map(mapInternToRow);

  // 1. Upsert all current records
  const { error: upsertError } = await supabaseInstance
    .from('interns')
    .upsert(rows, { onConflict: 'id' });

  if (upsertError) {
    throw new Error(`Supabase upsert error: ${upsertError.message}`);
  }

  // 2. Remove any records from Supabase that were deleted in the dataset
  const currentIds = records.map(r => r.id);
  if (currentIds.length > 0) {
    try {
      const { data: existingRows } = await supabaseInstance
        .from('interns')
        .select('id');

      if (Array.isArray(existingRows)) {
        const toDelete = existingRows
          .map(r => r.id)
          .filter(id => !currentIds.includes(id));

        if (toDelete.length > 0) {
          const { error: deleteError } = await supabaseInstance
            .from('interns')
            .delete()
            .in('id', toDelete);

          if (deleteError) {
            console.warn('[Supabase] Warning: could not delete removed IDs:', deleteError.message);
          } else {
            console.log(`[Supabase] Pruned ${toDelete.length} removed student record(s).`);
          }
        }
      }
    } catch (cleanupErr) {
      console.warn('[Supabase] Cleanup check failed:', cleanupErr.message);
    }
  }

  return { synced: true, count: records.length };
}

module.exports = {
  isSupabaseConfigured,
  getSupabaseClient,
  normalizeSupabaseUrl,
  isValidUrl,
  fetchAllInternsFromSupabase,
  fetchSingleInternFromSupabase,
  insertSingleInternInSupabase,
  updateSingleInternInSupabase,
  deleteSingleInternFromSupabase,
  syncInternsToSupabase,
  mapRowToIntern,
  mapInternToRow
};
