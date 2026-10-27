const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

async function getPassword() {
  const argPassword = process.argv[2];
  if (argPassword) {
    console.log('⚠️  Notice: Passing passwords as command-line arguments can expose them in shell history.');
    console.log('   In production or shared systems, run without arguments for interactive entry.\n');
    return argPassword.trim();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const entered = await rl.question('Enter new administrator password: ');
    const trimmed = entered.trim();
    if (!trimmed) {
      console.error('❌ Password cannot be empty.');
      process.exit(1);
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

async function main() {
  const newPassword = await getPassword();

  if (newPassword.length < 8) {
    console.error('❌ Password should be at least 8 characters long for adequate security.');
    process.exit(1);
  }

  const salt = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const hash = crypto.scryptSync(newPassword, salt, 64).toString('hex'); // 128 hex chars
  const passwordHash = `${salt}:${hash}`;
  const sessionSecret = crypto.randomBytes(32).toString('hex'); // 64 hex chars

  const envPath = path.join(__dirname, '..', '.env');
  const envExamplePath = path.join(__dirname, '..', '.env.example');

  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  } else if (fs.existsSync(envExamplePath)) {
    console.log('📄 .env not found. Creating from .env.example...');
    envContent = fs.readFileSync(envExamplePath, 'utf8');
  } else {
    envContent = 'ADMIN_USERNAME=admin@psm\n';
  }

  // Update ADMIN_PASSWORD_HASH
  if (/^ADMIN_PASSWORD_HASH=.*/m.test(envContent)) {
    envContent = envContent.replace(/^ADMIN_PASSWORD_HASH=.*/m, `ADMIN_PASSWORD_HASH=${passwordHash}`);
  } else {
    envContent += `\nADMIN_PASSWORD_HASH=${passwordHash}\n`;
  }

  // Ensure SESSION_SECRET is at least 32 chars and not placeholder
  if (/^SESSION_SECRET=(?:replace-with.*|generate_.*|\s*)$/m.test(envContent) || !/^SESSION_SECRET=.+/m.test(envContent)) {
    if (/^SESSION_SECRET=.*/m.test(envContent)) {
      envContent = envContent.replace(/^SESSION_SECRET=.*/m, `SESSION_SECRET=${sessionSecret}`);
    } else {
      envContent += `\nSESSION_SECRET=${sessionSecret}\n`;
    }
  }

  fs.writeFileSync(envPath, envContent, 'utf8');

  console.log('✅ Administrator credentials updated successfully!');
  console.log(`🔐 Scrypt Hash: ${passwordHash.slice(0, 36)}...[hidden]`);
  console.log('🚀 You can now start the server with: npm run dev');
}

main().catch(err => {
  console.error('Failed to set administrator password:', err);
  process.exit(1);
});
