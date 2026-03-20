const axios = require('axios');
const admin = require('firebase-admin');

// ── Yapılandırma ──────────────────────────────────────────
const clientId = process.env.KICK_CLIENT_ID;
const clientSecret = process.env.KICK_CLIENT_SECRET;
const redirectUri = 'http://localhost:3000/callback';

async function run() {
  const code = process.argv[2];
  if (!code) {
    console.error('KULLANIM: node setup_tokens.js <AUTHORIZATION_CODE>');
    process.exit(1);
  }

  // PKCE verisini oku
  let pkce;
  try {
    const fs = require('fs');
    pkce = JSON.parse(fs.readFileSync('pkce_data.json', 'utf8'));
  } catch (e) {
    console.error('HATA: pkce_data.json bulunamadı! Önce gen_auth_url.js çalıştırılmalı.');
    process.exit(1);
  }

  if (!clientId || !clientSecret) {
    console.error('HATA: KICK_CLIENT_ID veya KICK_CLIENT_SECRET environment variable eksik!');
    process.exit(1);
  }

  console.log('[Kick API] Token değişim işlemi başlatılıyor...');

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('redirect_uri', redirectUri);
    params.append('code', code);
    params.append('code_verifier', pkce.verifier);

    const response = await axios.post('https://id.kick.com/oauth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const tokens = response.data;
    const expiresAt = Date.now() + (tokens.expires_in * 1000);

    console.log('\n--- KICK TOKENS ALINDI ---');
    console.log(JSON.stringify(tokens, null, 2));
    console.log('--------------------------\n');

    // Firebase'i başlatmayı dene
    try {
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        admin.initializeApp({
          credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
        });
        const db = admin.firestore();
        await db.collection('bot_config').doc('tokens').set({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: expiresAt,
          updated_at: Date.now()
        });
        console.log('[Firebase] Tokenlar başarıyla Firestore\'a kaydedildi.');
      } else {
        console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT eksik. Lütfen yukarıdaki tokenları manuel olarak Firestore (bot_config/tokens) dökümanına ekleyin.');
      }
    } catch (fbError) {
      console.warn('[Firebase] Firestore kaydı başarısız (Service Account hatası). Lütfen manuel kaydedin.');
    }

  } catch (error) {
    console.error('HATA: Token değişimi başarısız oldu.');
    console.error(error.response?.data || error.message);
  }
}

run();
