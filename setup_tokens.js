const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// ── Kurulum ──────────────────────────────────────────────
async function setup(code) {
  if (!code) {
    console.error('HATA: Lütfen kodu bir argüman olarak geçin. Örn: node setup_tokens.js 12345...');
    process.exit(1);
  }

  // Firebase başlat
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable eksik!');
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({
      credential: cert(serviceAccount),
    });
    console.log('[Firebase] Başarıyla başlatıldı');
  } catch (e) {
    console.error('[Firebase] Başlatma hatası:', e.message);
    process.exit(1);
  }

  const db = getFirestore();
  const clientId = process.env.KICK_CLIENT_ID;
  const clientSecret = process.env.KICK_CLIENT_SECRET;
  const redirectUri = 'http://localhost:3000/callback';

  // PKCE verisini oku
  let pkce;
  try {
    pkce = require('fs').readFileSync('pkce_data.json', 'utf8');
    pkce = JSON.parse(pkce);
  } catch (e) {
    console.error('HATA: pkce_data.json bulunamadı! Lütfen önce gen_auth_url.js çalıştırın.');
    process.exit(1);
  }

  if (!clientId || !clientSecret) {
    console.error('HATA: KICK_CLIENT_ID veya KICK_CLIENT_SECRET environment variable eksik!');
    process.exit(1);
  }

  console.log('[Kick API] Token değişim işlemi başlatılıyor...');

  try {
    const response = await axios.post('https://id.kick.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code: code,
      code_verifier: pkce.verifier
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    const { access_token, refresh_token, expires_in } = response.data;
    const expires_at = Date.now() + (expires_in * 1000);

    console.log('[Kick API] Tokenlar başarıyla alındı.');

    // Firestore'a kaydet
    await db.collection('bot_config').doc('tokens').set({
      access_token,
      refresh_token,
      expires_at,
      updated_at: Date.now()
    });

    console.log('[Firebase] Tokenlar bot_config/tokens dökümanına başarıyla kaydedildi!');
    console.log('Artık botu başlatabilirsin. Bot otomatik olarak bu tokenları kullanacak.');

  } catch (error) {
    console.error('[Kick API] Değişim hatası:', error.response?.data || error.message);
  }
}

// Komut satırından gelen kodu al
const args = process.argv.slice(2);
setup(args[0]);
