const express = require('express');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');
const path = require('path');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware أساسية
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// ✅ ما نعملش static للـ uploads عشان الصور تبقى للأدمن فقط
// app.use('/uploads', express.static('uploads'));

// إنشاء مجلد التحميلات إذا لم يكن موجوداً
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// 🔐 إعداد CSRF
const csrfProtection = csrf({
  cookie: {
    key: '_csrf',
    httpOnly: true,
    secure: false, // اجعلها true في production مع HTTPS
    sameSite: 'lax'
  }
});

// 🔹 إعداد multer لرفع الملفات
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'screenshot-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('يجب رفع صورة فقط!'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// 🔹 مسار لجلب الـ CSRF Token
app.get('/api/csrf-token', csrfProtection, (req, res) => {
  const token = req.csrfToken();
  res.cookie('XSRF-TOKEN', token, {
    httpOnly: false,
    secure: false,
    sameSite: 'lax'
  });
  res.json({ csrfToken: token });
});

// Firebase Admin initialization
let firebaseInitialized = false;
if (process.env.FIREBASE_CONFIG) {
  try {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig),
      databaseURL: `https://${firebaseConfig.project_id}.firebaseio.com`
    });
    firebaseInitialized = true;
    console.log('Firebase initialized successfully');
  } catch (error) {
    console.error('Firebase initialization error:', error);
  }
}

// Telegram Bot
let telegramBot = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
}

// ✅ السعر الأساسي لكل منصة
const subscriptions = [
  { id: 1, name: 'نيتفلكس', basePrice: 260 },
  { id: 2, name: 'واتش ات', basePrice: 35 },
  { id: 3, name: 'شاهد', basePrice: 25 }
];

// ✅ كتالوج الباقات (لازم keys تطابق planKey اللي الفرونت بيبعته)
const plansCatalog = {
  1: [ // Netflix
    { key: 'nf_m_basic', name: 'Basic', duration: 'شهري', price: 130 },
    { key: 'nf_m_standard', name: 'Standard', duration: 'شهري', price: 200 },
    { key: 'nf_m_premium', name: 'Premium', duration: 'شهري', price: 265 }
  ],

  2: [ // Watch IT
    { key: 'wi_m_basic', name: 'Basic', duration: 'شهري', price: 40 },
    { key: 'wi_m_plus', name: 'Plus', duration: 'شهري', price: 140 },
    { key: 'wi_y_basic', name: 'Basic', duration: 'سنوي', price: 150 },
    { key: 'wi_y_plus', name: 'Plus', duration: 'سنوي', price: 600 }
  ],

  3: [ // Shahid
    // شهري
    { key: 'sh_m_vip_mobile', name: 'VIP Mobile', duration: 'شهري', price: 65 },
    { key: 'sh_m_vip', name: 'VIP', duration: 'شهري', price: 180 },
    { key: 'sh_m_vip_bigtime', name: 'VIP | BigTime', duration: 'شهري', price: 310 },
    { key: 'sh_m_bip_sports', name: 'VIP | رياضة', duration: 'شهري', price: 360 },
    { key: 'sh_m_Comprehensive', name: 'الشامل', duration: 'شهري', price: 700 },

    // سنوي (مفاتيح مختلفة عن الشهري)
    { key: 'sh_y_vip_mobile', name: 'VIP (Yearly)', duration: 'سنوي', price: 420 },
    { key: 'sh_y_vip', name: 'VIP + Sports (Yearly)', duration: 'سنوي', price: 1750 },
    { key: 'sh_y_vip_bigtime', name: 'VIP + Sports (Yearly)', duration: 'سنوي', price: 3000 },
    { key: 'sh_y_bip_sports', name: 'VIP + Sports (Yearly)', duration: 'سنوي', price: 5000 },
    { key: 'sh_y_Comprehensive', name: 'VIP + Sports (Yearly)', duration: 'سنوي', price: 7400 }
  ]
};

// ✅ helper: يجيب باقة من الكتالوج
function getPlan(subscriptionId, planKey) {
  const list = plansCatalog[String(subscriptionId)] || plansCatalog[Number(subscriptionId)] || [];
  return list.find(p => p.key === planKey) || null;
}

// Middleware للتحقق من JWT (للادمن فقط)
const authenticateToken = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      res.clearCookie('token');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = user;
    next();
  });
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login.html', csrfProtection, (req, res) => {
  res.cookie('XSRF-TOKEN', req.csrfToken(), { httpOnly: false, sameSite: 'lax', secure: false });
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard.html', (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login.html');

  jwt.verify(token, process.env.JWT_SECRET, (err) => {
    if (err) {
      res.clearCookie('token');
      return res.redirect('/login.html');
    }
    next();
  });
}, csrfProtection, (req, res) => {
  res.cookie('XSRF-TOKEN', req.csrfToken(), { httpOnly: false, sameSite: 'lax', secure: false });
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ✅ endpoint يرجّع الباقات للفرونت (لو حبيت تستخدمه)
app.get('/api/plans/:subscriptionId', (req, res) => {
  const { subscriptionId } = req.params;
  const plans = plansCatalog[String(subscriptionId)] || [];
  res.json(plans);
});

// ✅ تسجيل الدخول مع حماية CSRF
app.post('/api/admin/login', csrfProtection, (req, res) => {
  const { username, password } = req.body;

  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '2h' });

    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false
    });

    return res.json({ success: true, message: 'تم تسجيل الدخول بنجاح' });
  }

  res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

// ✅ طلب اشتراك من العميل + رفع صورة
// ✅ المطلوب من الفرونت: subscriptionId + planKey + باقي البيانات
app.post('/api/subscription-order', upload.single('transferScreenshot'), async (req, res) => {
  try {
    const {
      subscriptionId,
      planKey, // ✅ لازم تيجي من الفرونت
      accountName,
      email,
      phone,
      transferNumber
    } = req.body;

    const subscription = subscriptions.find(s => s.id === Number(subscriptionId));
    if (!subscription) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'المنصة غير موجودة' });
    }

    const plan = getPlan(subscriptionId, planKey);
    if (!plan) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'الباقة غير صحيحة أو غير موجودة' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'يجب رفع صورة التحويل' });
    }

    const screenshotPath = '/uploads/' + req.file.filename;

    let orderId = null;

    if (firebaseInitialized) {
      const db = admin.firestore();

      const orderRef = await db.collection('orders').add({
        // platform
        subscriptionId: String(subscriptionId),
        subscriptionName: subscription.name,

        // ✅ السعر الأساسي
        basePrice: subscription.basePrice,

        // ✅ تفاصيل الباقة المختارة
        planKey: plan.key,
        planName: plan.name,         // VIP / Premium ...
        planDuration: plan.duration, // شهري / سنوي
        planPrice: plan.price,       // سعر الباقة المختارة

        // user
        accountName,
        email,
        phone,
        transferNumber,
        transferScreenshot: screenshotPath,

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'pending',
        type: 'customer_order'
      });

      orderId = orderRef.id;
    }

    if (telegramBot) {
      const secureScreenshotUrl =
        `${req.protocol}://${req.get('host')}/api/screenshot/${encodeURIComponent(req.file.filename)}`;

      const msg = `
🎯 طلب اشتراك جديد
━━━━━━━━━━━━━━━━━━━━
📺 المنصة: ${subscription.name}
💵 السعر الأساسي: ${subscription.basePrice} جنيه
📦 الباقة: ${plan.name}
🗓️ المدة: ${plan.duration}
💰 سعر الباقة: ${plan.price} جنيه
👤 اسم الحساب: ${accountName}
📧 البريد: ${email}
📞 الهاتف: ${phone}
🔢 رقم التحويل: ${transferNumber}
🖼️ السكرين: ${secureScreenshotUrl}
🆔 رقم الطلب: ${orderId || 'N/A'}
⏰ الوقت: ${new Date().toLocaleString('ar-EG')}
      `;
      try { await telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg); }
      catch (e) { console.error('Telegram error:', e); }
    }

    res.json({ success: true, message: 'تم استلام طلبك بنجاح', orderId });

  } catch (error) {
    console.error('Order processing error:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء معالجة الطلب' });
  }
});

// ✅ جلب الطلبات للادمن
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    if (!firebaseInitialized) return res.json([]);

    const db = admin.firestore();
    const snap = await db.collection('orders').orderBy('createdAt', 'desc').get();

    const orders = [];
    snap.forEach(doc => {
      const data = doc.data();
      orders.push({
        id: doc.id,
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        updatedAt: data.updatedAt ? data.updatedAt.toDate().toISOString() : null
      });
    });

    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ✅ عرض صورة التحويل (للأدمن فقط)
app.get('/api/screenshot/:filename', authenticateToken, (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);

  if (fs.existsSync(filePath) && filename.startsWith('screenshot-')) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'الصورة غير موجودة' });
  }
});

// ✅ تحديث حالة الطلب
app.put('/api/orders/:id', authenticateToken, csrfProtection, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ['pending', 'completed', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: 'Status not allowed' });
    }

    if (!firebaseInitialized) {
      return res.status(500).json({ error: 'Firebase not initialized' });
    }

    const db = admin.firestore();
    await db.collection('orders').doc(id).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: 'تم تحديث حالة الطلب' });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ success: false, error: 'Failed to update order' });
  }
});

// ✅ تسجيل الخروج
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
