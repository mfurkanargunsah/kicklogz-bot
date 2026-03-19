# KickStats — Firebase + Railway Kurulum

## Klasör Yapısı
```
kicklogz-firebase/
├── bot.js              ← Railway'e deploy edilecek
├── package.json
├── public/
│   └── index.html      ← Firebase Hosting'e deploy edilecek
├── firebase.json
├── firestore.rules
└── .gitignore
```

---

## ADIM 1 — Firebase Projesi Kur

1. https://console.firebase.google.com → "Proje Oluştur"
2. Proje adı ver (örn: kicklogz)
3. Sol menü → **Firestore Database** → "Veritabanı Oluştur" → Production mode
4. Bölge: **eur3 (europe-west)** seç

---

## ADIM 2 — Service Account (Bot için)

1. Firebase Console → Proje Ayarları (dişli) → **Hizmet Hesapları**
2. "Yeni Özel Anahtar Oluştur" → JSON dosyasını indir
3. JSON dosyasının tüm içeriğini kopyala → Railway'e env variable olarak ekleyeceksin

---

## ADIM 3 — Web Config (index.html için)

1. Firebase Console → Proje Ayarları → **Genel** sekmesi
2. Aşağı in → "Uygulamalarınız" → Web uygulaması ekle (</>)
3. Çıkan firebaseConfig objesini `public/index.html` içindeki ilgili yere yapıştır

---

## ADIM 4 — Firebase Hosting Deploy

Bilgisayarında bir kez çalıştır:

```bash
npm install -g firebase-tools
firebase login
firebase init hosting   # mevcut projeyi seç, public klasörü kullan
firebase deploy --only hosting,firestore:rules
```

Site URL'in: https://PROJE_ID.web.app

---

## ADIM 5 — Railway Deploy (Bot)

1. https://railway.app → GitHub ile giriş
2. "New Project" → "Deploy from GitHub repo"
3. Bu klasörü GitHub'a push et
4. Railway'de projeyi seç
5. **Variables** sekmesine git → şunu ekle:
   ```
   FIREBASE_SERVICE_ACCOUNT = {"type":"service_account","project_id":...}   ← 2. adımdaki JSON
   ```
6. Deploy otomatik başlar

---

## ADIM 6 — Dinamik Kanal Yönetimi (Yeni!)

Artık botu yeniden başlatmadan kanal ekleyip çıkarabilirsin:
1. Firebase Console → **Firestore Database**
2. `bot_config` adında bir koleksiyon oluştur.
3. `channels` adında bir döküman oluştur.
4. `list` adında bir **Array** alanı ekle.
5. İçine **Map** tipinde kanallar ekle:
   - `slug`: "kanal_adi" (String)
   - `chatroomId`: 123456 (Number)

Bot bu listeyi anlık olarak izler ve değişiklikleri otomatik uygular.

---

## Bot Durum Takibi

Frontend (index.html), botun gönderdiği "heartbeat" sinyallerini izler:
- Bot her 30 saniyede bir `bot_status/main` dökümanını günceller.
- Eğer sinyal 60 saniyeden eskiyse, arayüzde **BOT OFFLINE** uyarısı çıkar.
- Bot online ise kaç kanalı dinlediği bilgisi görünür.

## Firestore Veri Yapısı

```
channels/
  ahapulco/
    total_messages: 1234
    last_activity: timestamp
    chatters/
      user_id_1/
        username: "furko"
        message_count: 42
        last_seen: timestamp
messages/
  {auto_id}/
    channel: "ahapulco"
    username: "furko"
    content: "merhaba"
    created_at: timestamp
```
