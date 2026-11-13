# LatihTOEFL

Web latihan TOEFL iBT 2026 (format baru 21 Jan 2026) dengan AI checker gaya e-rater / SpeechRater — Reading, Listening, Writing, Speaking, drill grammar khas pelajar Indonesia, dan flashcard AWL.

- Live: https://latihtoefl.vercel.app
- Harga: launch Rp59.000 / normal Rp99.000, sekali bayar lifetime
- Login: Firebase Auth (Google) + kode redeem sekali aktivasi (1 kode = 1 akun), progres sync HP–laptop via Firestore

> Catatan: situs saat ini masih Mode Pratinjau — konfigurasi Firebase belum disambungkan. Setelah firebaseConfig asli diisi, redeploy dari repo ini.

Deploy: static, tanpa build command. Sumber halaman adalah export artifact `toefl-practice-web` (LatihTOEFL).
