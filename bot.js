const WebSocket = require('ws');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ── Ayarlar ──────────────────────────────────────────────
let activeConnections = new Map(); // chatroomId (string) -> WebSocket

let MY_CHANNEL = 'unknown'; // Yasakların uygulanacağı kendi kanalın
let MY_WHITELIST = []; // Banlanmayacak kişilerin listesi
const bannedUsersCache = new Set(); // RAM Cache: Banlı kullanıcı ID'leri
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
  const tokenDocRef = db.collection('bot_config').doc('tokens');
  
  try {
    const doc = await tokenDocRef.get();
    if (!doc.exists) {
      console.warn('[Kick API] Firestore\'da token dökümanı (bot_config/tokens) bulunamadı!');
      return null;
    }

    const data = doc.data();
    
    // Eğer mevcut access_token geçerliyse (5 dk pay bırak) direkt dön
    if (data.access_token && data.expires_at && Date.now() < data.expires_at - 300000) {
      return data.access_token;
    }

    // Değilse refresh_token ile yenile
    console.log('[Kick API] Access Token süresi dolmuş veya eksik, yenileniyor...');
    
    const clientId = process.env.KICK_CLIENT_ID;
    const clientSecret = process.env.KICK_CLIENT_SECRET;

    if (!clientId || !clientSecret || !data.refresh_token) {
      console.error('[Kick API] Yenileme için gerekli bilgiler (ID, Secret veya Refresh Token) eksik!');
      return null;
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('refresh_token', data.refresh_token);

    const refreshResponse = await axios.post('https://id.kick.com/oauth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const newAccessToken = refreshResponse.data.access_token;
    const newRefreshToken = refreshResponse.data.refresh_token;
    const expiresIn = refreshResponse.data.expires_in; // genelde 7200 saniye (2 saat)

    await tokenDocRef.update({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      expires_at: Date.now() + (expiresIn * 1000)
    });

    console.log('[Kick API] Access Token başarıyla yenilendi ve kaydedildi.');
    return newAccessToken;

  } catch (error) {
    console.error('[Kick API] Token yenileme hatası:', error.response?.data || error.message);
    return null;
  }
}

async function banUserOnKick(userId, username, targetChannel) {
  if (!MY_CHANNEL_ID) {
    if (MY_CHANNEL !== 'unknown') {
      console.log(`[Kick API] ${MY_CHANNEL} için ID aranıyor...`);
      MY_CHANNEL_ID = await getChannelId(MY_CHANNEL);
    }
    if (!MY_CHANNEL_ID) {
      console.warn('[Kick API] Banlanma işlemi iptal: Moderatör kanal ID\'si (MY_CHANNEL_ID) bulunamadı.');
      return;
    }
  }

  // Whitelist kontrolü
  if (MY_WHITELIST.includes(username.toLowerCase())) {
    console.log(`[Kick API] ${username} whitelist'te olduğu için banlanmadı.`);
    return;
  }

  // RAM Cache Kontrolü (Gereksiz okuma kotası harcamayı önler)
  if (bannedUsersCache.has(userId.toString())) {
    return; // Zaten banlı
  }

  // Eğer bellekte yoksa ama veritabanında varsa diye yedek kontrol
  try {
    const bannedDoc = await db.collection('banned_users').where('user_id', '==', userId).get();
    if (!bannedDoc.empty) {
      bannedUsersCache.add(userId.toString()); // Belleğe ekle ki birdaha sormasın
      return; // Zaten banlı
    }
  } catch (err) {
    console.error(`[Kick API] Veritabanı okuma hatası (${username}):`, err.message);
  }

  const token = await getKickAccessToken();
  if (!token) {
    console.error('[Kick API] Geçerli bir access token alınamadığı için ban atılamadı.');
    return;
  }

  try {
    const banBody = {
      broadcaster_user_id: parseInt(MY_CHANNEL_ID),
      user_id: parseInt(userId),
      reason: `Otomatik Ban: ${targetChannel} kanalında görüldü.`
    };

    console.log(`[Kick API] Ban İsteği Gönderiliyor: ${JSON.stringify(banBody)}`);

    const response = await axios.post(
      `https://api.kick.com/public/v1/moderation/bans`,
      banBody,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    console.log(`[Kick API] ${username} başarıyla banlandı! (${targetChannel} kanalında görüldü)`);

    // Başarılı ban bilgisini veritabanına kaydet
    await db.collection('banned_users').add({
      username: username,
      user_id: userId,
      target_channel: targetChannel,
      my_channel: MY_CHANNEL,
      timestamp: FieldValue.serverTimestamp(),
      status: 'success'
    });
    
    // Yeni banlanan kişiyi RAM'deki önbelleğe ekle
    bannedUsersCache.add(userId.toString());

  } catch (error) {
    console.error(`[Kick API] ${username} banlanırken hata:`, error.response?.data || error.message);
  }
}

// ─────────────────────────────────────────────────────────

// Geriye Dönük Banlama Fonksiyonu
async function runRetroBan() {
  try {
    const channelsSnapshot = await db.collection('channels').get();

    for (const channelDoc of channelsSnapshot.docs) {
      const channelId = channelDoc.id;
      // Kendi kanalımıza bakmaya gerek yok
      if (channelId === MY_CHANNEL || channelId === 'unknown') continue;

      console.log(`[Retro Ban] ${channelId} kanalı taranıyor...`);
      let processedCount = 0;
      let lastDoc = null;
      let hasMore = true;

      // Pagination mantığı ile her seferinde 500'er limitli çek (Bellek patlamasını ve aşırı isteği önler)
      while (hasMore) {
        let q = channelDoc.ref.collection('chatters').limit(500);
        if (lastDoc) {
          q = q.startAfter(lastDoc);
        }
        
        const chattersSnapshot = await q.get();
        if (chattersSnapshot.empty) {
          hasMore = false;
          break;
        }

        lastDoc = chattersSnapshot.docs[chattersSnapshot.docs.length - 1];

        for (const doc of chattersSnapshot.docs) {
          const data = doc.data();
          if (data.user_id && data.username && data.username !== 'unknown') {
            await banUserOnKick(data.user_id, data.username, channelId);
            await new Promise(r => setTimeout(r, 600)); // Kick API rate limit koruması
            processedCount++;
          }
        }
      }
      console.log(`[Retro Ban] ${channelId} kanalı tamamlandı. İşlenen kişi: ${processedCount}`);
    }
    console.log('[Retro Ban] Tüm işlemler tamamlandı!');
  } catch (err) {
    console.error('[Retro Ban] Hata:', err.message);
  }
}

// Yardımcı fonksiyon: Objede case-insensitive ve trimli key arama
const findKey = (obj, target) => {
  if (!obj) return null;
  const keys = Object.keys(obj);
  const found = keys.find(k => k.toLowerCase().trim() === target.toLowerCase());
  return found ? obj[found] : null;
};

let messageBuffer = { users: {}, channels: {} };

// Belirli aralıklarla (5 saniyede bir) bellekte biriken mesajları Firebase'e yazar
setInterval(async () => {
  const operations = [];
  let currentBatch = db.batch();
  let opCount = 0;

  for (const channel in messageBuffer.channels) {
    const chCount = messageBuffer.channels[channel];
    if (chCount > 0) {
      const channelRef = db.collection('channels').doc(channel);
      currentBatch.set(channelRef, {
        total_messages: FieldValue.increment(chCount),
        last_activity: FieldValue.serverTimestamp(),
        slug: channel
      }, { merge: true });
      opCount++;
      messageBuffer.channels[channel] = 0; // buffer'ı sıfırla
    }

    if (opCount >= 400) { operations.push(currentBatch.commit()); currentBatch = db.batch(); opCount = 0; }
    
    if (messageBuffer.users[channel]) {
      for (const userId in messageBuffer.users[channel]) {
        const uData = messageBuffer.users[channel][userId];
        if (uData.count > 0) {
          const userRef = db.collection('channels').doc(channel).collection('chatters').doc(userId);
          currentBatch.set(userRef, {
            username: uData.username,
            user_id: userId,
            message_count: FieldValue.increment(uData.count),
            last_seen: FieldValue.serverTimestamp(),
          }, { merge: true });
          opCount++;
          uData.count = 0; // buffer'ı sıfırla
        }

        if (opCount >= 400) { operations.push(currentBatch.commit()); currentBatch = db.batch(); opCount = 0; }
      }
    }
  }

  if (opCount > 0) operations.push(currentBatch.commit());
  
  if (operations.length > 0) {
    try {
      await Promise.all(operations);
    } catch(err) {
      console.error('[Buffer Flush] Hata:', err.message);
    }
  }
}, 5000); // 5 saniye bekleme süresi

async function saveMessage(msg) {
  try {
    // 1. Buffer objelerini (Bellek) oluştur / güncelle
    if (!messageBuffer.channels[msg.channel]) messageBuffer.channels[msg.channel] = 0;
    messageBuffer.channels[msg.channel]++;
    
    if (!messageBuffer.users[msg.channel]) messageBuffer.users[msg.channel] = {};
    if (!messageBuffer.users[msg.channel][msg.user_id]) {
        messageBuffer.users[msg.channel][msg.user_id] = { count: 0, username: msg.username };
    }
    messageBuffer.users[msg.channel][msg.user_id].count++;
    messageBuffer.users[msg.channel][msg.user_id].username = msg.username; // id'ye karşılık gelen ismi güncelle

    // 2. Ban Bot Tetikleyici (Bu işlem veritabanı okumaz, RAM Cache'den bakar ve realtime kalır)
    if (msg.channel !== MY_CHANNEL && msg.username !== 'unknown') {
      await banUserOnKick(msg.user_id, msg.username, msg.channel);
    }

  } catch (error) {
    console.error(`[${msg.channel}] Kullanıcı istatistiği işleme hatası:`, error.message);
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
  
  // Önbelleği yükle: Daha önce banlanmış kişilerin ID'lerini RAM'e al (Gereksiz read faturasını engeller)
  console.log('[Cache] Mevcut yasaklılar belleğe yükleniyor...');
  try {
    const snapshot = await db.collection('banned_users').get();
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.user_id) bannedUsersCache.add(data.user_id.toString());
    });
    console.log(`[Cache] Başarıyla ${bannedUsersCache.size} yasaklı kullanıcı belleğe alındı.`);
  } catch (err) {
    console.error('[Cache] Yükleme hatası:', err.message);
  }

  console.log('[Config] bot_config/channels dökümanı dinleniyor...');
  db.collection('bot_config').doc('channels').onSnapshot((doc) => {
    if (!doc.exists) {
      console.warn('[Config] HATA: bot_config/channels dökümanı bulunamadı!');
      return;
    }

    const data = doc.data();
    
    // Moderatör ayarlarını güncelle
    const modSetting = data.moderator_settings || data.moderator_setting || {};
    
    // Whitelist'i belleğe al
    const whitelist = modSetting.whitelist || [];
    MY_WHITELIST = Array.isArray(whitelist) ? whitelist.map(x => String(x).toLowerCase().trim()) : [];
    
    console.log('[Config] Moderatör Ayarları:', JSON.stringify(modSetting));
    
    if (modSetting.slug && modSetting.slug !== MY_CHANNEL) {
      console.log(`[Config] Moderatör Kanalı Güncellendi: ${modSetting.slug}`);
      MY_CHANNEL = modSetting.slug;
      if (modSetting.id) MY_CHANNEL_ID = modSetting.id;
      else MY_CHANNEL_ID = null; // ID yoksa tekrar aratacak
    } else if (modSetting.id && modSetting.id !== MY_CHANNEL_ID) {
      console.log(`[Config] Moderatör ID Güncellendi: ${modSetting.id}`);
      MY_CHANNEL_ID = modSetting.id;
    }

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

  console.log('[Config] bot_config/commands dökümanı dinleniyor...');
  db.collection('bot_config').doc('commands').onSnapshot(async (doc) => {
    if (!doc.exists) return;
    const data = doc.data();
    if (data.retro_ban === true) {
      console.log('[Commands] Retro Ban komutu alındı!');
      // Komutu sıfırla ki tekrar tekrar çalışmasın
      await doc.ref.update({ retro_ban: false });
      await runRetroBan();
    }
  }, (err) => {
    console.error('[Commands] İzleme hatası:', err.message);
  });
}

main();
