require('dotenv').config();
const axios = require('axios');
const admin = require('firebase-admin');

// Firebase Başlatma
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (error) {
  console.error('[Hata] FIREBASE_SERVICE_ACCOUNT bulunamadı veya hatalı.');
  process.exit(1);
}

const db = admin.firestore();

async function getKickAccessToken() {
  try {
    const doc = await db.collection('bot_config').doc('tokens').get();
    if (!doc.exists) return null;
    const data = doc.data();

    if (data.access_token && data.expires_at && Date.now() < data.expires_at - 300000) {
      return data.access_token;
    }

    // Token Yenileme
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', process.env.KICK_CLIENT_ID);
    params.append('client_secret', process.env.KICK_CLIENT_SECRET);
    params.append('refresh_token', data.refresh_token);

    const res = await axios.post('https://id.kick.com/oauth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    await db.collection('bot_config').doc('tokens').update({
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token || data.refresh_token,
      expires_at: Date.now() + (res.data.expires_in * 1000),
      updated_at: Date.now()
    });
    return res.data.access_token;
  } catch (error) {
    console.error('Token yenileme hatası:', error.response?.data || error.message);
    return null;
  }
}

async function startTest() {
  const targetUsername = process.argv[2];
  if (!targetUsername) {
    console.log('Kullanım: node test_ban.js <kullanici_adi>');
    process.exit(1);
  }

  console.log(`\n🔍 ${targetUsername} kullanıcısının ID'si aranıyor...`);
  let targetId;
  try {
    const userRes = await axios.get(`https://kick.com/api/v1/channels/${targetUsername}`);
    targetId = userRes.data.user_id;
    console.log(`✅ ID Bulundu: ${targetId}`);
  } catch (e) {
    console.log('❌ Kullanıcı ID\'si alınamadı. Kullanıcı adı yanlış olabilir.', e.message);
    process.exit(1);
  }

  console.log('🔑 Bot Token\'ı getiriliyor...');
  const token = await getKickAccessToken();
  if (!token) {
    console.log('❌ Firestore\'da (bot_config/tokens) token bulunamadı veya yenilenemedi!');
    process.exit(1);
  }

  // Kendi Moderatör kanal ID'mizi alalım (bot.js'den mantık)
  let MY_CHANNEL_ID;
  try {
    const settingsDoc = await db.collection('bot_config').doc('channels').get();
    if (settingsDoc.exists && settingsDoc.data().moderator_channel) {
       MY_CHANNEL_ID = settingsDoc.data().moderator_channel.id;
    }
  } catch(e) {}

  if (!MY_CHANNEL_ID) {
    console.log('❌ Moderatör kanalının ID\'si Firestore\'da yok (bot_config/channels - moderator_channel.id). Otomatik 26080309 kullanılıyor.');
    MY_CHANNEL_ID = 26080309; 
  }

  console.log(`\n🚨 DİKKAT: ${targetUsername} adlı kullanıcı ${MY_CHANNEL_ID} ID'li kanaldan banlanacak!`);
  
  const banBody = {
    broadcaster_user_id: parseInt(MY_CHANNEL_ID),
    user_id: parseInt(targetId),
    reason: `Test Ban Script ile gönderildi.`
  };
  
  console.log('\nGönderilen İstek Gövdesi:');
  console.log(JSON.stringify(banBody, null, 2));

  try {
    console.log('\n⏳ Ban İsteği Kick API\'ye Gönderiliyor...');
    const res = await axios.post('https://api.kick.com/public/v1/moderation/bans', banBody, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': '*/*'
      }
    });

    console.log('\n🎉 BAŞARILI! Kullanıcı banlandı.');
    console.log('Kick API Yanıtı:', res.data);
  } catch (error) {
    console.log('\n❌ HATA: Kullanıcı banlanamadı (Invalid Request vs.)');
    console.error('Kick Hata Detayı:', error.response?.data || error.message);
    if (error.response?.data?.message === 'Invalid request') {
      console.log('\n💡 Eğer Hata "Invalid request" ise. Bunun sebebi şu olabilir:');
      console.log('1. Banladığın kişi zatan banlı.');
      console.log('2. Banladığın kişi kanalda moderatör.');
      console.log('3. Bu OAuth Tokeni alan yetkili (mfurkanargunsah), banın atıldığı kanalda MODERATÖR veya BROADCASTER (Yayıncı) değil.');
    }
  }
  process.exit(0);
}

startTest();
