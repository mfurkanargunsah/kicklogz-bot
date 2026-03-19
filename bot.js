const WebSocket = require('ws');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ── Ayarlar ──────────────────────────────────────────────
const CHANNELS = [
  { slug: 'ahapulco', chatroomId: 11484792 },
  // { slug: 'diger_kanal', chatroomId: 000000 },
];
// ─────────────────────────────────────────────────────────

// Firebase başlat (Railway env variable'dan okur)
initializeApp({
  credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});

const db = getFirestore();

const KICK_WS_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';

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
  const ws = new WebSocket(KICK_WS_URL);
  let pingInterval;

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

      const msg = {
        channel:  slug,
        user_id:  data.sender?.id?.toString() ?? 'unknown',
        username: data.sender?.username ?? 'unknown',
        content:  data.content ?? '',
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
    console.log(`[${slug}] Bağlantı kapandı (${code}), 5sn sonra yeniden bağlanıyor...`);
    setTimeout(() => listenChannel({ slug, chatroomId }), 5000);
  });

  ws.on('error', (err) => {
    console.error(`[${slug}] WebSocket hatası:`, err.message);
  });
}

async function main() {
  console.log('Bot başlatılıyor...');
  for (const ch of CHANNELS) {
    listenChannel(ch);
  }
}

main();
