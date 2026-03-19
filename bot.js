const WebSocket = require('ws');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ── Ayarlar ──────────────────────────────────────────────
let activeConnections = new Map(); // chatroomId (string) -> WebSocket
let kickToken = null;
let tokenExpiresAt = 0;

const MY_CHANNEL = 'feanor-kt'; // Yasakların uygulanacağı kendi kanalın
// ─────────────────────────────────────────────────────────

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
  console.error('[Firebase] Başlatma hatası!!!:', e.message);
  process.exit(1);
}

const db = getFirestore();
const KICK_WS_URL = process.env.KICK_WS_URL || 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';

// ── Kick API Fonksiyonları ───────────────────────────────

let MY_CHANNEL_ID = null;

async function getChannelId(slug) {
  try {
    const response = await axios.get(`https://api.kick.com/public/v1/channels/${slug}`);
    return response.data.id;
  } catch (error) {
    console.error(`[Kick API] ${slug} ID bulunamadı:`, error.response?.data || error.message);
    return null;
  }
}

async function getKickAccessToken() {
  // Eğer token varsa ve süresi dolmadıysa (5 dk pay bırak) mevcut olanı kullan
  if (kickToken && Date.now() < tokenExpiresAt - 300000) {
    return kickToken;
  }

  const clientId = process.env.KICK_CLIENT_ID;
  const clientSecret = process.env.KICK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    // console.warn('[Kick API] KICK_CLIENT_ID veya KICK_CLIENT_SECRET eksik. Ban işlemi yapılamaz.');
    return null;
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    const response = await axios.post('https://id.kick.com/oauth/token', params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    kickToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in * 1000);
    console.log('[Kick API] Yeni Access Token alındı.');
    return kickToken;
  } catch (error) {
    console.error('[Kick API] Token alma hatası:', error.response?.data || error.message);
    return null;
  }
}

async function banUserOnKick(userId, username, targetChannel) {
  const token = await getKickAccessToken();
  if (!token) return;

  if (!MY_CHANNEL_ID) {
    MY_CHANNEL_ID = await getChannelId(MY_CHANNEL);
    if (!MY_CHANNEL_ID) return;
  }

  try {
    // API dökümanına göre doğru endpoint ve gövde
    await axios.post('https://api.kick.com/public/v1/moderation/bans', {
      broadcaster_user_id: parseInt(MY_CHANNEL_ID),
      user_id: parseInt(userId),
      reason: `Otomatik Ban: ${targetChannel} kanalında görüldü.`
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[Kick API] ${username} (${userId}) başarıyla banlandı.`);
    
    // Firestore'a ban kaydı ekle
    await db.collection('banned_users').add({
      username: username,
      user_id: userId,
      target_channel: targetChannel,
      my_channel: MY_CHANNEL,
      timestamp: FieldValue.serverTimestamp(),
      status: 'success'
    });

  } catch (error) {
    // 409: Zaten banlı olabilir
    if (error.response?.status === 409) return;
    
    console.error(`[Kick API] ${username} banlanırken hata:`, error.response?.data || error.message);
  }
}

// ─────────────────────────────────────────────────────────

// Yardımcı fonksiyon: Objede case-insensitive ve trimli key arama
const findKey = (obj, target) => {
  if (!obj) return null;
  const keys = Object.keys(obj);
  const found = keys.find(k => k.toLowerCase().trim() === target.toLowerCase());
  return found ? obj[found] : null;
};

// 1. Heartbeat Sistemi
function startHeartbeat() {
  console.log('[Heartbeat] Başlatıldı');
  setInterval(async () => {
    try {
      await db.collection('bot_status').doc('main').set({
        last_heartbeat: FieldValue.serverTimestamp(),
        active_channels: activeConnections.size,
        version: '1.1.0'
      });
    } catch (e) {
      console.error('[Heartbeat] Güncelleme hatası:', e.message);
    }
  }, 30000);
}

async function saveMessage(msg) {
  try {
    const batch = db.batch();
    const timestamp = FieldValue.serverTimestamp();

    // 1. Mesajı kaydet
    const msgRef = db.collection('messages').doc();
    batch.set(msgRef, {
      ...msg,
      created_at: timestamp,
    });

    // 2. Kullanıcı istatistiğini güncelle
    const userRef = db
      .collection('channels').doc(msg.channel)
      .collection('chatters').doc(msg.user_id);

    batch.set(userRef, {
      username: msg.username,
      user_id: msg.user_id,
      message_count: FieldValue.increment(1),
      last_seen: timestamp,
    }, { merge: true });

    // 3. Kanal toplam sayacını güncelle
    const channelRef = db.collection('channels').doc(msg.channel);
    batch.set(channelRef, {
      total_messages: FieldValue.increment(1),
      last_activity: timestamp,
      slug: msg.channel
    }, { merge: true });

    await batch.commit();

    // 4. Ban Bot Tetikleyici
    // Bot kendi kanalımızdan gelen mesajları banlamamalı
    if (msg.channel !== MY_CHANNEL && msg.username !== 'unknown') {
      await banUserOnKick(msg.user_id, msg.username, msg.channel);
    }

  } catch (error) {
    console.error(`[${msg.channel}] Mesaj işleme hatası:`, error.message);
  }
}

function listenChannel({ slug, chatroomId }) {
  if (!chatroomId) return;
  const idStr = chatroomId.toString();
  
  if (activeConnections.has(idStr)) {
    console.log(`[${slug}] Zaten dinleniyor (ID: ${idStr})`);
    return;
  }

  const ws = new WebSocket(KICK_WS_URL);
  let pingInterval;
  activeConnections.set(idStr, ws);

  ws.on('open', () => {
    console.log(`[${slug}] WebSocket bağlandı (ID: ${idStr})`);
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${idStr}.v2` }
    }));
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      }
    }, 30000);
  });

  ws.on('message', async (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }

    if (parsed.event === 'pusher_internal:subscription_succeeded') {
      console.log(`[${slug}] Başarıyla abone olundu (ID: ${idStr})`);
      return;
    }

    if (parsed.event === 'App\\Events\\ChatMessageEvent') {
      let data;
      try { data = JSON.parse(parsed.data); } catch { return; }

      const sender = data.sender || {};
      const msg = {
        channel:  slug,
        user_id:  (sender.id || 'unknown').toString(),
        username: sender.username || 'unknown',
        content:  data.content || '',
      };

      await saveMessage(msg);
    }
  });

  ws.on('close', (code) => {
    clearInterval(pingInterval);
    activeConnections.delete(idStr);
    console.log(`[${slug}] Bağlantı kapandı (Kod: ${code}). 5sn içinde tekrar denenecek.`);
  });

  ws.on('error', (err) => {
    console.error(`[${slug}] WebSocket hatası:`, err.message);
    activeConnections.delete(idStr);
  });
}

async function main() {
  console.log('Bot başlatılıyor...');
  startHeartbeat();

  console.log('[Config] bot_config/channels dökümanı dinleniyor...');
  db.collection('bot_config').doc('channels').onSnapshot((doc) => {
    if (!doc.exists) {
      console.warn('[Config] HATA: bot_config/channels dökümanı bulunamadı!');
      return;
    }

    const data = doc.data();
    const listRaw = data.list || [];
    const channels = Array.isArray(listRaw) ? listRaw : Object.values(listRaw);
    
    console.log(`[Config] Güncelleme: ${channels.length} kanal tanımlı.`);

    const currentIds = new Set();
    
    channels.forEach(ch => {
      const slug = findKey(ch, 'slug') || 'unknown';
      const rawId = findKey(ch, 'chatroomId');
      
      if (!rawId) {
        console.warn('[Config] Geçersiz kanal verisi (ID eksik):', JSON.stringify(ch));
        return;
      }

      const chatroomId = rawId.toString();
      currentIds.add(chatroomId);

      if (!activeConnections.has(chatroomId)) {
        console.log(`[Config] Yeni kanal ekleniyor: ${slug} (${chatroomId})`);
        listenChannel({ slug, chatroomId });
      }
    });

    // Artık listede olmayanları kapat
    activeConnections.forEach((ws, id) => {
      if (!currentIds.has(id)) {
        console.log(`[Config] Kanal kaldırıldı, bağlantı sonlandırılıyor: ${id}`);
        ws.terminate();
        activeConnections.delete(id);
      }
    });
  }, (err) => {
    console.error('[Config] İzleme hatası:', err.message);
  });
}

main();
