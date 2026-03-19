const crypto = require('crypto');

const client_id = '01KM3RDB74NZ0TZ8QKXAKRGJBS';
const redirect_uri = 'http://localhost:3000/callback';
const scope = 'moderation:ban';
const state = crypto.randomBytes(16).toString('hex');

// PKCE
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

const url = `https://id.kick.com/oauth/authorize?` + 
  `client_id=${client_id}&` +
  `redirect_uri=${encodeURIComponent(redirect_uri)}&` +
  `response_type=code&` +
  `scope=${encodeURIComponent(scope)}&` +
  `state=${state}&` +
  `code_challenge=${challenge}&` +
  `code_challenge_method=S256`;

console.log('\n--- KICK AUTH URL ---');
console.log(url);
console.log('---------------------\n');

// Save for setup_tokens.js
require('fs').writeFileSync('pkce_data.json', JSON.stringify({
  verifier,
  state,
  client_id,
  redirect_uri
}, null, 2));

console.log('PKCE verileri pkce_data.json dosyasına kaydedildi.');
