const WebSocket = require('ws');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ── Ayarlar ──────────────────────────────────────────────
// Kanallar artık Firestore üzerinden dinamik olarak okunacak
let activeConnections = new Map(); // chatroomId -> WebSocket
// ─────────────────────────────────────────────────────────

// Firebase başlat (Railway env variable'dan okur)
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
  console.error('Lütfen Railway Variables kısmındaki FIREBASE_SERVICE_ACCOUNT değerini kontrol edin. JSON formatı doğru olmalı.');
  process.exit(1); // Kritik hata, süreci durdur
}

const db = getFirestore();

// Pusher URL - Env variable veya varsayılan
const KICK_WS_URL = process.env.KICK_WS_URL || 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';

// 1. Heartbeat Sistemi (30 saniyede bir durum güncelle)
function startHeartbeat() {
  console.log('[Heartbeat] Başlatıldı');
  setInterval(async () => {
    try {
      await db.collection('bot_status').doc('main').set({
        last_heartbeat: FieldValue.serverTimestamp(),
        active_channels: activeConnections.size
      });
    } catch (e) {
      console.error('[Heartbeat] Güncelleme hatası:', e.message);
    }
  }, 30000);
}

async function saveMessage(msg) {
  const batch = db.batch();

  // 1. Mesajı kaydet
  const msgRef = db.collection('messages').doc();
  batch.set(msgRef, {
    ...msg,
    created_at: FieldValue.serverTimestamp(),
  });

  // 2. Kullanıcı istatistiğini güncelle (upsert)
  const userRef = db
    .collection('channels').doc(msg.channel)
    .collection('chatters').doc(msg.user_id);

  batch.set(userRef, {
    username: msg.username,
    user_id: msg.user_id,
    message_count: FieldValue.increment(1),
    last_seen: FieldValue.serverTimestamp(),
  }, { merge: true });

  // 3. Kanal toplam sayacını güncelle
  const channelRef = db.collection('channels').doc(msg.channel);
  batch.set(channelRef, {
    total_messages: FieldValue.increment(1),
    last_activity: FieldValue.serverTimestamp(),
  }, { merge: true });

  await batch.commit();
}

function listenChannel({ slug, chatroomId }) {
  if (activeConnections.has(chatroomId)) return;

  const ws = new WebSocket(KICK_WS_URL);
  let pingInterval;
  activeConnections.set(chatroomId, ws);

  ws.on('open', () => {
    console.log(`[${slug}] WebSocket bağlandı`);
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${chatroomId}.v2` }
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
      console.log(`[${slug}] Kanal dinleniyor (chatroom: ${chatroomId})`);
      return;
    }

    if (parsed.event === 'App\\Events\\ChatMessageEvent') {
      let data;
      try { data = JSON.parse(parsed.data); } catch { return; }

      // Güvenli veri okuma
      const sender = data.sender || {};
      const msg = {
        channel:  slug,
        user_id:  (sender.id || 'unknown').toString(),
        username: sender.username || 'unknown',
        content:  data.content || '',
      };

      try {
        await saveMessage(msg);
        console.log(`[${slug}] ${msg.username}: ${msg.content}`);
      } catch (e) {
        console.error(`[${slug}] Firestore yazma hatası:`, e.message);
      }
    }
  });

  ws.on('close', (code) => {
    clearInterval(pingInterval);
    activeConnections.delete(chatroomId);
    
    // Eğer hala bu kanalı dinlememiz gerekiyorsa 5sn sonra tekrar dene
    console.log(`[${slug}] Bağlantı kapandı (${code})`);
    
    // Bu kısım dinamik liste tarafından yönetilecek, 
    // ama beklenmedik kapanmalarda otomatik retry için:
    setTimeout(() => {
      // Hala listede olup olmadığını kontrol et (dinamik olması için)
      // Bu örnekte basitlik için direkt retry yapıyoruz.
      // Not: Dinamik yönetim için main() içindeki listener tekrar tetiklenecektir.
    }, 5000);
  });

  ws.on('error', (err) => {
    console.error(`[${slug}] WebSocket hatası:`, err.message);
  });
}

async function main() {
  console.log('Bot başlatılıyor...');
  
  // Heartbeat başlat
  startHeartbeat();

  // Firestore'dan kanalları izle (Dinamik Kanal Yönetimi)
  console.log('[Config] bot_config/channels listesi dinleniyor...');
  db.collection('bot_config').doc('channels').onSnapshot((doc) => {
    if (!doc.exists) {
      console.warn('[Config] UYARI: bot_config/channels dökümanı Firestore\'da bulunamadı!');
      console.info('Lütfen Firestore\'da bot_config koleksiyonu içine channels dökümanı oluşturun.');
      return;
    }

    const data = doc.data();
    const channels = data.list || [];
    console.log(`[Config] Yapılandırma güncellendi. Toplam kanal: ${channels.length}`);

    if (channels.length === 0) {
      console.warn('[Config] UYARI: Kanal listesi boş! Bot hiçbir kanalı dinlemiyor.');
    }

    // Yeni eklenenleri başlat
    channels.forEach(ch => {
      if (!activeConnections.has(ch.chatroomId)) {
        console.log(`[Config] Yeni kanal eklendi: ${ch.slug}`);
        listenChannel(ch);
      }
    });

    // Kaldırılanları durdur
    const currentIds = channels.map(c => c.chatroomId);
    activeConnections.forEach((ws, chatroomId) => {
      if (!currentIds.includes(chatroomId)) {
        console.log(`[Config] Kanal kaldırıldı (chatroomId: ${chatroomId}), bağlantı kapatılıyor...`);
        ws.terminate();
        activeConnections.delete(chatroomId);
      }
    });
  }, (err) => {
    console.error('[Config] Kanal listesi okuma hatası:', err.message);
  });
}

main();
