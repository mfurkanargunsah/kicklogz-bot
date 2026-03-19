const WebSocket = require('ws');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ── Ayarlar ──────────────────────────────────────────────
let activeConnections = new Map(); // chatroomId (string) -> WebSocket
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
        version: '1.0.1'
      });
      // console.log(`[Heartbeat] Güncellendi (${activeConnections.size} kanal)`);
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
  } catch (error) {
    console.error(`[${msg.channel}] Mesaj kaydetme hatası:`, error.message);
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
      // console.log(`[${slug}] ${msg.username}: ${msg.content}`);
    }
  });

  ws.on('close', (code) => {
    clearInterval(pingInterval);
    activeConnections.delete(idStr);
    console.log(`[${slug}] Bağlantı kapandı (Kod: ${code}). 5sn içinde tekrar denenecek.`);
    setTimeout(() => {
      // Yeniden bağlanma mantığı Snapshot listener tarafından tetiklenecektir
    }, 5000);
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
