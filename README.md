# PocketMeet 🎥

Küçük, şifreli ve akıcı bir görüntülü toplantı platformu. Her toplantı için
benzersiz bir şifre üretir; o şifreyi bilen herkes katılıp görüntülü konuşabilir,
sohbet edebilir, ekran paylaşabilir, arka planını değiştirebilir ve ses efekti
kullanabilir.

## Özellikler

- 🔐 **Benzersiz şifre** — her toplantı için güçlü, rastgele bir kod
- 👥 **Görüntülü + sesli** — 8 kişiye kadar mesh WebRTC
- 💬 **Sohbet** — uçtan uca şifreli (WebRTC data channel; sunucu mesajları görmez)
- 🖥️ **Ekran paylaşımı**
- 🌆 **Sanal arka plan** — bulanık / ofis / uzay / sahil (MediaPipe)
- 🎭 **Ses değiştirici** — kalın / ince / robot
- ⚙️ **Cihaz seçimi** — kamera/mikrofon değiştirme, sorunlara karşı dayanıklı

Medya ve mesajlar **uçtan uca şifrelidir** (DTLS-SRTP). Sunucu yalnızca
tarafların birbirini bulması için el sıkışma (signaling) mesajlarını iletir —
görüntünü veya sohbetini asla görmez.

## Çalıştırma

Node.js 18+ gerekir.

```bash
cd pocket-meet
npm install
npm start
```

Sonra tarayıcıda **http://localhost:3000** adresini aç.

Test etmek için ikinci bir sekme (veya başka bir cihaz) açıp aynı şifreyle katıl.

## Notlar

- **Kamera/mikrofon** yalnızca `localhost` veya `https://` üzerinde çalışır
  (tarayıcı güvenlik kuralı). Aynı ağdaki başka cihazlardan test için sunucuyu
  HTTPS arkasına koyman gerekir.
- **Farklı ağlar arası** bağlantı için bazı NAT'larda **TURN** sunucusu gerekir.
  Şu an sadece Google STUN kullanılıyor; kurumsal/simetrik NAT'larda görüntü
  gelmezse `app.js` içindeki `ICE` listesine bir TURN sunucusu ekle.
- **Sanal arka plan** MediaPipe kütüphanesini CDN'den yükler (internet gerekir).
  Yüklenemezse özellik sessizce devre dışı kalır, toplantı çalışmaya devam eder.
